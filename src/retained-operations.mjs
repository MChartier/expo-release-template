/** @file Prepare retained-artifact plans and revalidate their original evidence; execution uses the ordinary stage executor. */
import { buildReleaseGraph, createPlan, hashIdentity, invariant, verifyPlan } from '../packages/release-engine/index.mjs';
import { configuredComponents } from './planner.mjs';
import { validatePromotions } from './promotion-config.mjs';

const same = (left, right) => hashIdentity(left) === hashIdentity(right);

function originalIdentity(state) {
  invariant(!state.local && state.origin?.kind !== 'local' && state.plan?.origin?.kind !== 'local', 'Local evidence cannot authorize retained hosted operations.');
  const plan = verifyPlan(state.plan);
  invariant(plan.prepared && plan.origin.kind === 'github' && !plan.retainedOperation, 'Choose the original prepared build/release, not another retained operation.');
  return { format: 'common', digest: plan.digest, source: plan.source.commit, profile: plan.profile, origin: plan.origin };
}

function artifactReference(state, target, original) {
  const event = state.events.findLast(value => value.type === 'artifact' && value.target === target);
  invariant(event?.receipt?.planDigest === state.plan.digest && event.receipt.target === target && event.receipt.origin?.kind === 'github'
    && event.receipt.manifest?.files?.length && event.files?.length === event.receipt.manifest.files.length,
  'Selected target has no complete original hosted artifact inventory.');
  invariant(event.receiptAsset?.id && event.receiptAsset.name && /^[a-f0-9]{64}$/.test(event.receiptAsset.sha256), 'Original artifact receipt is unavailable.');
  invariant(event.files.every(file => state.assets.some(asset => asset.id === file.assetId && asset.name === file.name && asset.size === file.size)), 'Original retained artifact is missing.');
  return { target, receiptDigest: hashIdentity(event.receipt), inventoryDigest: hashIdentity(event.files), receiptAsset: event.receiptAsset };
}

function selectedComponents(state, config, original) {
  return state.plan.components.filter(value => value.selected).map(value => {
    const current = configuredComponents(config, original.profile).find(component => component.id === value.id);
    invariant(current && current.kind === value.kind && current.platform === value.platform && current.applicationId === value.applicationId,
      'Retained target identity differs from current configuration.');
    return { ...value, ...(current.approvalEnvironment ? { approvalEnvironment: current.approvalEnvironment } : {}) };
  });

}

function completedSubmission(state, target, original) {
  const stage = `${target}:submit`;
  invariant(state.events.findLast(value => value.stage === stage)?.status === 'complete', 'Exact native submissions must complete before Play promotion.');
}

/** Read-only planning validates identities and inventories; byte/provenance verification is repeated in the protected executor. */
export function retainedOperationRequest({ state, config, operation, targets = [], promotion }) {
  validatePromotions(config);
  invariant(['submit', 'deploy', 'promote'].includes(operation), 'Unsupported retained operation.');
  invariant(!state.release.draft, 'Resolve the original release before starting a standalone operation.');
  const original = originalIdentity(state); const available = selectedComponents(state, config, original);
  invariant(/^[1-9]\d*$/.test(String(state.release.id)) && (!state.plan || state.plan.source.repository === config.repository), 'Retained operation repository/release identity differs.');
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

/** Revalidate the original release and current retained-operation authorization before restoring any input. */
export async function retainedSource(ledger, plan) {
  const request = plan.retainedOperation; const original = await ledger.read(request.releaseId);
  invariant(same(retainedOperationRequest({ state: original, config: plan.config, operation: request.operation, targets: request.targets, promotion: request.promotion }), request),
    'Original retained evidence or permission changed before execution.');
  return original;
}
