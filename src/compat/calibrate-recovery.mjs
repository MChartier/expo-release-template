/** @file Original paired-native recovery verifies retained attestations and appends transitions without rewriting the held release. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { hashIdentity, invariant, reduceOperation } from '../../packages/release-engine/index.mjs';
import { verifyHistoricalArtifact } from '../artifacts.mjs';
import { verifyHistoricalAttestation } from '../attestation.mjs';
import { repositoryJson } from '../trusted.mjs';
import { createEasPublisherWorkspace } from '../providers/eas-workspace.mjs';
import { createEasSubmissionProvider, verifyEasSubmission } from '../providers/eas.mjs';
import { sourceEnvironment } from '../hooks.mjs';
import { executeOperation, latestOperation } from '../operations.mjs';
import { appendCalibrateRecovery } from './calibrate.mjs';
import { configuredComponents } from '../planner.mjs';
import { continueOriginalOta } from './calibrate-retained-ota.mjs';
import { createDeploymentProvider } from '../providers/deploy.mjs';

const paths = { 'phone-apk': 'mobile/android/app/build/outputs/apk/release/app-release.apk',
  'phone-aab': 'mobile/android/app/build/outputs/bundle/release/app-release.aab',
  'wear-apk': 'wear/app/build/outputs/apk/release/app-release.apk', 'wear-aab': 'wear/app/build/outputs/bundle/release/app-release.aab' };
const criticalFiles = ['.github/workflows/native-build.yml', 'scripts/native-release-artifacts.mjs',
  'scripts/native-release-build.mjs', 'scripts/native-release-evidence.mjs', 'scripts/native-play-release.mjs',
  'scripts/expo-runtime.mjs', 'scripts/release-config.mjs', 'scripts/zip-entry.mjs', 'scripts/release-selection.mjs', 'mobile/fingerprint.config.js'];

/** Restore one attested original AAB; source, signer and bytes keep their original identities. */
export async function restoreCalibrateNative({ ledger, state, target, directory, attest = verifyHistoricalAttestation }) {
  const metadata = state.nativeMetadata;
  const build = state.checkpoints.findLast(value => value.stage === 'native-build');
  invariant(['phone', 'wear'].includes(target) && build?.status === 'succeeded' && metadata?.schema_version === 1
    && metadata.source_commit === state.origin.sourceCommit && metadata.workflow_sha === state.record.workflow_sha
    && metadata.artifacts.length === 4, 'Original native build is unavailable or changed.');
  for (const [id, file] of Object.entries(paths)) invariant(metadata.artifacts.filter(value => value.id === id && value.path === file
    && /^[a-f0-9]{64}$/.test(value.sha256)).length === 1, 'Historical native artifact inventory differs.');
  const component = ledger.config.components.find(value => value.id === target && value.kind === 'native');
  invariant(component?.platform === 'android' && component.applicationId === metadata.application_id, 'Configured native application differs from original evidence.');
  const branch = await ledger.api(`/branches/${encodeURIComponent(ledger.config.defaultBranch)}`);
  const ancestry = await ledger.api(`/compare/${metadata.source_commit}...${branch.commit.sha}`);
  invariant(branch.protected && ['ahead', 'identical'].includes(ancestry.status) && ancestry.merge_base_commit?.sha === metadata.source_commit,
    'Original native application source is outside protected history.');
  const asset = name => { const values = state.assets.filter(value => value.name === name); invariant(values.length === 1, `Missing or ambiguous retained ${name}.`); return values[0]; };
  const metadataFile = path.join(directory, 'original-native-metadata.json');
  await ledger.download(asset('native-metadata.json'), build.metadata_sha256, metadataFile);
  invariant(hashIdentity(JSON.parse(fs.readFileSync(metadataFile, 'utf8'))) === hashIdentity(metadata), 'Original metadata changed during restoration.');
  const original = metadata.artifacts.find(value => value.id === `${target}-aab`);
  invariant(build.aab_hashes?.[target] === original.sha256, 'Original build checkpoint and AAB hash differ.');
  const files = path.join(directory, 'files'); fs.mkdirSync(files, { recursive: true });
  const file = path.join(files, `${target}.aab`);
  await ledger.download(asset(`${target}-aab.aab`), original.sha256, file);
  const origin = { kind: 'github', runId: String(build.producing_run_id), runAttempt: Number(build.producing_run_attempt) };
  const sourceProof = await verifyHistoricalArtifact({ repository: ledger.config.repository, source: metadata.source_commit, target, origin,
    original: metadata, directory: files, verifyOriginal: async () => {
      await attest({ api: ledger.api, config: ledger.config, file: metadataFile, signer: metadata.workflow_sha,
        workflow: '.github/workflows/native-build.yml', criticalFiles, policyFile: ledger.config.trust?.nativeWorkflowFile });
      return [{ path: `${target}.aab`, sha256: original.sha256 }];
    } });
  return { file, sha256: original.sha256, sourceProof, origin, metadata, component };
}

/** Route only explicit original stages through their configured protected worker. */
export function routeCalibrateRecovery(state, request, config) {
  invariant(state.legacy && state.recovery.format === 'calibrate-v1' && state.release.draft, 'An unresolved original paired release is required.');
  if (['abandon', 'complete'].includes(request.action)) return { provider: 'repository', approval: '', stage: '' };
  const stage = request.stage ?? request.reconciliation?.stage;
  if (stage === 'deploy') {
    invariant(state.graph.stages.some(value => value.id === stage) && config.deployment, 'Original deployment is not configured.');
    return { provider: 'deploy', approval: config.deployment.environment ?? '', stage };
  }
  const ota = /^(ota-(?:internal|production))(?::publish:runtime-[a-f0-9]{64})?$/.exec(stage ?? '')?.[1];
  if (ota) {
    invariant(state.graph.stages.some(value => value.id === ota), 'Requested original OTA stage was not selected.');
    const component = configuredComponents(config, config.defaultProfile).find(value => value.id === ota && value.kind === 'ota');
    invariant(component, 'Original OTA target is absent from current configuration.');
    const retained = state.checkpoints.some(value => value.stage === `${ota}-artifact`);
    return { provider: retained ? 'expo' : 'ota', target: ota, stage, approval: component.approvalEnvironment ?? '' };
  }
  invariant(['phone-submit', 'wear-submit', 'phone-handoff'].includes(stage), 'Choose an explicit retained native stage; other historical stages require their original retained evidence.');
  invariant(state.graph.stages.some(value => value.id === stage), 'Requested original stage was not selected.');
  const target = stage === 'wear-submit' ? 'wear' : 'phone';
  return { provider: 'expo', approval: configuredComponents(config, config.defaultProfile).find(value => value.id === target)?.approvalEnvironment ?? '', stage };
}

/** Observe a rejected original destination before allowing its specifically audited correction. */
export async function verifyCalibrateCorrection({ value, operation, spec, transport }) {
  invariant(value?.confirmed === true && value.reason?.trim().length >= 20 && value.reason.length <= 2000
    && value.operationId === operation.operationId && value.artifactSha256 === spec.artifact.sha256
    && value.from === (spec.target === 'phone' ? 'qa' : 'wear:qa') && value.to === spec.destination.track,
    'Correction must identify the original rejected destination, provider ID, retained bytes and explicit no-publication evidence.');
  const raw = await transport.getSubmission(operation.operationId);
  verifyEasSubmission(raw, { ...spec, destination: { ...spec.destination, track: value.from } });
  invariant(raw.status === 'ERRORED' && !raw.submittedBuild && raw.archiveUrl
    && await transport.hashArtifact(raw.archiveUrl) === spec.artifact.sha256, 'Original rejection does not prove these exact retained bytes.');
  return { ...value, kind: 'destination-correction', providerStatus: raw.status };
}

/** Continue one original stage using the common executor; all new evidence has a separate producing workflow. */
export async function continueCalibrateRelease({ ledger, releaseId, request, environment = process.env, transport, restore = restoreCalibrateNative }) {
  let state = await ledger.read(releaseId);
  const terminal = state.recoveryEvents.findLast(value => value.event.type === 'completion')?.event;
  if (terminal) invariant((request.action === 'complete' ? terminal.status === 'complete' : request.action === 'abandon' && terminal.status === 'abandoned')
    && (request.action !== 'abandon' || request.reason === terminal.reason), 'A terminal original release may only retry publication of its unchanged completion decision.');
  const route = routeCalibrateRecovery(state, request, ledger.config);
  const append = async event => { await appendCalibrateRecovery({ ledger, state: await ledger.read(releaseId), event }); };
  if (route.provider === 'repository') {
    const operations = Object.values(state.recovery.operations);
    if (request.action === 'complete') invariant(state.summary.status === 'complete', 'Original release still has incomplete stages.');
    else invariant(request.reason?.trim().length >= 20 && operations.every(value => !['intent', 'accepted', 'unknown'].includes(value.status))
      && (!state.record.plan.server || state.summary.completedComponents.includes('server')), 'Resolve unknown outcomes and publish the prepared server before abandonment.');
    if (!terminal) await append({ type: 'completion', status: request.action === 'complete' ? 'complete' : 'abandoned', ...(request.reason ? { reason: request.reason } : {}) });
    await ledger.api(`/releases/${releaseId}`, { method: 'PATCH', body: { draft: false, make_latest: 'false' } });
    return { complete: request.action === 'complete', abandoned: request.action === 'abandon' };
  }
  if (route.provider === 'deploy') return continueCalibrateDeployment({ ledger, state, request, environment });
  invariant(route.provider === 'expo', 'Original OTA continuation uses the shared export and publication workers.');
  if (route.target?.startsWith('ota-')) return continueOriginalOta({ ledger, state, request, target: route.target, environment, transport });
  const target = route.stage === 'wear-submit' ? 'wear' : 'phone'; const stage = `${target}-submit`;
  const prerequisite = target === 'wear' ? ['phone-submit'] : ['native-build', ...(state.record.plan.server ? ['deploy'] : [])];
  invariant(prerequisite.every(id => !state.summary.remaining.includes(id)), 'Original submission dependencies have not completed.');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'original-native-')); let workspace;
  try {
    const retained = await restore({ ledger, state, target, directory });
    const app = await repositoryJson(ledger.api, 'mobile/app.json', state.origin.sourceCommit);
    const expo = ledger.config.expo;
    invariant(app.expo.extra?.eas?.projectId === expo.projectId && app.expo.owner === expo.owner && app.expo.slug === expo.slug
      && app.expo.android?.package === retained.metadata.application_id, 'Original Expo application identity differs.');
    const spec = { ...expo, source: state.origin.sourceCommit, repository: ledger.config.repository, target, platform: 'android', profile: target,
      applicationId: retained.metadata.application_id, version: retained.metadata.native.version,
      versionCode: retained.metadata.native[target === 'phone' ? 'phone_code' : 'wear_code'], runtime: retained.metadata.native.runtime_version,
      channel: 'production', destination: retained.component.submission, sourceProof: retained.sourceProof,
      artifact: { kind: 'retained-file', path: retained.file, sha256: retained.sha256, origin: retained.origin }, expoConfig: app.expo };
    workspace = createEasPublisherWorkspace(spec, { env: { ...sourceEnvironment(environment), ...(environment.EXPO_TOKEN ? { EXPO_TOKEN: environment.EXPO_TOKEN } : {}) } });
    const remote = transport ?? workspace.transport;
    const adapter = { read: () => ledger.read(releaseId), append: (_id, event) => append(event) };
    let previous = latestOperation(state.events, stage);
    if (request.action === 'reconcile' && request.reconciliation?.destination) {
      invariant(previous?.operationId && previous.status !== 'complete', 'Correction requires its retained unresolved original provider ID.');
      const proof = await verifyCalibrateCorrection({ value: request.reconciliation.destination, operation: previous, spec, transport: remote });
      const transition = { type: 'failed', definitive: true, reason: 'Original destination was rejected; audited correction retains the identical AAB.', proof };
      const operation = reduceOperation(previous, transition);
      await append({ stage, status: operation.status, operation, transition });
      return { reconciled: true, stage, nextAction: 'retry', providerId: previous.operationId };
    }
    const base = createEasSubmissionProvider(spec, remote);
    const correction = previous?.proof?.kind === 'destination-correction' ? previous.proof : null;
    const provider = correction ? { ...base,
      async status(id) { if (id !== correction.operationId) return base.status(id); return { id, status: 'failed', correction: true }; },
      async verify(value, context) { return value.correction ? verifyCalibrateCorrection({ value: correction, operation: previous, spec, transport: remote }) : base.verify(value, context); },
      async prepareRetry() { return { mode: 'new-request', proof: await verifyCalibrateCorrection({ value: correction, operation: previous, spec, transport: remote }) }; },
      async start(context) {
        invariant(context.retry?.mode === 'new-request', 'A corrected upload requires its exact explicit retry.');
        await verifyCalibrateCorrection({ value: correction, operation: previous, spec, transport: remote });
        return base.start({ ...context, retry: undefined });
      } } : base;
    if (request.action === 'reconcile') {
      invariant(previous && previous.status !== 'complete' && request.reconciliation?.operationId
        && (!previous.operationId || previous.operationId === request.reconciliation.operationId), 'Reconciliation cannot replace an original provider ID.');
      const observed = await provider.status(request.reconciliation.operationId);
      const proof = await provider.verify(observed, { observe: true });
      if (!previous.operationId) {
        const transition = { type: 'accepted', operationId: observed.id, proof };
        const operation = reduceOperation(previous, transition); await append({ stage, status: operation.status, operation, transition });
      }
    }
    const operation = await executeOperation({ ledger: adapter, releaseId, stage, provider, retry: request.action === 'retry',
      context: { planDigest: hashIdentity(state.legacyPlan), source: spec.source, target, artifactSha256: spec.artifact.sha256 } });
    if (target === 'phone' && ['accepted', 'complete'].includes(operation.status)) {
      state = await ledger.read(releaseId);
      const handoff = latestOperation(state.events, 'phone-handoff');
      if (state.summary.remaining.includes('phone-handoff')) {
        let current = handoff;
        for (const transition of [...(!current ? [{ type: 'intent', operationKey: 'phone-handoff' }] : []),
          { type: 'complete', receipt: { providerId: operation.operationId, proof: operation.proof ?? operation.receipt }, proof: operation.proof ?? operation.receipt }]) {
          current = reduceOperation(current, transition); await append({ stage: 'phone-handoff', status: current.status, operation: current, transition });
        }
      }
    }
    return { stage, operation, complete: false };
  } finally { workspace?.dispose(); fs.rmSync(directory, { recursive: true, force: true }); }
}

/** Preserve the original webhook's health-only contract and require explicit service-log reconciliation after interruption. */
export async function continueCalibrateDeployment({ ledger, state, request, environment = process.env, provider = createDeploymentProvider(ledger.config.deployment, { environment }) }) {
  invariant(!state.summary.remaining.includes('image'), 'Original image publication must complete before deployment.');
  const stage = 'deploy'; const releaseId = state.release.id; const previous = latestOperation(state.events, stage);
  const context = { planDigest: hashIdentity(state.legacyPlan), source: state.origin.sourceCommit, target: 'server', service: ledger.config.deployment.service };
  const append = async event => appendCalibrateRecovery({ ledger, state: await ledger.read(releaseId), event });
  if (request.action === 'reconcile') {
    invariant(previous && ['intent', 'accepted', 'unknown'].includes(previous.status), 'Only an unresolved original deployment may be reconciled.');
    const bound = { ...context, operationKey: previous.operationKey, attempt: previous.attempt };
    const evidence = request.reconciliation;
    let transition;
    if (evidence?.health) {
      const proof = await provider.reconcile(evidence.health, bound); transition = { type: 'complete', receipt: proof, proof };
    } else {
      invariant(evidence?.absence && !previous.operationId, 'Known deployment IDs cannot be reconciled as absent.');
      transition = { type: 'reconciled-absent', proof: await provider.verifyAbsence(evidence.absence, bound) };
    }
    const operation = reduceOperation(previous, transition); await append({ stage, status: operation.status, operation, transition });
    return operation;
  }
  return executeOperation({ ledger: { read: () => ledger.read(releaseId), append: (_id, event) => append(event) },
    releaseId, stage, context, provider, retry: request.action === 'retry' });
}
