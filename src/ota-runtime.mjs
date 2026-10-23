/** @file Resolves one OTA export against exact prepared or retained native runtime evidence without changing version reservations or allocation. */
import fs from 'node:fs';
import { hashIdentity, immutable, invariant, verifyPlan } from '../packages/release-engine/index.mjs';
import { repositoryPath } from './config.mjs';
import { baselineKey, runtimeBaselineKey } from './planner.mjs';
import { inspectSource, sourceGit } from './source.mjs';
import { baselineRuntimeOverrides, verifyCompatibleRuntime } from './eas-stages.mjs';

function sameNativeIdentity(baseline, expo, native) {
  const metadata = baseline.releaseMetadata || baseline.release;
  const projectId = baseline.projectId || metadata?.expoProjectId;
  const serverUrl = baseline.serverUrl || metadata?.serverUrl;
  if (projectId) invariant(projectId === expo.projectId, 'Retained runtime belongs to another Expo project.');
  if (serverUrl) invariant(serverUrl === expo.serverUrl, 'Retained runtime belongs to another server origin.');
  if (baseline.applicationId) invariant(baseline.applicationId === native.applicationId, 'Retained runtime belongs to another native application.');
}

function runtimeHistory(plan, native) {
  const current = plan.baseline.components?.[baselineKey(native, plan.profile)];
  return [current, ...Object.entries(plan.baseline.runtimes ?? {}).filter(([name, value]) => (value.runtime || value.runtimeVersion)
    && name === runtimeBaselineKey(native, plan.profile, value.runtime || value.runtimeVersion)).map(([, value]) => value)].filter(Boolean);
}

function retirementPolicy(plan, root) {
  if (!plan.config.policy?.runtimeSupportFile) return [];
  const policy = JSON.parse(fs.readFileSync(repositoryPath(root, plan.config.policy.runtimeSupportFile), 'utf8'));
  invariant((policy.schemaVersion ?? policy.schema) === 1 && Array.isArray(policy.retiredRuntimes), 'Invalid runtime retirement policy.');
  return policy.retiredRuntimes;
}

function overrides(native, baseline) {
  return (native.runtimePolicy ?? 'appVersion') === 'appVersion'
    && (baseline.releaseMetadata || baseline.release) ? baselineRuntimeOverrides(baseline) : {};
}

function fingerprintCompatibility(native) {
  invariant(!native.runtimeCompatibility || ['exact', 'fingerprint'].includes(native.runtimeCompatibility), 'Unsupported runtime compatibility policy.');
  const enabled = native.runtimeCompatibility === 'fingerprint';
  invariant(!enabled || native.runtimePolicy === 'fingerprint', 'Fingerprint compatibility requires fingerprint runtime policy.');
  return enabled;
}

/** Validate a retained binding against the immutable plan and native history without invoking source tools. */
export function verifyOtaBinding({ plan, component, binding }) {
  verifyPlan(plan);
  const target = typeof component === 'string' ? plan.components.find(value => value.id === component) : component;
  invariant(target?.kind === 'ota' && target.selected && plan.components.some(value => hashIdentity(value) === hashIdentity(target)), 'Unknown planned OTA target.');
  const native = plan.components.find(value => value.id === target.nativeTarget);
  const fingerprintOnly = fingerprintCompatibility(native);
  const retained = binding?.origin === 'retained-native' ? runtimeHistory(plan, native).find(value => hashIdentity(value) === binding.baselineIdentity) : null;
  const sourceOnly = binding?.origin === 'source-validated' && target.runtimeBinding === 'source';
  const expected = sourceOnly ? binding.observation : binding?.origin === 'prepared-native' && native.selected ? native.observation : retained;
  const key = hashIdentity({ target: target.id, runtime: binding?.runtime });
  invariant(binding?.schemaVersion === 1 && binding.kind === 'expo-ota-runtime-binding' && binding.planDigest === plan.digest
    && binding.target === target.id && binding.nativeTarget === native.id && binding.source === plan.source.commit
    && binding.profile === plan.profile && binding.platform === target.platform && binding.channel === target.channel
    && binding.environment === target.environment && /^[a-f0-9]{64}$/.test(binding.environmentHash ?? '')
    && binding.key === key && binding.directory === `runtime-${key}` && expected,
  'OTA binding differs from its sealed plan or native runtime history.');
  if (sourceOnly) {
    invariant(native.runtimePolicy === 'fingerprint' && binding.runtime === binding.fingerprint && binding.fingerprint === expected.fingerprint
      && binding.runtime === expected.runtime && binding.environmentHash === expected.environmentHash && expected.identity === target.observation.identity
      && binding.baselineIdentity === null && binding.baselineSource === plan.source.commit && binding.nativeEnvironmentHash === null
      && hashIdentity(binding.runtimeOverrides) === hashIdentity({}), 'Source runtime binding claims incompatible native evidence.');
    if (target.observation.environmentHash === binding.environmentHash) invariant(target.observation.runtime === binding.runtime
      && target.observation.fingerprint === binding.fingerprint, 'Source runtime differs from the planned exact environment inspection.');
    return binding;
  }
  invariant(binding.runtime === (expected.runtime || expected.runtimeVersion) && binding.fingerprint === expected.fingerprint
    && (fingerprintOnly ? binding.runtime === binding.fingerprint && (binding.nativeEnvironmentHash ?? null) === (expected.environmentHash ?? null)
      : binding.environmentHash === expected.environmentHash)
    && binding.baselineSource === (retained ? retained.source || retained.commit : plan.source.commit)
    && hashIdentity(binding.runtimeOverrides) === hashIdentity(retained ? overrides(native, retained) : {}),
  'OTA binding changed its exact native compatibility evidence.');
  for (const name of ['version', 'versionCode']) if (expected[name] !== undefined) invariant(String(binding[name]) === String(expected[name]), 'OTA binding changed its native version metadata.');
  if (retained) sameNativeIdentity(retained, plan.providerConfiguration.expo, native);
  return binding;
}

/**
 * Inspect a selected OTA target after its environment approval, using the chosen native baseline's version
 * overlay when appVersion targets share metadata. Optional baseline must be present in this sealed plan's
 * target/runtime history; callers may resolve each supported runtime independently. The returned immutable
 * binding authorizes no provider operation and does not mutate the plan, baselines or version reservations.
 */
export async function resolveOtaBinding({ plan, component, root, inputs, baseline,
  inspect = inspectSource, git = sourceGit }) {
  verifyPlan(plan);
  const target = typeof component === 'string' ? plan.components.find(value => value.id === component) : component;
  invariant(plan.prepared && target?.kind === 'ota' && target.selected
    && plan.components.some(value => value.id === target.id && hashIdentity(value) === hashIdentity(target)), 'OTA binding requires the exact prepared selected target.');
  invariant(git(root, ['rev-parse', 'HEAD']) === plan.source.commit && !git(root, ['status', '--porcelain', '--untracked-files=no']), 'OTA inspection requires the clean exact prepared checkout.');
  const native = plan.components.find(value => value.id === target.nativeTarget && value.kind === 'native');
  invariant(native && native.platform === target.platform, 'OTA target lacks its native platform.');
  const fingerprintOnly = fingerprintCompatibility(native);
  const environment = inputs.components?.[target.id] || inputs;
  invariant(environment && !environment.deferred && /^[a-f0-9]{64}$/.test(environment.hash ?? ''), 'Resolve the approved OTA environment before inspecting its runtime.');
  const expo = plan.providerConfiguration?.expo;
  invariant(expo && hashIdentity(inputs.expo) === hashIdentity(expo), 'Approved runtime project differs from the sealed provider identity.');
  const retiredRuntimes = retirementPolicy(plan, root);
  invariant(!target.runtimeBinding || ['native', 'source'].includes(target.runtimeBinding), 'Unsupported OTA runtime binding policy.');
  const sourceOnly = target.runtimeBinding === 'source';
  invariant(!sourceOnly || native.runtimePolicy === 'fingerprint' && !baseline, 'Source runtime binding requires a fingerprint target without a native baseline claim.');
  const usePrepared = !sourceOnly && native.selected && !baseline;
  let original;
  let runtimeOverrides = {};
  if (!usePrepared && !sourceOnly) {
    const key = baselineKey(native, plan.profile);
    const history = runtimeHistory(plan, native);
    original = baseline || plan.baseline.components?.[key];
    invariant(original && history.some(value => hashIdentity(value) === hashIdentity(original)), 'Retained native runtime is missing from this target history.');
    sameNativeIdentity(original, expo, native);
    runtimeOverrides = overrides(native, original);
  }
  const observations = inspect(plan.config, { root, source: plan.source, profile: plan.profile, baseline: plan.baseline,
    environment: environment.environment, environmentHash: environment.hash,
    componentEnvironments: { ...inputs.components, [target.id]: environment, [native.id]: environment }, runtimeOverrides });
  const actualNative = observations.find(value => value.id === native.id);
  const actual = observations.find(value => value.id === target.id);
  invariant(actualNative && actual && actual.identity === target.observation.identity, 'Export inspection changed its planned source inputs.');
  invariant(actual.environmentHash === environment.hash && actualNative.environmentHash === environment.hash,
    'Runtime inspection did not use the approved environment.');
  invariant(actual.runtime === actualNative.runtime && actual.fingerprint === actualNative.fingerprint,
    'OTA export and its native inspection disagree about the full runtime/fingerprint.');
  const runtime = actual.runtime;
  invariant(!retiredRuntimes.some(value => value.platform === target.platform && value.profile === plan.profile && value.runtimeVersion === runtime), 'Selected runtime was explicitly retired.');
  if (sourceOnly) invariant(actual.runtime === actual.fingerprint, 'Source runtime must equal its actual full fingerprint.');
  else if (usePrepared) {
    const expected = native.observation;
    invariant((fingerprintOnly ? ['runtime', 'fingerprint'] : ['runtime', 'fingerprint', 'environmentHash']).every(key => expected[key] && expected[key] === actualNative[key])
      && (!fingerprintOnly || actual.runtime === actual.fingerprint),
      'Export does not match the exact prepared native build runtime/fingerprint/environment.');
  } else {
    await verifyCompatibleRuntime({ component: native, baseline: original, observation: actualNative, source: plan.source.commit,
      profile: plan.profile, retiredRuntimes,
      isAncestor: async (ancestor, descendant) => {
        invariant(/^[a-f0-9]{40}$/.test(ancestor ?? ''), 'Retained runtime source requires a full Git commit.');
        try { git(root, ['merge-base', '--is-ancestor', ancestor, descendant]); return true; }
        catch { return false; }
      } });
  }
  const key = hashIdentity({ target: target.id, runtime });
  const baselineObservation = sourceOnly ? actualNative : original || native.observation;
  const binding = immutable({ schemaVersion: 1, kind: 'expo-ota-runtime-binding', planDigest: plan.digest, target: target.id, nativeTarget: native.id,
    source: plan.source.commit, profile: plan.profile, platform: target.platform, channel: target.channel, environment: target.environment,
    origin: sourceOnly ? 'source-validated' : usePrepared ? 'prepared-native' : 'retained-native', baselineIdentity: original ? hashIdentity(original) : null,
    key, directory: `runtime-${key}`, runtime, version: baselineObservation.version || runtime,
    versionCode: baselineObservation.versionCode || Number(target.platform === 'android' ? runtimeOverrides.androidVersionCode : runtimeOverrides.iosBuildNumber) || null,
    fingerprint: actual.fingerprint, environmentHash: environment.hash, nativeEnvironmentHash: sourceOnly ? null : baselineObservation.environmentHash ?? null, runtimeOverrides,
    expoConfig: actual.expoConfig || actualNative.expoConfig || {}, baselineSource: original ? original.source || original.commit : plan.source.commit,
    observation: actual, nativeObservation: actualNative });
  return verifyOtaBinding({ plan, component: target, binding });
}

/** Resolve every compatible nonretired runtime, retaining explicit skip evidence when no runtime supports this export. */
export async function resolveOtaBindings(args) {
  const { plan, root, inputs } = args; verifyPlan(plan);
  const target = typeof args.component === 'string' ? plan.components.find(value => value.id === args.component) : args.component;
  invariant(plan.prepared && target?.selected && target.kind === 'ota' && plan.components.some(value => hashIdentity(value) === hashIdentity(target)), 'Runtime enumeration requires a selected prepared OTA target.');
  const git = args.git || sourceGit;
  invariant(git(root, ['rev-parse', 'HEAD']) === plan.source.commit && !git(root, ['status', '--porcelain', '--untracked-files=no']), 'OTA enumeration requires the clean exact prepared checkout.');
  invariant(inputs.expo && hashIdentity(inputs.expo) === hashIdentity(plan.providerConfiguration.expo), 'Approved runtime project differs from the sealed provider identity.');
  const native = plan.components.find(value => value.id === target.nativeTarget);
  invariant(native, 'OTA native target is missing.');
  const fingerprintOnly = fingerprintCompatibility(native);
  const environment = inputs.components?.[target.id] || inputs;
  invariant(environment && !environment.deferred && /^[a-f0-9]{64}$/.test(environment.hash ?? ''), 'Resolve the approved OTA environment before enumerating runtimes.');
  const retired = retirementPolicy(plan, root); const candidates = new Map(); const skipped = []; const bindings = [];
  if (target.runtimeBinding === 'source') return immutable({ schemaVersion: 1, kind: 'expo-ota-runtime-bindings', planDigest: plan.digest, target: target.id,
    bindings: [await resolveOtaBinding(args)], skipped, noCompatibleRuntime: false });
  for (const baseline of runtimeHistory(plan, native)) {
    const runtime = baseline.runtime || baseline.runtimeVersion;
    invariant(runtime && baseline.fingerprint && (baseline.environmentHash || fingerprintOnly && runtime === baseline.fingerprint), 'Retained runtime lacks full native compatibility evidence.');
    const previous = candidates.get(runtime);
    invariant(!previous || previous.fingerprint === baseline.fingerprint && previous.environmentHash === baseline.environmentHash,
      'One runtime has conflicting native fingerprints/environment; reconcile or retire it.');
    if (!previous) candidates.set(runtime, baseline);
  }
  if (native.selected) bindings.push(await resolveOtaBinding({ ...args, baseline: undefined }));
  for (const [runtime, baseline] of candidates) {
    if (bindings.some(binding => binding.runtime === runtime)) {
      const current = bindings.find(binding => binding.runtime === runtime);
      invariant(current.fingerprint === baseline.fingerprint && current.environmentHash === baseline.environmentHash, 'Prepared runtime conflicts with its original native proof.');
      continue;
    }
    const compatibility = baseline.compatibilityIdentity;
    let reason;
    if (retired.some(value => value.platform === target.platform && value.profile === plan.profile && value.runtimeVersion === runtime)) reason = 'retired';
    else if (!fingerprintOnly && baseline.environmentHash !== environment.hash) reason = 'environment-changed';
    else if (compatibility && native.observation.compatibilityIdentity && compatibility !== native.observation.compatibilityIdentity) reason = 'native-inputs-changed';
    else if (native.runtimePolicy === 'fingerprint' && baseline.fingerprint !== native.observation.fingerprint) reason = 'native-inputs-changed';
    if (reason) { skipped.push({ runtime, reason }); continue; }
    bindings.push(await resolveOtaBinding({ ...args, baseline }));
  }
  if (!candidates.size && !native.selected) skipped.push({ runtime: null, reason: 'no-native-baseline' });
  return immutable({ schemaVersion: 1, kind: 'expo-ota-runtime-bindings', planDigest: plan.digest, target: target.id,
    bindings, skipped, noCompatibleRuntime: bindings.length === 0 });
}
