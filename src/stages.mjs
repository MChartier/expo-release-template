/** @file Canonical stage readiness, durable handoff, and bounded provider observation shared by hosted workers and recovery. */
import { invariant, hashIdentity, summarizeRelease } from '../packages/release-engine/index.mjs';
import { executeOperation, latestOperation } from './operations.mjs';

/** Read the immutable prepared plan and require every graph dependency before executing or observing a stage. */
export async function stageContext(ledger, releaseId, target, action) {
  const state = await ledger.read(releaseId);
  invariant(state.plan?.prepared, 'Stage execution requires a prepared common plan.');
  invariant(state.release.draft, 'A finalized release cannot be executed again.');
  const stage = `${target}:${action}`;
  const spec = state.plan.stages[stage];
  const component = state.plan.components.find(value => value.id === target && value.selected);
  invariant(spec?.target === target && spec.action === action && component, 'The requested stage is not selected by this plan.');
  const receipts = state.events.filter(event => state.plan.stages[event.stage]);
  const summary = summarizeRelease(state.plan.graph, receipts);
  const graphStage = state.plan.graph.stages.find(value => value.id === stage);
  invariant(graphStage.needs.every(id => !summary.remaining.includes(id)), `Stage ${stage} is waiting for ${graphStage.needs.filter(id => summary.remaining.includes(id)).join(', ')}.`);
  return { state, plan: state.plan, component, stage, receipts, summary,
    complete: !summary.remaining.includes(stage), operation: latestOperation(state.events, stage) };
}

/** Record a verified local phase once; a different artifact or proof never replaces an earlier completed stage. */
export async function completeStage({ ledger, releaseId, target, action, receipt }) {
  const context = await stageContext(ledger, releaseId, target, action);
  invariant(receipt && typeof receipt === 'object' && Object.keys(receipt).length, 'Stage completion requires concrete evidence.');
  if (context.complete) {
    const previous = context.receipts.findLast(event => event.stage === context.stage);
    invariant(hashIdentity(previous.receipt) === hashIdentity(receipt), 'Cannot replace successful stage evidence.');
    return previous;
  }
  await ledger.append(releaseId, { stage: context.stage, status: 'complete', receipt });
  return { stage: context.stage, status: 'complete', receipt };
}

/** Observe provider state until completion or a bounded timeout; only explicit retry can restart a failed operation. */
export async function runProviderStage({ ledger, releaseId, target, action, provider, request = {}, retry = false,
  handoff = false, binding, wait = true, timeoutMs = 45 * 60 * 1000, intervalMs = 15000,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now }) {
  const context = await stageContext(ledger, releaseId, target, handoff ? 'handoff' : action);
  if (context.complete && handoff) return context.receipts.findLast(event => event.stage === context.stage);
  const canonicalStage = `${target}:${action}`;
  invariant(!binding || action === 'publish' && context.component.kind === 'ota' && /^[a-f0-9]{64}$/.test(binding.key)
    && binding.target === target && binding.planDigest === context.plan.digest, 'Invalid OTA publication binding.');
  const stage = binding ? `${canonicalStage}:runtime-${binding.key}` : canonicalStage;
  // Submission acceptance is observed before its handoff dependency is complete. Only this fixed transition may do so.
  invariant(!handoff || action === 'submit', 'Only verified store submission may complete a native handoff.');
  invariant(context.plan.stages[canonicalStage], 'Provider action is not selected.');
  const durable = { schemaVersion: 1, planDigest: context.plan.digest, target, source: context.plan.source.commit,
    ...(binding ? { binding: binding.key, runtime: binding.runtime } : {}), ...request };
  invariant(!Object.keys(durable).some(key => /token|password|secret|authorization|privatekey|environment|sourceproof/i.test(key)), 'Credentials and capabilities do not belong in the release journal.');
  const started = now();
  let first = true;
  for (;;) {
    const operation = await executeOperation({ ledger, releaseId, stage, provider, context: durable, retry: first && retry });
    first = false;
    if (handoff && ['accepted', 'complete'].includes(operation.status)) {
      // executeOperation verifies the exact provider association/destination before returning acceptance.
      const evidence = { operationId: operation.operationId, request: durable, provider: operation.proof ?? operation.receipt };
      await completeStage({ ledger, releaseId, target, action: 'handoff', receipt: evidence });
      return operation;
    }
    invariant(operation.status !== 'failed', `Provider ${stage} failed; use explicit recovery after fresh verification.`);
    invariant(operation.status !== 'unknown', `Provider ${stage} has an ambiguous outcome; reconcile it before continuing.`);
    if (operation.status === 'complete' || !wait) return operation;
    invariant(now() - started < timeoutMs, `Provider ${stage} remains pending. Its exact ID is retained; resume observation without enqueueing again.`);
    await sleep(Math.min(intervalMs, timeoutMs - (now() - started)));
  }
}

/** Read-only recovery status uses the same stage model as execution and preserves already successful independent stages. */
export function recoveryStatus(state) {
  const receipts = state.events.filter(event => state.plan.stages[event.stage]);
  const summary = summarizeRelease(state.plan.graph, receipts);
  return { schemaVersion: 1, kind: 'expo-release-status', releaseId: String(state.release.id),
    source: state.plan.source, origin: state.plan.origin, planDigest: state.plan.digest, summary,
    operations: Object.fromEntries(summary.remaining.map(stage => [stage, latestOperation(state.events, stage)])),
    inventory: state.events.filter(event => event.type === 'artifact').map(event => ({ target: event.target, receipt: event.receiptAsset, files: event.files })) };
}
