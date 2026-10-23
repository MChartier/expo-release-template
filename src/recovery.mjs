/** @file Audited recovery of immutable release plans; observations never enqueue and successful independent stages remain unchanged. */
import { hashIdentity, invariant, reduceOperation } from '../packages/release-engine/index.mjs';
import { latestOperation } from './operations.mjs';
import { recoveryStatus } from './stages.mjs';
import { abandonCandidate } from './candidate.mjs';

const active = new Set(['intent', 'accepted', 'unknown']);
const actions = new Set(['resume', 'retry', 'reconcile', 'abandon', 'complete']);

/** Inspect the original plan and all provider suboperations, including cloud builds and individual OTA runtimes. */
export async function inspectRecovery({ ledger, releaseId }) {
  const state = await ledger.read(releaseId);
  const status = recoveryStatus(state);
  return { ...status, plan: state.plan,
    operations: Object.fromEntries([...new Set(state.events.filter(event => event.operation).map(event => event.stage))]
      .map(stage => [stage, latestOperation(state.events, stage)])) };
}

/** Authorize an explicit recovery against the frozen plan; trusted workers execute returned stages using their own producer identity. */
export async function recoverRelease({ ledger, releaseId, request, providerForStage }) {
  invariant(request && actions.has(request.action), 'Choose resume, retry, reconcile, abandon or complete recovery.');
  const state = await ledger.read(releaseId);
  invariant(state.release.draft && !state.resolved, 'Recovery requires an unresolved draft.');
  const digest = state.plan.digest;
  invariant(!request.planDigest || request.planDigest === digest, 'Recovery plan digest differs.');
  const status = recoveryStatus(state);
  const all = Object.fromEntries([...new Set(state.events.filter(event => event.operation).map(event => event.stage))]
    .map(stage => [stage, latestOperation(state.events, stage)]));
  const stage = request.stage;
  const operation = stage && all[stage];
  if (request.action === 'reconcile') {
    invariant(stage && operation && operation.status !== 'complete' && providerForStage, 'Reconcile an existing unresolved provider operation.');
    const provider = await providerForStage({ state, stage, operation });
    const context = { ...operation.request, operationKey: operation.operationKey, attempt: operation.attempt };
    invariant(context?.planDigest === state.plan.digest, 'Provider operation belongs to another prepared plan.');
    let next = operation;
    if (next.status === 'intent') next = reduceOperation(next, { type: 'unknown', reason: 'Interrupted request requires provider observation.' });
    invariant(['health', 'absence', 'destination'].filter(key => request[key] !== undefined).length <= 1, 'Choose exactly one reconciliation evidence type.');
    if (request.destination !== undefined) {
      invariant(provider.reconcileDestination && next.operationId, 'This provider cannot correct a destination without a retained provider ID.');
      const proof = await provider.reconcileDestination(request.destination, context);
      next = reduceOperation(next, { type: 'failed', definitive: true, reason: 'Rejected destination correction requires a separate explicit retry.', proof });
    } else if (request.health !== undefined) {
      invariant(provider.reconcile && ['intent', 'unknown', 'accepted'].includes(next.status), 'This provider cannot reconcile health evidence.');
      const proof = await provider.reconcile(request.health, context);
      next = reduceOperation(next, { type: 'complete', receipt: proof, proof });
    } else if (request.absence !== undefined) {
      invariant(!next.operationId && provider.verifyAbsence, 'Known IDs cannot be reconciled as absent.');
      const proof = await provider.verifyAbsence(request.absence, context);
      next = reduceOperation(next, { type: 'reconciled-absent', proof });
    } else {
      invariant(!request.operationId || !next.operationId || request.operationId === next.operationId, 'Recovery cannot replace a retained provider ID.');
      const id = next.operationId || request.operationId;
      const observed = id ? await provider.status(id, context) : await provider.find(context);
      invariant(observed && (!id || observed.id === id), 'No exact provider observation; an empty search is not proof of absence.');
      const proof = await provider.verify(observed, { ...context, observe: true });
      invariant(proof && typeof proof === 'object' && Object.keys(proof).length, 'Recovery requires concrete provider evidence.');
      // A formerly failed operation cannot silently change state; retry will reverify its exact ID.
      if (next.status === 'failed') invariant(observed.status === 'failed', 'A terminal provider observation conflicts with the retained failure.');
      else if (next.status === 'unknown' && observed.id) next = reduceOperation(next, { type: 'accepted', operationId: observed.id, proof });
      if (observed.status === 'complete') next = reduceOperation(next, { type: 'complete', receipt: proof, proof });
      else if (observed.status === 'failed') next = reduceOperation(next, { type: 'failed', definitive: true, reason: 'Fresh provider readback confirmed terminal failure.', proof });
      else if (observed.status === 'accepted') next = reduceOperation(next, { type: 'observed', proof });
      else { invariant(observed.status === 'unknown', 'Unsupported provider recovery observation.'); next = reduceOperation(next, { type: 'unknown', reason: 'Provider outcome remains ambiguous.' }); }
    }
    await ledger.append(releaseId, { type: 'recovery', action: 'reconcile', stage, status: next.status, operation: next });
    return inspectRecovery({ ledger, releaseId });
  }
  if (request.action === 'abandon') {
    invariant(typeof request.reason === 'string' && request.reason.trim().length >= 20, 'Abandonment needs a specific reason of at least 20 characters.');
    invariant(Object.values(all).every(value => !active.has(value.status)), 'Reconcile every provider suboperation before abandoning the release.');
    if (!state.plan.prepared) await abandonCandidate({ api: ledger.api, ledger, state });
    await ledger.append(releaseId, { type: 'recovery', action: 'abandon', reason: request.reason });
    await ledger.finish(releaseId, { abandon: true });
    return inspectRecovery({ ledger, releaseId });
  }
  if (request.action === 'complete') {
    invariant(['complete', 'noop'].includes(status.summary.status) && Object.values(all).every(value => !active.has(value.status)), 'Completion requires every selected stage and provider suboperation.');
    await ledger.finish(releaseId);
    return inspectRecovery({ ledger, releaseId });
  }
  if (request.action === 'retry') invariant(operation?.status === 'failed' || operation?.status === 'unknown', 'Retry requires a specific failed or ambiguous provider operation.');
  if (stage) invariant(state.plan.stages[stage] || operation, 'Recovery stage is not part of the original plan.');
  await ledger.append(releaseId, { type: 'recovery', action: request.action, ...(stage ? { requestedStage: stage } : {}),
    authorization: { planDigest: digest, originalSource: state.plan.source, originalOrigin: state.plan.origin } });
  return { schemaVersion: 1, kind: 'expo-release-recovery', releaseId: String(releaseId), action: request.action,
    plan: state.plan, planDigest: digest, stages: status.summary.remaining,
    ...(stage ? { stage } : {}), retry: request.action === 'retry', prepared: state.plan.prepared === true };
}
