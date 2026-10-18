/** @file Read the original schema-1 paired-Android ledger without changing its records, provider IDs, or workflow provenance. */
import { createHash, randomUUID } from 'node:crypto';
import { invariant, buildReleaseGraph, summarizeRelease, hashIdentity, verifyPlan, reduceOperation } from '../../packages/release-engine/index.mjs';
import { baselineKey, runtimeBaselineKey, configuredComponents } from '../planner.mjs';
import { verifyProducer } from '../github.mjs';
import { verifyCalibrateOtaPlan } from './calibrate-ota.mjs';

const SHA = /^[a-f0-9]{40}$/;
const states = { started: 'intent', enqueueing: 'intent', queued: 'accepted', unknown: 'unknown', succeeded: 'complete', failed: 'failed', 'not-published': 'failed' };
const stages = new Set(['prepared', 'image', 'deploy', 'native-build', 'phone-handoff', 'phone-submit', 'wear-submit', 'ota-internal', 'ota-production', 'ota-internal-artifact', 'ota-production-artifact', 'final']);

function compatibilityCompletions(views) {
  const result = [];
  for (const [target, view] of Object.entries(views)) {
    const summary = summarizeRelease(view.plan.graph, view.events.filter(event => view.plan.stages[event.stage]));
    if (summary.status !== 'complete') continue;
    const receipt = view.events.findLast(event => event.stage === `${target}:publish`)?.receipt;
    invariant(receipt?.outcome === 'published' && receipt.publications?.length === 1, 'Original OTA continuation needs a verified publication.');
    const operation = reduceOperation(reduceOperation(null, { type: 'intent', operationKey: target }), { type: 'complete', receipt });
    result.push({ stage: target, status: 'complete', operation, compatibility: view.plan.digest });
  }
  return result;
}

function validateCompletion(event, { record, graph, events, views }) {
  invariant(event.type === 'completion' && ['complete', 'abandoned'].includes(event.status), 'Unknown historical recovery event.');
  const effective = [...events, ...compatibilityCompletions(views)];
  const operations = Object.values(Object.fromEntries([...effective, ...Object.values(views).flatMap(view => view.events)]
    .filter(value => value.operation).map(value => [value.stage, value.operation])));
  invariant(operations.every(value => !['intent', 'accepted', 'unknown'].includes(value.status)),
    'Reconcile every original provider operation before completion or abandonment.');
  const summary = summarizeRelease(graph, effective);
  if (event.status === 'complete') invariant(summary.status === 'complete', 'Original release still has incomplete stages.');
  else invariant(typeof event.reason === 'string' && event.reason.trim().length >= 20 && event.reason.length <= 2000
    && (!record.plan.server || summary.completedComponents.includes('server')),
  'Abandonment requires an explicit reason and preserves the completed original server publication/deployment.');
}

function applyRecoveryEvent({ record, source, origin, workflowCommit, graph, events, views }, event) {
  invariant(event && typeof event === 'object', 'Missing historical recovery event.');
  if (event.type === 'compatibility-plan') {
    const continued = verifyCalibrateOtaPlan(event.plan, { record, source, target: event.target, origin, workflowCommit });
    invariant(!views[event.target], 'Cannot replace an original OTA continuation.');
    views[event.target] = { plan: continued, events: [] };
  } else if (event.type === 'compatibility-phase') {
    const view = views[event.target]; const data = event.data;
    invariant(view && event.planDigest === view.plan.digest && data && (data.stage
      ? data.stage === `${event.target}:export` || data.stage === `${event.target}:publish` || data.stage.startsWith(`${event.target}:publish:runtime-`)
      : ['artifact-retention', 'artifact', 'recovery'].includes(data.type)), 'Invalid original OTA phase evidence.');
    if (data.operation && data.transition) invariant(hashIdentity(reduceOperation(view.events.findLast(item => item.stage === data.stage)?.operation ?? null, data.transition))
      === hashIdentity(data.operation), 'Original OTA transition changed its provider history.');
    if (data.receipt?.kind === 'expo-release-artifact') invariant(data.receipt.planDigest === view.plan.digest
      && data.receipt.target === event.target, 'Original OTA artifact belongs to another continuation.');
    view.events.push(data);
  } else if (event.stage) {
    invariant(graph.stages.some(stage => stage.id === event.stage), 'Recovery event references an unselected original stage.');
    const previous = events.findLast(item => item.stage === event.stage)?.operation ?? null;
    const operation = reduceOperation(previous, event.transition);
    invariant(hashIdentity(operation) === hashIdentity(event.operation) && operation.status === event.status, 'Recovery transition differs from the preserved operation history.');
    events.push(event);
  } else validateCompletion(event, { record, graph, events, views });
}

/** Reconstruct the original dependency contract, including its independent OTA/native completion semantics. */
export function historicalGraph(plan) {
  const graph = [];
  if (plan.server) graph.push({ id: 'image', component: 'server' }, { id: 'deploy', component: 'server', needs: ['image'] });
  if (plan.native) graph.push({ id: 'native-build', component: 'native' },
    { id: 'phone-handoff', component: 'native', needs: ['native-build', ...(plan.server ? ['deploy'] : [])] },
    { id: 'phone-submit', component: 'native', needs: ['phone-handoff'] }, { id: 'wear-submit', component: 'native', needs: ['phone-submit'] });
  const needs = [...(plan.server ? ['deploy'] : []), ...(plan.native ? ['phone-handoff'] : [])];
  if (plan.ota_internal) graph.push({ id: 'ota-internal', component: 'ota-internal', needs });
  if (plan.ota_production) graph.push({ id: 'ota-production', component: 'ota-production', needs: plan.ota_internal ? ['ota-internal'] : needs });
  return buildReleaseGraph(graph);
}

/** Interpret incomplete pre-journal states conservatively; a recorded failed ID still requires fresh provider inspection. */
export function historicalOperation(checkpoint) {
  if (checkpoint.operation) {
    invariant(checkpoint.operation.operationKey === checkpoint.stage, 'Historical operation key differs.');
    return checkpoint.operation;
  }
  let operation = reduceOperation(null, { type: 'intent', operationKey: checkpoint.stage });
  if (checkpoint.status === 'succeeded') return reduceOperation(operation, { type: 'complete', receipt: checkpoint });
  if (checkpoint.submission_id) operation = reduceOperation(operation, { type: 'accepted', operationId: checkpoint.submission_id });
  if (checkpoint.status === 'queued') return operation;
  if (checkpoint.status === 'not-published' && !checkpoint.submission_id && checkpoint.reconciliation?.confirmed === true
    && checkpoint.reconciliation.evidence?.trim().length >= 20) return reduceOperation(operation, { type: 'reconciled-absent', proof: checkpoint.reconciliation });
  return reduceOperation(operation, { type: 'unknown', reason: 'Historical request requires fresh provider reconciliation.' });
}

/** Normalize historical successful components without claiming unknown source-input hashes or changing failed reservations. */
export function historicalBaseline(record, checkpoints, summary, config, views = {}, events = []) {
  const old = structuredClone(record.baseline ?? {});
  const last = stage => checkpoints.findLast(checkpoint => checkpoint.stage === stage);
  const source = last('prepared')?.source_commit ?? record.source_commit;
  const complete = new Set(summary.completedComponents);
  if (complete.has('server')) old.server = { source_commit: source };
  if (complete.has('native')) old.native = { ...last('native-build').native, source_commit: source };
  for (const channel of ['internal', 'production']) if (complete.has(`ota-${channel}`)) {
    const published = views[`ota-${channel}`]?.events.findLast(value => value.stage === `ota-${channel}:publish`)?.receipt?.publications?.[0];
    const original = events.findLast(value => value.stage === `ota-${channel}` && value.status === 'complete')?.operation?.receipt;
    old[`ota_${channel}`] = { ...(last(`ota-${channel}`)?.publication ?? { runtime_version: published?.runtime ?? original?.runtime ?? original?.runtime_version,
      group: published?.operationId ?? original?.id ?? original?.group }), source_commit: source };
  }
  const baseline = { components: {}, runtimes: {}, reservations: {} };
  const profile = config.defaultProfile ?? '';
  for (const component of configuredComponents(config, profile)) {
    const value = component.kind === 'server' ? old.server : component.kind === 'native' ? old.native : old[`ota_${component.channel}`];
    if (!value) continue;
    const runtime = value.runtime_version;
    const normalized = { source: value.source_commit, legacy: { format: 'calibrate-v1', original: value },
      ...(runtime ? { runtime, fingerprint: runtime, environmentHash: null } : {}), ...(value.version ? { version: value.version } : {}) };
    if (component.kind === 'native') {
      normalized.versionCode = component.id === 'phone' ? value.phone_code : value.wear_code;
      normalized.identity = hashIdentity({ identity: component.id === 'phone' ? runtime : value.wear_hash, environment: null });
    }
    baseline.components[baselineKey(component, profile)] = normalized;
    if (runtime) baseline.runtimes[runtimeBaselineKey(component, profile, runtime)] = normalized;
  }
  const codes = record.plan.native_codes;
  const reserved = Math.max(old.reserved_native_code ?? 0, codes?.mobileVersionCode ?? 0, codes?.wearVersionCode ?? 0);
  const version = record.plan.native_version ?? old.reserved_native_version ?? old.native?.version;
  if (version) baseline.reservations.native = { version, codes: { phone: Math.max(codes?.mobileVersionCode ?? 0, reserved % 2 ? reserved : reserved - 1), wear: reserved % 2 ? reserved + 1 : reserved } };
  if (record.plan.server_version) baseline.reservations.server = { version: record.plan.server_version, codes: {} };
  return baseline;
}

/** The original format is selected explicitly by configuration; application names never select new provider execution. */
export const calibrateReader = {
  matches(record, release, config) { return config.legacy?.format === 'calibrate-v1' && record?.schema_version === 1 && release.tag_name.startsWith('release-run-'); },
  async read({ release, record, assets, api, config }) {
    invariant(record.repository === config.repository && SHA.test(record.source_commit ?? '') && record.source_commit === record.workflow_sha
      && /^[1-9]\d*$/.test(String(record.run_id)) && release.tag_name === `release-run-${record.run_id}`, 'Invalid historical release identity.');
    const plan = record.plan;
    invariant(plan && ['server', 'native', 'ota_internal', 'ota_production', 'reserve_native', 'noop'].every(key => typeof plan[key] === 'boolean')
      && /^[a-f0-9]{40,64}$/.test(plan.runtime_version ?? '') && /^[a-f0-9]{64}$/.test(plan.wear_hash ?? ''), 'Invalid historical component plan.');
    if (plan.native) invariant(Number.isSafeInteger(plan.native_codes?.mobileVersionCode) && plan.native_codes.mobileVersionCode > 0
      && plan.native_codes.mobileVersionCode % 2 === 1 && plan.native_codes.wearVersionCode === plan.native_codes.mobileVersionCode + 1
      && plan.native_codes.wearVersionCode <= 2100000000, 'Historical native allocation changed.');
    const graph = historicalGraph(plan);
    if (record.engine_plan || record.toolkit_sha) {
      const engine = verifyPlan(record.engine_plan, { repository: record.repository, commit: record.source_commit, workflowCommit: record.workflow_sha, toolkitCommit: record.toolkit_sha });
      invariant(engine.runId === record.run_id && hashIdentity(engine.plan) === hashIdentity(plan) && hashIdentity(engine.baseline) === hashIdentity(record.baseline)
        && hashIdentity(engine.graph) === hashIdentity(graph), 'Historical engine envelope differs from its original record.');
    }
    const runs = new Map();
    const verifyRun = async (id, attempt, original = false) => {
      if (!runs.has(id)) runs.set(id, await api(`/actions/runs/${id}`));
      const run = runs.get(id);
      invariant(run.repository?.full_name === config.repository && run.head_branch === (config.legacy.defaultBranch ?? config.defaultBranch)
        && run.event === 'workflow_run' && [config.legacy.handlerWorkflow, config.legacy.recoveryWorkflow].includes(run.path)
        && (run.path !== config.legacy.handlerWorkflow || id === String(record.run_id))
        && (!original || run.head_sha === record.workflow_sha) && Number(attempt) > 0 && Number(attempt) <= run.run_attempt, 'Historical checkpoint producer differs from its original workflow contract.');
      return run;
    };
    await verifyRun(String(record.run_id), 1, true);
    const checkpoints = [];
    for (const asset of assets.filter(value => /^checkpoint-[\w-]+\.json$/.test(value.name)).sort((a, b) => a.id - b.id)) {
      invariant(asset.size <= 1024 * 1024 && asset.uploader?.login === 'github-actions[bot]', 'Untrusted historical checkpoint asset.');
      const checkpoint = JSON.parse(await api(`/releases/assets/${asset.id}`, { raw: true }));
      invariant(stages.has(checkpoint.stage) && String(checkpoint.release_run_id) === String(record.run_id), 'Historical checkpoint belongs to another release.');
      await verifyRun(String(checkpoint.producing_run_id), checkpoint.producing_run_attempt);
      checkpoints.push({ ...checkpoint, asset_id: asset.id });
    }
    const events = checkpoints.filter(checkpoint => graph.stages.some(stage => stage.id === checkpoint.stage) && states[checkpoint.status])
      .map(checkpoint => ({ stage: checkpoint.stage, status: states[checkpoint.status], operation: historicalOperation(checkpoint), original: checkpoint }));
    const last = stage => checkpoints.findLast(value => value.stage === stage);
    if (!record.engine_plan && graph.stages.some(stage => stage.id === 'phone-handoff') && !last('phone-handoff')
      && ['phone-submit', 'ota-internal', 'ota-production'].some(stage => last(stage)?.status === 'succeeded')) {
      events.push({ stage: 'phone-handoff', status: 'complete', legacyEvidence: 'original-workflow-verified-handoff' });
    }
    const recoveryEvents = []; const compatibilityViews = {};
    for (const asset of assets.filter(value => /^recovery-[\w-]+\.json$/.test(value.name)).sort((a, b) => a.id - b.id)) {
      invariant(!recoveryEvents.some(value => value.event.type === 'completion'), 'Cannot append evidence after historical completion.');
      invariant(asset.size <= 1024 * 1024 && asset.uploader?.login === 'github-actions[bot]', 'Untrusted historical recovery event.');
      const value = JSON.parse(await api(`/releases/assets/${asset.id}`, { raw: true }));
      invariant(value.schemaVersion === 1 && value.kind === 'expo-legacy-recovery' && value.recordDigest === hashIdentity(record)
        && value.originalSource === (last('prepared')?.source_commit ?? record.source_commit), 'Recovery event changed its original release identity.');
      invariant(value.sequence === recoveryEvents.length + 1 && value.previousDigest === (recoveryEvents.length ? hashIdentity(recoveryEvents.at(-1)) : null),
        'Historical recovery evidence chain changed.');
      await verifyProducer(api, config, value.origin, value.workflowCommit);
      const event = value.event;
      if (event.type === 'completion') invariant(checkpoints.every(checkpoint => checkpoint.asset_id < asset.id), 'Cannot append original checkpoints after historical completion.');
      applyRecoveryEvent({ record, source: value.originalSource, origin: value.origin, workflowCommit: value.workflowCommit,
        graph, events, views: compatibilityViews }, event);
      recoveryEvents.push(value);
    }
    events.push(...compatibilityCompletions(compatibilityViews));
    const summary = summarizeRelease(graph, events);
    const finalRecovery = recoveryEvents.findLast(value => value.event.type === 'completion')?.event;
    const resolved = !release.draft && (['succeeded', 'abandoned'].includes(last('final')?.status)
      || finalRecovery?.status === 'complete' && summary.status === 'complete' || finalRecovery?.status === 'abandoned');
    const inventory = assets.map(asset => ({ id: asset.id, name: asset.name, size: asset.size }));
    const build = last('native-build');
    const metadataAsset = assets.find(asset => asset.name === 'native-metadata.json');
    let nativeMetadata = null;
    if (build?.status === 'succeeded') {
      invariant(metadataAsset && metadataAsset.size <= 1024 * 1024, 'Historical native metadata is missing.');
      const bytes = await api(`/releases/assets/${metadataAsset.id}`, { raw: true });
      invariant(createHash('sha256').update(bytes).digest('hex') === build.metadata_sha256, 'Historical native metadata hash differs.');
      nativeMetadata = JSON.parse(bytes);
      invariant(nativeMetadata.source_commit === (last('prepared')?.source_commit ?? record.source_commit)
        && nativeMetadata.workflow_sha === record.workflow_sha, 'Retained native source differs from the original producing workflow.');
    }
    return { release, record, plan: null, legacy: true, legacyPlan: plan, graph, checkpoints, recoveryEvents, compatibilityViews, events, assets, inventory, summary, resolved,
      origin: { kind: 'github', runId: String(record.run_id), workflowCommit: record.workflow_sha, sourceCommit: last('prepared')?.source_commit ?? record.source_commit },
      baseline: historicalBaseline(record, checkpoints, summary, config, compatibilityViews, events), nativeMetadata,
      recovery: { format: 'calibrate-v1', originalRunId: String(record.run_id), sourceCommit: last('prepared')?.source_commit ?? record.source_commit,
        operations: Object.fromEntries([...events, ...Object.values(compatibilityViews).flatMap(view => view.events)]
          .filter(event => event.operation).map(event => [event.stage, event.operation])),
        requiresOriginalAttestation: true, providerIds: Object.fromEntries(checkpoints.filter(value => value.submission_id).map(value => [value.stage, value.submission_id])) } };
  }
};

/** Append audited transitions without replacing original records, checkpoints, artifacts, IDs or producing workflows. */
export async function appendCalibrateRecovery({ ledger, state, event }) {
  invariant(state.legacy && state.recovery.format === 'calibrate-v1' && state.release.draft, 'Historical recovery requires the unresolved original draft.');
  invariant(!state.recoveryEvents.some(value => value.event.type === 'completion'), 'Cannot append evidence after historical completion.');
  applyRecoveryEvent({ record: state.record, source: state.origin.sourceCommit, origin: ledger.origin, workflowCommit: ledger.workflowCommit,
    graph: state.graph, events: structuredClone(state.events), views: structuredClone(state.compatibilityViews ?? {}) }, event);
  await verifyProducer(ledger.api, ledger.config, ledger.origin, ledger.workflowCommit);
  const originalRun = await ledger.api(`/actions/runs/${state.record.run_id}`);
  invariant(originalRun.status === 'completed', 'The original producing run is still active.');
  const value = { schemaVersion: 1, kind: 'expo-legacy-recovery', recordDigest: hashIdentity(state.record), originalSource: state.origin.sourceCommit,
    origin: ledger.origin, workflowCommit: ledger.workflowCommit, sequence: state.recoveryEvents.length + 1,
    previousDigest: state.recoveryEvents.length ? hashIdentity(state.recoveryEvents.at(-1)) : null, event };
  return ledger.upload(state.release.id, `recovery-${randomUUID()}.json`, Buffer.from(`${JSON.stringify(value)}\n`));
}
