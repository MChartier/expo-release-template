/** @file Splits EAS cloud enqueue from source-free ledger observation and exact artifact retention; interrupted intents never authorize another build. */
import fs from 'node:fs';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hashIdentity, invariant, reduceOperation, verifyPlan } from '../packages/release-engine/index.mjs';
import { createEasStage } from './eas-stages.mjs';
import { createEasBuildProvider } from './providers/eas.mjs';
import { createEasPublisherWorkspace } from './providers/eas-workspace.mjs';
import { executeOperation, latestOperation } from './operations.mjs';
import { stageContext } from './stages.mjs';
import { sealBuild, verifyBuildSource } from './build.mjs';
import { repositoryPath } from './config.mjs';
import { sourceEnvironment } from './hooks.mjs';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
function selected(plan, target) {
  verifyPlan(plan);
  const component = plan.components.find(value => value.id === target && value.selected);
  invariant(plan.prepared && plan.origin.kind === 'github' && component?.kind === 'native' && component.builder === 'eas', 'Cloud build requires a prepared hosted EAS target.');
  invariant(component.observation.expoConfig && plan.providerConfiguration?.expo, 'Cloud build requires public Expo configuration retained by source-only inspection.');
  return component;
}
function matchingLease(lease, plan, target, origin) {
  invariant(lease?.schemaVersion === 1 && lease.kind === 'expo-cloud-build-lease' && uuid.test(lease.id)
    && lease.planDigest === plan.digest && lease.source === plan.source.commit && lease.target === target
    && lease.stage === `${target}:build-provider` && origin?.kind === 'github'
    && hashIdentity(lease.origin) === hashIdentity(origin), 'Cloud enqueue lease differs from this plan or producing run attempt.');
}

/** Persist a fresh intent in a source-free job. Existing intent/ID returns observe without granting a replacement enqueue lease. */
export async function beginCloudBuild({ ledger, releaseId, target, origin, retry = false, transport, providerEnvironment = process.env }) {
  const { plan, state } = await stageContext(ledger, releaseId, target, 'build');
  const stage = `${target}:build-provider`; const operation = latestOperation(state.events, stage);
  selected(plan, target);
  invariant(origin?.kind === 'github' && /^[1-9]\d*$/.test(String(origin.runId)) && Number.isSafeInteger(origin.runAttempt) && origin.runAttempt > 0, 'Cloud intent needs its exact hosted producer.');
  if (operation && !retry) return { mode: 'observe', operation };
  let failed;
  if (operation) {
    invariant(operation.status === 'failed' && operation.operationId, 'Only an exact definitively failed EAS build may receive a replacement lease.');
    const component = selected(plan, target);
    const composed = await createEasStage({ action: 'build', plan, component, transport: {} });
    const workspace = createEasPublisherWorkspace({ ...composed.spec, expoConfig: component.observation.expoConfig }, { env: providerEnvironment });
    try {
      const provider = createEasBuildProvider(composed.spec, transport ?? workspace.transport);
      const observed = await provider.status(operation.operationId);
      invariant(observed.status === 'failed' && ['ERRORED', 'CANCELED'].includes(observed.raw.status)
        && !observed.raw.artifacts?.applicationArchiveUrl && !observed.raw.artifacts?.buildUrl,
      'Replacement build requires fresh terminal failure without a produced application artifact.');
      const proof = await provider.verify(observed, { observe: true });
      failed = reduceOperation(operation, { type: 'failed', definitive: true, reason: 'Fresh EAS readback confirmed a failed build without application output.', proof });
    } finally { workspace.dispose(); }
  }
  const lease = { schemaVersion: 1, kind: 'expo-cloud-build-lease', id: randomUUID(), planDigest: plan.digest,
    source: plan.source.commit, target, stage, origin };
  const next = failed ? { ...reduceOperation(failed, { type: 'retry', proof: failed.proof }), request: lease }
    : reduceOperation(null, { type: 'intent', operationKey: stage, request: lease });
  await ledger.append(releaseId, { stage, status: next.status, operation: next });
  return { mode: 'enqueue', lease };
}

/**
 * Consume one trusted fresh lease in the credentialed source job. A local exclusive claim prevents replay;
 * the raw accepted ID is flushed to handoffFile before any provider readback. The worker must retain this
 * file even on later job failure and independently verify the lease's original producing job.
 */
export async function enqueueCloudBuild({ plan, target, root, inputs, lease, origin, handoffFile, transport, providerEnvironment = process.env }) {
  selected(plan, target); matchingLease(lease, plan, target, origin);
  verifyBuildSource(plan, target, root);
  invariant(typeof handoffFile === 'string' && path.isAbsolute(handoffFile), 'Cloud handoff requires an absolute output file.');
  fs.mkdirSync(path.dirname(handoffFile), { recursive: true });
  fs.writeFileSync(`${handoffFile}.intent`, JSON.stringify(lease), { flag: 'wx', mode: 0o600, flush: true });
  const stage = await createEasStage({ action: 'build', plan, component: target, root, environment: inputs, transport, providerEnvironment });
  try {
    await stage.preflight();
    const accepted = await stage.provider.start();
    invariant(uuid.test(accepted.id), 'EAS returned an invalid build ID; reconcile the durable intent.');
    const handoff = { schemaVersion: 1, kind: 'expo-cloud-build-accepted', lease, id: accepted.id };
    fs.writeFileSync(handoffFile, `${JSON.stringify(handoff)}\n`, { flag: 'wx', mode: 0o600, flush: true });
    return handoff;
  } finally { stage.dispose(); }
}

async function downloadArtifact(url, destination, digest, fetcher) {
  invariant(typeof url === 'string' && new URL(url).protocol === 'https:', 'EAS artifact requires an ephemeral HTTPS location.');
  if (fs.existsSync(destination)) {
    invariant(createHash('sha256').update(fs.readFileSync(destination)).digest('hex') === digest, 'Existing cloud artifact bytes differ.');
    return;
  }
  const response = await fetcher(url, { signal: AbortSignal.timeout(300000) });
  invariant(response.ok && response.body, 'EAS artifact download failed.');
  const temporary = `${destination}.${randomUUID()}.partial`;
  const handle = await open(temporary, 'wx', 0o600);
  const hash = createHash('sha256'); let size = 0;
  try {
    for await (const chunk of response.body) { hash.update(chunk); size += chunk.length; await handle.writeFile(chunk); }
    invariant(size > 0 && hash.digest('hex') === digest, 'Downloaded EAS artifact bytes differ from provider proof.');
    await handle.sync(); await handle.close();
    fs.renameSync(temporary, destination);
  } finally { await handle.close().catch(() => {}); fs.rmSync(temporary, { force: true }); }
}

/**
 * Observe a previously intended cloud build without a source checkout or enqueue capability, then seal its
 * exact APK/AAB/IPA. The caller verifies accepted-handoff provenance and retains/attests the returned receipt.
 * Pending timeout, lost handoff, failed download, and interrupted retention all resume the same provider ID.
 */
export async function monitorCloudBuild({ ledger, releaseId, target, accepted, inputs, outputRoot, origin,
  workflowCommit, toolkitCommit, transport, providerEnvironment = process.env, fetch: fetcher = fetch,
  timeoutMs = 45 * 60 * 1000, intervalMs = 15000, sleep = ms => new Promise(done => setTimeout(done, ms)), now = Date.now }) {
  const context = await stageContext(ledger, releaseId, target, 'build');
  const { plan } = context; const component = selected(plan, target);
  const stage = `${target}:build-provider`; const original = latestOperation(context.state.events, stage);
  invariant(original, 'Cloud observation requires a durable enqueue intent.');
  const lease = original.request;
  matchingLease(lease, plan, target, lease?.origin);
  const composed = await createEasStage({ action: 'build', plan, component: target, environment: inputs, transport: {} });
  const workspace = createEasPublisherWorkspace({ ...composed.spec, expoConfig: component.observation.expoConfig },
    { env: { ...sourceEnvironment(providerEnvironment), ...(providerEnvironment.EXPO_TOKEN ? { EXPO_TOKEN: providerEnvironment.EXPO_TOKEN } : {}) } });
  try {
    const connection = transport || workspace.transport;
    const buildProvider = createEasBuildProvider(composed.spec, connection);
    const provider = { ...buildProvider,
      /** Monitoring cannot enqueue even if its ledger has unexpectedly lost the durable intent. */
      async start() { throw new Error('Cloud observer cannot enqueue a build.'); } };
    let operation = original;
    if (accepted) {
      invariant(accepted.schemaVersion === 1 && accepted.kind === 'expo-cloud-build-accepted' && uuid.test(accepted.id)
        && hashIdentity(accepted.lease) === hashIdentity(lease), 'Cloud accepted handoff differs from its durable intent.');
      invariant(!operation.operationId || operation.operationId === accepted.id, 'Cloud accepted ID changed.');
      if (!operation.operationId) {
        const observed = await provider.status(accepted.id);
        const proof = await provider.verify(observed, { observe: true });
        operation = reduceOperation(operation, { type: 'accepted', operationId: accepted.id, proof });
        await ledger.append(releaseId, { stage, status: operation.status, operation });
      }
    }
    const started = now();
    for (;;) {
      operation = await executeOperation({ ledger, releaseId, stage, provider, context: lease });
      if (operation.status === 'complete') break;
      invariant(operation.status === 'accepted', `Cloud build is ${operation.status}; reconcile its retained operation before continuing.`);
      invariant(now() - started < timeoutMs, 'Cloud build remains pending; resume its retained ID without enqueueing.');
      await sleep(Math.min(intervalMs, timeoutMs - (now() - started)));
    }
    const native = operation.receipt;
    invariant(native?.kind === 'native-build' && native.id === operation.operationId, 'Cloud completion lacks exact native build evidence.');
    // Refresh immutable identity and state before using a new temporary provider download location.
    const observed = await provider.status(native.id);
    invariant(observed.status === 'complete', 'Completed cloud build is no longer available.');
    const directory = repositoryPath(outputRoot, `${target}/files`); fs.mkdirSync(directory, { recursive: true });
    const extension = component.platform === 'ios' ? 'ipa' : component.distribution === 'internal' ? 'apk' : 'aab';
    await downloadArtifact(observed.raw.artifacts?.applicationArchiveUrl || observed.raw.artifacts?.buildUrl,
      path.join(directory, `app.${extension}`), native.artifact.sha256, fetcher);
    const artifacts = await sealBuild({ plan, component, artifacts: [{ directory, native, nativeOrigin: lease.origin, expoConfig: component.observation.expoConfig }],
      outputRoot, inputs, origin, workflowCommit, toolkitCommit });
    return { operation, artifacts };
  } finally { workspace.dispose(); }
}
