/** @file Plans and executes protected standalone submission, deployment and promotion against original retained evidence without source checkout or baseline reassignment. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildReleaseGraph, createPlan, hashIdentity, invariant, verifyPlan } from '../packages/release-engine/index.mjs';
import { configuredComponents, baselineKey } from './planner.mjs';
import { validatePromotions } from './promotion-config.mjs';
import { restoreArtifact } from './retention.mjs';
import { verifyRetainedArtifact } from './artifacts.mjs';
import { verifyProducer } from './github.mjs';
import { verifyReceiptAttestation } from './attestation.mjs';
import { restoreCalibrateNative } from './compat/calibrate-recovery.mjs';
import { createEasStage } from './eas-stages.mjs';
import { runProviderStage, stageContext } from './stages.mjs';
import { finalizeServer } from './server-release.mjs';
import { createGhcrTransport } from './providers/ghcr.mjs';
import { createDeploymentProvider } from './providers/deploy.mjs';
import { createPlayCohortPromotionProvider } from './providers/play-cohort.mjs';
import { createGooglePlayPublisher, resolveGooglePlayAccessToken } from './providers/play-transport.mjs';

const same = (left, right) => hashIdentity(left) === hashIdentity(right);

function originalIdentity(state) {
  invariant(!state.local && state.origin?.kind !== 'local' && state.plan?.origin?.kind !== 'local', 'Local evidence cannot authorize retained hosted operations.');
  if (!state.legacy) {
    const plan = verifyPlan(state.plan);
    invariant(plan.prepared && plan.origin.kind === 'github' && !plan.retainedOperation, 'Choose the original prepared build/release, not another retained operation.');
    return { format: 'common', digest: plan.digest, source: plan.source.commit, profile: plan.profile, origin: plan.origin };
  }
  invariant(state.recovery?.format === 'calibrate-v1' && state.nativeMetadata, 'This historical format needs its original compatibility operation.');
  return { format: 'calibrate-v1', digest: hashIdentity(state.record), source: state.origin.sourceCommit, profile: 'production', origin: state.origin };
}

function artifactReference(state, target, original) {
  if (original.format === 'calibrate-v1') {
    const artifact = state.nativeMetadata.artifacts.find(value => value.id === `${target}-aab`);
    invariant(artifact && /^[a-f0-9]{64}$/.test(artifact.sha256), 'Historical native artifact is unavailable.');
    return { target, metadataDigest: hashIdentity(state.nativeMetadata), sha256: artifact.sha256 };
  }
  const event = state.events.findLast(value => value.type === 'artifact' && value.target === target);
  invariant(event?.receipt?.planDigest === state.plan.digest && event.receipt.target === target && event.receipt.origin?.kind === 'github'
    && event.receipt.manifest?.files?.length && event.files?.length === event.receipt.manifest.files.length,
  'Selected target has no complete original hosted artifact inventory.');
  invariant(event.receiptAsset?.id && event.receiptAsset.name && /^[a-f0-9]{64}$/.test(event.receiptAsset.sha256), 'Original artifact receipt is unavailable.');
  invariant(event.files.every(file => state.assets.some(asset => asset.id === file.assetId && asset.name === file.name && asset.size === file.size)), 'Original retained artifact is missing.');
  return { target, receiptDigest: hashIdentity(event.receipt), inventoryDigest: hashIdentity(event.files), receiptAsset: event.receiptAsset };
}

function selectedComponents(state, config, original) {
  if (original.format === 'common') return state.plan.components.filter(value => value.selected).map(value => {
    const current = configuredComponents(config, original.profile).find(component => component.id === value.id);
    invariant(current && current.kind === value.kind && current.platform === value.platform && current.applicationId === value.applicationId,
      'Retained target identity differs from current configuration.');
    return { ...value, ...(current.approvalEnvironment ? { approvalEnvironment: current.approvalEnvironment } : {}) };
  });
  return configuredComponents(config, 'production').filter(value => ['phone', 'wear'].includes(value.id) && value.kind === 'native').map(value => ({ ...value,
    selected: true, key: baselineKey(value, 'production'), identity: hashIdentity({ source: original.source, target: value.id }),
    observation: { id: value.id, version: state.nativeMetadata.native.version,
      versionCode: state.nativeMetadata.native[value.id === 'phone' ? 'phone_code' : 'wear_code'], runtime: state.nativeMetadata.native.runtime_version } }));
}

function completedSubmission(state, target, original) {
  const stage = original.format === 'common' ? `${target}:submit` : `${target}-submit`;
  invariant(state.events.findLast(value => value.stage === stage)?.status === 'complete', 'Exact native submissions must complete before Play promotion.');
}

/** Read-only planning validates identities and inventories; byte/provenance verification is repeated in the protected executor. */
export function retainedOperationRequest({ state, config, operation, targets = [], promotion }) {
  validatePromotions(config);
  invariant(['submit', 'deploy', 'promote'].includes(operation), 'Unsupported retained operation.');
  invariant(!state.release.draft && (!state.legacy || state.resolved), 'Resolve the original release before starting a standalone operation.');
  const original = originalIdentity(state); const available = selectedComponents(state, config, original);
  invariant(/^[1-9]\d*$/.test(String(state.release.id)) && (!state.plan || state.plan.source.repository === config.repository), 'Retained operation repository/release identity differs.');
  invariant(original.format === 'common' || operation === 'promote' && promotion, 'Historical submissions/deployments continue through their original recovery adapter.');
  let selected = targets.length ? [...targets] : available.filter(value => operation === 'submit' ? value.kind === 'native'
    : operation === 'promote' ? value.kind === 'server' : value.kind === 'server' || value.kind === 'ota').map(value => value.id);
  let policy;
  if (promotion) {
    invariant(operation === 'promote', 'A promotion name only applies to promote.'); policy = config.promotions?.[promotion];
    invariant(policy && (!targets.length || same([...targets].sort(), [...policy.targets].sort())), 'Select the full configured promotion cohort.');
    selected = [...policy.targets];
  }
  if (operation === 'deploy' && !targets.length) selected = selected.slice(0, 1);
  invariant(selected.length && new Set(selected).size === selected.length && selected.every(id => available.some(value => value.id === id)), 'Choose available unique retained targets.');
  const components = selected.map(id => available.find(value => value.id === id));
  if (operation === 'submit') {
    invariant(components.every(value => value.kind === 'native'), 'Only native artifacts can be submitted.');
    for (const component of components) invariant(state.events.findLast(value => value.stage === `${component.id}:submit`)?.status !== 'complete',
      'This native submission is already complete; use promotion rather than uploading it again.');
  }
  if (operation === 'deploy') invariant(selected.length === 1 && config.deployment && components[0].kind !== 'native'
    && state.events.findLast(value => value.type === 'completion')?.completion?.status === 'complete', 'Deployment requires one completed original release and its configured endpoint.');
  if (operation === 'promote') {
    invariant(policy ? components.every(value => value.kind === 'native' && value.platform === 'android')
      : components.length === 1 && components[0].kind === 'server', 'Native promotion requires a named Play policy; image promotion requires one server.');
    if (policy) components.forEach(value => completedSubmission(state, value.id, original));
    else invariant(state.events.findLast(value => value.stage === `${components[0].id}:publish`)?.status === 'complete', 'Publish the exact original image before promotion.');
  }
  const artifacts = operation === 'deploy' ? [] : components.map(value => artifactReference(state, value.id, original));
  const payload = { schemaVersion: 1, kind: 'expo-release-operation', operation, releaseId: String(state.release.id), planDigest: original.digest,
    configuration: hashIdentity(config), targets: selected, ...(promotion ? { promotion } : {}), original, artifacts };
  return { ...payload, digest: hashIdentity(payload) };
}

/** Recompute the read-only request under current hosted authority and seal a prepared plan that references original artifacts. */
export function prepareRetainedOperation({ state, request, config, source, origin, runId = origin.runId }) {
  invariant(origin?.kind === 'github' && String(origin.runId) === String(runId) && source.workflowCommit && source.toolkitCommit
    && source.origin !== 'local' && source.repository === config.repository,
    'Retained publication must be prepared by its new protected hosted run.');
  const expected = retainedOperationRequest({ state, config, operation: request.operation, targets: request.targets, promotion: request.promotion });
  invariant(same(request, expected), 'Retained operation changed since planning.');
  const available = selectedComponents(state, config, request.original); const components = available.filter(value => request.targets.includes(value.id));
  const graph = []; const stages = {};
  const add = (component, action, specification, needs = []) => {
    const id = `${component.id}:${action}`; graph.push({ id, component: component.id, needs });
    stages[id] = { target: component.id, action, ...specification };
  };
  if (request.promotion) {
    const groups = new Map();
    for (const component of components) { const values = groups.get(component.applicationId) || []; values.push(component.id); groups.set(component.applicationId, values); }
    for (const [applicationId, targets] of groups) add(components.find(value => value.id === targets[0]), 'promote', { provider: 'play', applicationId, targets, promotion: request.promotion });
  } else if (request.operation === 'promote') add(components[0], 'finalize', { provider: 'image' });
  else if (request.operation === 'deploy') add(components[0], 'deploy', { provider: 'deploy' });
  else for (const component of components) add(component, 'submit', { provider: 'expo' },
    (component.after || []).filter(id => request.targets.includes(id)).map(id => `${id}:submit`));
  return createPlan({ runId: String(runId), origin, source: { ...source, commit: request.original.source }, operation: request.operation, prepared: true,
    config, profile: request.original.profile, components, graph: buildReleaseGraph(graph), stages,
    selection: { selected: request.targets, noop: false }, reservations: {}, baseline: { components: {}, runtimes: {}, reservations: {} },
    providerConfiguration: state.plan?.providerConfiguration || {}, retainedOperation: request });
}

/** Route one prepared retained stage to fixed provider capabilities and the current configuration's approval policy. */
export function routeRetainedOperation(plan, stage) {
  verifyPlan(plan); const value = plan.stages[stage]; const component = plan.components.find(item => item.id === value?.target);
  invariant(plan.prepared && plan.retainedOperation && plan.origin.kind === 'github' && value && component
    && ['expo', 'play', 'image', 'deploy'].includes(value.provider), 'Expected one prepared hosted retained-operation stage.');
  if (value.provider === 'play') {
    const policy = plan.config.promotions[value.promotion];
    return { stage, provider: 'play', approval: policy.approvalEnvironment, credentials: policy.credentials };
  }
  return { stage, provider: value.provider, approval: value.provider === 'deploy' ? plan.config.deployment.environment || '' : component.approvalEnvironment || '' };
}

/** Resolve only the credentials named by this promotion stage; generic or other-stage secrets are never fallback authority. */
export async function resolvePromotionToken(credentials, environment, resolveToken = resolveGooglePlayAccessToken) {
  const token = credentials.accessToken && environment[credentials.accessToken];
  if (token) return resolveToken({ environment: { GOOGLE_PLAY_ACCESS_TOKEN: token } });
  const encoded = credentials.serviceAccountBase64 && environment[credentials.serviceAccountBase64];
  invariant(typeof encoded === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded), 'The selected promotion stage has no credentials.');
  let value; try { value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); } catch { throw new Error('The selected promotion service account is invalid.'); }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-play-key-'));
  try { const file = path.join(directory, 'key.json'); fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); return await resolveToken({ serviceAccountFile: file, environment: {} }); }
  finally { invariant(path.dirname(path.resolve(directory)) === path.resolve(os.tmpdir()), 'Credential cleanup escaped the temporary directory.'); fs.rmSync(directory, { recursive: true, force: true }); }
}

/** Restore original receipt/attestation bytes into a fresh inert directory; the new operation never becomes their producer. */
export async function restoreRetainedOperationArtifact({ ledger, state, target, directory, verifyAttestation = verifyReceiptAttestation, restoreHistorical = restoreCalibrateNative }) {
  if (state.legacy) return restoreHistorical({ ledger, state, target, directory });
  return restoreArtifact({ ledger, releaseId: state.release.id, target, directory, verify: (receipt, folder, file) =>
    verifyRetainedArtifact({ plan: state.plan, target, directory: folder, receipt,
      verifyProducer: async value => Boolean(await verifyProducer(ledger.api, ledger.config, value.producer.origin, value.producer.workflowCommit)),
      verifyAttestation: value => verifyAttestation({ api: ledger.api, config: ledger.config, receipt: value, file }) }) });
}

async function originalForOperation(ledger, plan) {
  const request = plan.retainedOperation; const original = await ledger.read(request.releaseId);
  invariant(same(retainedOperationRequest({ state: original, config: plan.config, operation: request.operation, targets: request.targets, promotion: request.promotion }), request),
    'Original retained evidence or permission changed before execution.');
  return original;
}

/** Compose a source-free observer/publisher from original ledger artifacts; construction never starts a provider operation. */
export async function retainedOperationProvider({ ledger, state, stage, directory, environment = process.env,
  restore = restoreRetainedOperationArtifact, easTransport, deploy, token = resolvePromotionToken, publisherFactory = createGooglePlayPublisher }) {
  const plan = state.plan; const route = routeRetainedOperation(plan, stage); const spec = plan.stages[stage]; const request = plan.retainedOperation;
  invariant(route.provider !== 'image', 'Image finalization resumes through protected tag/alias readback; it has no replaceable provider operation ID.');
  const original = await originalForOperation(ledger, plan);
  let workspace;
  const artifacts = new Map();
  const load = async target => {
    if (!artifacts.has(target)) artifacts.set(target, await restore({ ledger, state: original, target, directory: path.join(directory, target) }));
    return artifacts.get(target);
  };
  try {
    let provider;
    if (route.provider === 'deploy') provider = createDeploymentProvider(plan.config.deployment, { environment, ...(deploy ? { transport: deploy } : {}) });
    else if (route.provider === 'expo') {
      const artifact = await load(spec.target);
      workspace = await createEasStage({ action: 'submit', plan: original.plan, component: spec.target, artifact, sourceProof: artifact.sourceProof,
        transport: easTransport, providerEnvironment: environment }); provider = workspace.provider;
    } else {
      const policy = plan.config.promotions[spec.promotion]; const targets = [];
      for (const target of spec.targets) {
        completedSubmission(original, target, request.original);
        const artifact = await load(target); const component = plan.components.find(value => value.id === target); const tracks = policy.tracks[target];
        const files = artifact.receipt?.manifest.files.filter(value => value.path.endsWith('.aab'));
        invariant(artifact.file || files?.length === 1, 'Promotion needs one original AAB per target.');
        if (artifact.receipt) invariant(artifact.receipt.metadata.kind === 'native'
          && Number(artifact.receipt.metadata.native?.versionCode ?? artifact.receipt.metadata.versionCode) === component.observation.versionCode,
        'Promotion version differs from original native artifact metadata.');
        const marker = `${tracks.sourceMarkerPrefix || `expo-${target}`}@${request.original.source}`;
        targets.push({ target, applicationId: spec.applicationId, sourceTrack: tracks.source, destination: tracks.destination,
          versionCode: component.observation.versionCode, sha256: artifact.sha256 || files[0].sha256, marker,
          ...(tracks.sourceMarkerPrefix ? { sourceMarker: marker } : {}), sourceProof: artifact.sourceProof });
      }
      const accessToken = await token(policy.credentials, environment);
      provider = createPlayCohortPromotionProvider({ applicationId: spec.applicationId, source: plan.source.commit, repository: plan.source.repository, targets },
        publisherFactory({ applicationId: spec.applicationId, accessToken }));
    }
    return { route, provider,
      /** Dispose data-only publisher configuration; the caller owns restored retained files. */
      dispose() { workspace?.dispose(); } };
  } catch (error) { workspace?.dispose(); throw error; }
}

/** Execute or observe one protected operation using retained bytes only; the caller owns the fresh output directory. */
export async function executeRetainedOperation({ ledger, releaseId, stage, directory, environment = process.env, retry = false, wait = true,
  restore = restoreRetainedOperationArtifact, easTransport, registry, deploy, token = resolvePromotionToken, publisherFactory = createGooglePlayPublisher }) {
  const initial = await ledger.read(releaseId); const route = routeRetainedOperation(initial.plan, stage); const spec = initial.plan.stages[stage];
  const context = await stageContext(ledger, releaseId, spec.target, spec.action); const plan = context.plan;
  if (context.complete) return { route, complete: true };
  if (route.provider === 'image') {
    const original = await originalForOperation(ledger, plan);
    const artifact = await restore({ ledger, state: original, target: spec.target, directory: path.join(directory, spec.target) });
    const component = plan.components.find(value => value.id === spec.target);
    const transport = registry || createGhcrTransport({ image: component.image, username: environment.GITHUB_ACTOR, token: environment.GHCR_TOKEN });
    await finalizeServer({ ledger, releaseId, target: spec.target, api: ledger.api,
      artifact: { ...artifact, file: path.join(artifact.directory, 'image.oci.tar') }, transport });
    return { route, complete: true };
  }
  const built = await retainedOperationProvider({ ledger, state: initial, stage, directory, environment, restore, easTransport, deploy, token, publisherFactory });
  try {
    const operation = await runProviderStage({ ledger, releaseId, target: spec.target, action: spec.action, provider: built.provider, retry, wait,
      request: { retainedReleaseId: plan.retainedOperation.releaseId, retainedPlanDigest: plan.retainedOperation.planDigest } });
    return { route, complete: operation.status === 'complete', operation };
  } finally { built.dispose(); }
}
