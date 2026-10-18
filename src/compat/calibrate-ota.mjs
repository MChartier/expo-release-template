/** @file Continue an original OTA checkpoint with common export/retention workers while preserving the original ledger and native evidence. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createPlan, buildReleaseGraph, hashIdentity, invariant, verifyPlan } from '../../packages/release-engine/index.mjs';
import { configuredComponents, baselineKey } from '../planner.mjs';
import { appendCalibrateRecovery } from './calibrate.mjs';
import { verifyHistoricalAttestation } from '../attestation.mjs';
import { exportOta } from '../ota.mjs';
import { resolveOtaBindings } from '../ota-runtime.mjs';
import { inspectExpoSource, exportExpoSource } from '../expo-source.mjs';
import { repositoryJson } from '../trusted.mjs';

async function originalOtaRuntime({ ledger, state, native, target, verifyNative }) {
  if (state.record.plan.native) {
    const metadata = await verifyNative({ ledger, state });
    invariant(native.applicationId === metadata.application_id, 'Current configuration differs from original native application identity.');
    const observation = { runtime: metadata.native.runtime_version, fingerprint: metadata.native.runtime_version,
      version: metadata.native.version, versionCode: metadata.native.phone_code, environmentHash: null };
    return { observation, baseline: { ...observation, source: state.origin.sourceCommit, applicationId: metadata.application_id,
      origin: state.origin, legacy: { format: 'calibrate-v1', metadataDigest: hashIdentity(metadata) } } };
  }
  const [app, release] = await Promise.all([
    repositoryJson(ledger.api, 'mobile/app.json', state.origin.sourceCommit),
    repositoryJson(ledger.api, 'shared/release.json', state.origin.sourceCommit),
  ]);
  invariant(app.expo?.android?.package === native.applicationId && app.expo.extra?.eas?.projectId === ledger.config.expo.projectId
    && app.expo.owner === ledger.config.expo.owner && app.expo.slug === ledger.config.expo.slug,
  'Current configuration differs from original OTA application identity.');
  const phone = release.android?.mobile;
  invariant(/^\d+\.\d+\.\d+$/.test(phone?.version_name ?? '') && Number.isSafeInteger(phone?.version_code) && phone.version_code > 0,
    'Original OTA source has invalid native version metadata.');
  const observation = { runtime: state.record.plan.runtime_version, fingerprint: state.record.plan.runtime_version,
    version: phone.version_name, versionCode: phone.version_code, environmentHash: null };
  if (target === 'ota-internal') return { observation, baseline: null };
  const original = state.record.baseline?.native;
  invariant(original && /^[a-f0-9]{40}$/.test(original.source_commit ?? '')
    && original.runtime_version === observation.runtime && original.version === observation.version && original.phone_code === observation.versionCode,
  'Original production OTA requires its exact captured native runtime/version baseline.');
  return { observation, baseline: { ...observation, source: original.source_commit, applicationId: native.applicationId,
    legacy: { format: 'calibrate-v1', original } } };
}

/** Authenticate the original metadata's runtime without downloading or executing an application binary. */
export async function verifyOriginalNativeRuntime({ ledger, state, attest = verifyHistoricalAttestation }) {
  const checkpoint = state.checkpoints.findLast(value => value.stage === 'native-build');
  const metadata = state.nativeMetadata;
  invariant(checkpoint?.status === 'succeeded' && metadata?.source_commit === state.origin.sourceCommit,
    'Original OTA continuation needs retained native runtime metadata.');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'original-runtime-'));
  try {
    const asset = state.assets.find(value => value.name === 'native-metadata.json');
    invariant(asset, 'Original native runtime metadata is missing.');
    const file = path.join(directory, 'native-metadata.json');
    await ledger.download(asset, checkpoint.metadata_sha256, file);
    invariant(hashIdentity(JSON.parse(fs.readFileSync(file, 'utf8'))) === hashIdentity(metadata), 'Original native metadata changed.');
    await attest({ api: ledger.api, config: ledger.config, file, signer: metadata.workflow_sha, workflow: '.github/workflows/native-build.yml',
      criticalFiles: ['.github/workflows/native-build.yml', 'scripts/native-release-artifacts.mjs', 'scripts/native-release-build.mjs',
        'scripts/native-release-evidence.mjs', 'scripts/native-play-release.mjs', 'scripts/expo-runtime.mjs', 'scripts/release-config.mjs',
        'scripts/zip-entry.mjs', 'scripts/release-selection.mjs', 'mobile/fingerprint.config.js'],
      policyFile: ledger.config.trust?.nativeWorkflowFile });
    return metadata;
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

/** Add one immutable common OTA view to its original journal; no reservation, original record or provider ID is replaced. */
export async function prepareCalibrateOta({ ledger, state, target, toolkitCommit, verifyNative = verifyOriginalNativeRuntime }) {
  invariant(state.legacy && state.recovery.format === 'calibrate-v1' && ['ota-internal', 'ota-production'].includes(target), 'Unknown original OTA stage.');
  const graphStage = state.graph.stages.find(value => value.id === target);
  invariant(graphStage && graphStage.needs.every(id => !state.summary.remaining.includes(id)), 'Original OTA dependencies have not completed.');
  const existing = state.compatibilityViews?.[target];
  if (existing) return existing.plan;
  invariant(state.summary.remaining.includes(target) && !state.events.some(event => event.stage === target),
    'An original remote OTA outcome must be reconciled before preparing another export.');
  invariant(!state.checkpoints.some(value => value.stage === `${target}-artifact`), 'Restore the original retained export instead of creating different bytes.');
  const config = ledger.config; const profile = config.defaultProfile;
  const configured = configuredComponents(config, profile);
  const ota = configured.find(value => value.id === target && value.kind === 'ota');
  const native = configured.find(value => value.id === ota?.nativeTarget && value.kind === 'native');
  invariant(ota && native && native.platform === 'android' && ota.appDirectory === 'mobile' && native.runtimePolicy === 'fingerprint'
    && native.runtimeCompatibility === 'fingerprint'
    && (target === 'ota-internal' ? ota.runtimeBinding === 'source' : ota.runtimeBinding !== 'source'),
  'Current configuration differs from original OTA identity or runtime policy.');
  const runtime = await originalOtaRuntime({ ledger, state, native, target, verifyNative });
  const source = { repository: config.repository, commit: state.origin.sourceCommit, workflowCommit: ledger.workflowCommit, toolkitCommit };
  const observation = { identity: hashIdentity({ original: hashIdentity(state.record), target, source: source.commit }), ...runtime.observation };
  const components = [{ ...native, selected: false, key: baselineKey(native, profile), observation: { ...observation, id: native.id } },
    { ...ota, selected: true, key: baselineKey(ota, profile), observation: { ...observation, id: ota.id }, identity: observation.identity }];
  const stages = { [`${target}:export`]: { target, action: 'export' }, [`${target}:publish`]: { target, action: 'publish' } };
  const plan = createPlan({ source, config, profile, origin: ledger.origin, runId: String(ledger.origin.runId), operation: 'ota', prepared: true,
    components, stages, graph: buildReleaseGraph([{ id: `${target}:export`, component: target },
      { id: `${target}:publish`, component: target, needs: [`${target}:export`] }]),
    selection: { selected: [target], noop: false }, reservations: state.baseline.reservations,
    baseline: { components: runtime.baseline ? { [baselineKey(native, profile)]: runtime.baseline } : {}, runtimes: {}, reservations: state.baseline.reservations },
    providerConfiguration: { expo: config.expo, destinations: {} },
    compatibility: { format: 'calibrate-v1-ota', recordDigest: hashIdentity(state.record), releaseId: String(state.release.id), target } });
  await appendCalibrateRecovery({ ledger, state, event: { type: 'compatibility-plan', target, plan } });
  return plan;
}

/** Adapt the original ledger to the common workers without moving or duplicating its authoritative history. */
export function calibrateOtaLedger(ledger, target) {
  const read = async id => {
    const original = await ledger.read(id); const view = original.compatibilityViews?.[target];
    invariant(view, 'Original OTA continuation has no prepared common view.');
    return { release: original.release, plan: view.plan, reservation: view.plan, events: view.events, assets: original.assets };
  };
  return { config: ledger.config, api: ledger.api, origin: ledger.origin, workflowCommit: ledger.workflowCommit, read,
    upload: (...args) => ledger.upload(...args), download: (...args) => ledger.download(...args),
    async append(id, data) {
      const state = await ledger.read(id); const view = state.compatibilityViews?.[target];
      invariant(view, 'Original OTA view disappeared.');
      return appendCalibrateRecovery({ ledger, state, event: { type: 'compatibility-phase', target, planDigest: view.plan.digest, data } });
    } };
}

/** Validate common-view identity before original-format readers accept any new phase evidence. */
export function verifyCalibrateOtaPlan(plan, { record, source, target, origin, workflowCommit }) {
  verifyPlan(plan, { repository: record.repository, commit: source, workflowCommit });
  invariant(plan.compatibility?.format === 'calibrate-v1-ota' && plan.compatibility.recordDigest === hashIdentity(record)
    && plan.compatibility.target === target && hashIdentity(plan.origin) === hashIdentity(origin)
    && ['ota-internal', 'ota-production'].includes(target) && record.plan[target.replace('-', '_')]
    && plan.prepared && plan.selection.selected.length === 1 && plan.selection.selected[0] === target
    && hashIdentity(Object.keys(plan.stages).sort()) === hashIdentity([`${target}:export`, `${target}:publish`]),
  'Original OTA continuation changed its immutable application or stage authority.');
  return plan;
}

/** Historical source inspection uses the installed SDK and original app contract, with no consumer orchestration or provider credentials. */
export async function exportCalibrateOta({ plan, component, root, inputs, directory, inspect = inspectExpoSource, exportSource = exportExpoSource, git }) {
  invariant(plan.compatibility?.format === 'calibrate-v1-ota', 'Expected original-format OTA source adapter.');
  const app = path.join(root, 'mobile');
  const observations = (_config, options) => {
    const result = inspect({ directory: app, platform: 'android', environment: options.environment });
    invariant(/^[a-f0-9]{40,64}$/.test(result.runtime) && result.expoConfig.android?.package === plan.components.find(value => value.kind === 'native').applicationId
      && result.expoConfig.extra?.eas?.projectId === plan.providerConfiguration.expo.projectId, 'Historical Expo runtime/application identity differs.');
    const expo = JSON.parse(result.resolution.fingerprintSources?.find(value => value.id === 'expoAutolinkingConfig:android')?.contents ?? '{}');
    const native = JSON.parse(result.resolution.fingerprintSources?.find(value => value.id === 'rncoreAutolinkingConfig:android')?.contents ?? '{}');
    invariant(['expo-updates', '@calibrate/wear-pairing'].every(name => expo.modules?.some(value => value.packageName === name))
      && native['react-native-health-connect'], 'Original native module discovery is incomplete.');
    return plan.components.map(value => ({ ...value.observation, runtime: result.runtime, fingerprint: result.runtime,
      environmentHash: options.environmentHash, expoConfig: result.expoConfig }));
  };
  const hook = (_config, action, request) => {
    if (action === 'verify') return { verified: true };
    invariant(action === 'build' && request.phase === 'export', 'Original OTA adapter only exports source assets.');
    exportSource({ directory: app, platform: 'android', outputDirectory: request.outputDirectory, environment: request.environment });
    const after = inspect({ directory: app, platform: 'android', environment: request.environment });
    invariant(after.runtime === request.binding.runtime, 'Source export changed its resolved runtime.');
    return { artifact: { directory: request.outputDirectory, runtime: after.runtime } };
  };
  const artifact = await exportOta({ plan, component, root, inputs, directory, hook,
    resolveBindings: args => resolveOtaBindings({ ...args, inspect: observations, ...(git ? { git } : {}) }) });
  invariant(!artifact.noCompatibleRuntime, 'Original OTA has no compatible native runtime; reconcile its original source before continuing.');
  return artifact;
}
