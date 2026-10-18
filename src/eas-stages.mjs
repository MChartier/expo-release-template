/** @file Composes shared EAS stages from sealed plans and verified inert artifact metadata, with no publisher-side application hook execution. */
import { resolve } from 'node:path';
import { hashIdentity, invariant, verifyPlan } from '../packages/release-engine/index.mjs';
import { isVerifiedSourceProof } from './artifacts.mjs';
import { repositoryPath } from './config.mjs';
import { resolveConfigurationValue, resolveExpoConfiguration } from './environment.mjs';
import { sourceEnvironment } from './hooks.mjs';
import { createEasTransport, createEasBuildProvider, createEasOtaProvider, exportPayload, preflightEasSigning } from './providers/eas.mjs';
import { createCorrectableEasSubmissionProvider } from './providers/eas-correction.mjs';
import { createEasPublisherWorkspace } from './providers/eas-workspace.mjs';

/** Project only valid native version fields from a retained baseline; never override project, signing, server or channel identity. */
export function baselineRuntimeOverrides(baseline) {
  const metadata = baseline?.releaseMetadata || baseline?.release || baseline?.legacy?.release
    || { version: baseline?.version, ...(baseline?.platform === 'android' ? { androidVersionCode: baseline.versionCode }
      : baseline?.platform === 'ios' ? { iosBuildNumber: String(baseline.versionCode) } : {}) };
  const android = metadata.androidVersionCode !== undefined; const ios = metadata.iosBuildNumber !== undefined;
  invariant(/^\d+\.\d+\.\d+$/.test(metadata.version) && (android || ios)
    && (!android || Number.isSafeInteger(metadata.androidVersionCode) && metadata.androidVersionCode > 0)
    && (!ios || /^[1-9]\d*$/.test(metadata.iosBuildNumber)), 'Retained runtime lacks its original native version metadata.');
  return { version: metadata.version, ...(android ? { androidVersionCode: metadata.androidVersionCode } : {}), ...(ios ? { iosBuildNumber: metadata.iosBuildNumber } : {}) };
}

/** Verify an overlay inspection against its retained runtime after the caller checks Git ancestry; never substitute normalized compatibility for the full fingerprint. */
export async function verifyCompatibleRuntime({ component, baseline, observation, source, isAncestor, retiredRuntimes = [], profile }) {
  const runtime = baseline.runtime || baseline.runtimeVersion;
  const fingerprintOnly = component.runtimeCompatibility === 'fingerprint';
  invariant(!fingerprintOnly || component.runtimePolicy === 'fingerprint', 'Fingerprint compatibility requires fingerprint runtime policy.');
  invariant(runtime && observation.runtime === runtime && baseline.fingerprint === observation.fingerprint
    && (fingerprintOnly ? runtime === observation.fingerprint : baseline.environmentHash === observation.environmentHash), 'Retained runtime fingerprint/environment differs from the inspected export.');
  const compatibility = baseline.compatibilityIdentity || baseline.compatibility || baseline.legacy?.compatibility;
  if (compatibility) invariant(compatibility === observation.compatibilityIdentity, 'Retained native compatibility differs.');
  invariant(!retiredRuntimes.some(item => item.platform === component.platform && item.profile === profile && item.runtimeVersion === runtime), 'Selected runtime was explicitly retired.');
  invariant(typeof isAncestor === 'function' && await isAncestor(baseline.source || baseline.commit, source), 'Retained native source is not an ancestor of the export source.');
  return { runtime, fingerprint: observation.fingerprint, environmentHash: observation.environmentHash,
    runtimeOverrides: component.runtimePolicy === 'fingerprint' || !(baseline.releaseMetadata || baseline.release || baseline.legacy?.release)
      ? {} : baselineRuntimeOverrides(baseline) };
}

function verifiedArtifact({ plan, component, artifact, sourceProof }) {
  invariant(artifact?.receipt && typeof artifact.directory === 'string'
    && isVerifiedSourceProof(sourceProof, { source: plan.source.commit, repository: plan.source.repository, target: component.id })
    && sourceProof.planDigest === plan.digest && sourceProof.manifestDigest === artifact.receipt.manifest?.digest
    && artifact.receipt.planDigest === plan.digest && artifact.receipt.target === component.id,
  'Publisher requires the exact verified hosted artifact and original producer.');
  return artifact.receipt.metadata || {};
}

/**
 * Compose build, submission or OTA providers. Publishers require artifact={directory,receipt} whose
 * verified metadata contains expo, expoConfig, destination and native evidence, or OTA branch/payload.
 * The caller owns dispose(); no application configuration is evaluated by submission/OTA workspaces.
 */
export async function createEasStage({ action, plan, component, artifact, sourceProof, environment, transport, binding, operation,
  root = process.cwd(), providerEnvironment = process.env }) {
  verifyPlan(plan);
  const target = typeof component === 'string' ? plan.components.find(value => value.id === component) : component;
  invariant(target && plan.components.some(value => value.id === target.id && value.selected && hashIdentity(value) === hashIdentity(target)), 'EAS stage target is not the sealed selected component.');
  invariant(['build', 'handoff', 'submit', 'publish'].includes(action), 'Unsupported EAS stage action.');
  const isBuild = action === 'build';
  const metadata = isBuild ? {} : verifiedArtifact({ plan, component: target, artifact, sourceProof });
  const frozen = plan.providerConfiguration;
  const expo = isBuild ? frozen?.expo || environment?.expo || resolveExpoConfiguration(plan.config, root) : frozen?.expo;
  invariant(expo?.projectId && expo.owner && expo.slug, 'Stage lacks retained Expo project identity.');
  if (!isBuild) invariant(metadata.expo && hashIdentity(metadata.expo) === hashIdentity(expo), 'Retained Expo identity differs from the sealed provider configuration.');
  const currentEnvironment = environment?.components?.[target.id] || environment;
  if (binding || metadata.bindings) {
    invariant(target.kind === 'ota' && Array.isArray(metadata.bindings) && binding
      && metadata.bindings.some(value => hashIdentity(value) === hashIdentity(binding)), 'OTA binding is not an exact member of the verified retained receipt.');
    const { verifyOtaBinding } = await import('./ota-runtime.mjs');
    verifyOtaBinding({ plan, component: target, binding });
    if (currentEnvironment) invariant(currentEnvironment.hash === binding.environmentHash, 'Approved OTA environment changed after export.');
  }
  const observed = binding || target.observation;
  const native = metadata.native || observed;
  if (!isBuild && !binding) {
    invariant(!metadata.runtime || metadata.runtime === observed.runtime, 'Retained runtime differs from the sealed target binding.');
    invariant(!metadata.native || ['runtime', 'version', 'versionCode', 'fingerprint'].every(key => observed[key] === undefined
      || String(metadata.native[key]) === String(observed[key])), 'Retained native metadata differs from the sealed target binding.');
    invariant(metadata.environmentHash === undefined || metadata.environmentHash === observed.environmentHash, 'Retained environment differs from the sealed target binding.');
  }
  const expected = {
    projectId: expo.projectId, owner: expo.owner, slug: expo.slug, repository: plan.source.repository, target: target.id,
    applicationId: target.applicationId || plan.components.find(value => value.id === target.nativeTarget)?.applicationId,
    platform: target.platform, source: plan.source.commit, profile: target.profile || plan.profile,
    version: native.version || observed.version, versionCode: native.versionCode || observed.versionCode,
    runtime: native.runtime || observed.runtime, fingerprint: native.fingerprint || observed.fingerprint,
    channel: target.channel, environment: target.environment, distribution: target.distribution,
    ...(expo.serverUrl ? { serverUrl: expo.serverUrl } : {}),
  };
  invariant(expected.applicationId && expected.runtime && ['android', 'ios'].includes(expected.platform), 'Stage lacks exact native/runtime identity.');
  if (native.projectId) invariant(native.projectId === expected.projectId && native.applicationId === expected.applicationId
    && native.platform === expected.platform && native.source === expected.source && native.channel === expected.channel
    && native.environment === expected.environment, 'Retained native identity differs from the selected plan.');
  const marker = `expo-release:${plan.runId}:${action === 'build' ? 'build' : 'ota'}:${target.id}${binding ? `:${binding.key}` : ''}`;
  const publisherEnvironment = { ...sourceEnvironment(providerEnvironment), ...(providerEnvironment.EXPO_TOKEN ? { EXPO_TOKEN: providerEnvironment.EXPO_TOKEN } : {}) };
  if (isBuild) {
    invariant(target.kind === 'native' && target.builder === 'eas', 'Selected target does not use EAS cloud builds.');
    const policy = expo.environmentPolicy || {};
    const publicInputs = { ...(currentEnvironment?.environment || {}), EXPO_NO_DOTENV: '1',
      ...(policy.channelVariable ? { [policy.channelVariable]: target.channel } : {}),
      ...(policy.platformVariable ? { [policy.platformVariable]: target.platform } : {}) };
    const env = { ...sourceEnvironment(providerEnvironment, publicInputs), ...(providerEnvironment.EXPO_TOKEN ? { EXPO_TOKEN: providerEnvironment.EXPO_TOKEN } : {}) };
    const provider = transport || createEasTransport({ cwd: target.appDirectory === '.' ? resolve(root) : repositoryPath(root, target.appDirectory), env });
    const destination = frozen?.destinations?.[target.id] || resolveConfigurationValue(target.submission || {}, root);
    const spec = { ...expected, marker };
    return { spec, provider: createEasBuildProvider(spec, provider),
      /** Check selected provider signing prerequisites before enqueueing a cloud build. */
      preflight: () => preflightEasSigning({ ...spec, submit: target.submit !== false, destination, requiredEntitlements: target.requiredEntitlements }, provider),
      /** Build stages use the existing checkout and own no temporary workspace. */
      dispose() {} };
  }
  const expoConfig = binding?.expoConfig || metadata.expoConfig;
  invariant(expoConfig && typeof expoConfig === 'object', 'Publisher requires retained public Expo configuration.');
  const destination = frozen?.destinations?.[target.id];
  if (metadata.destination) invariant(destination && hashIdentity(destination) === hashIdentity(metadata.destination), 'Retained store destination differs from the sealed plan.');
  let spec;
  if (target.kind === 'native' && ['handoff', 'submit'].includes(action)) {
    invariant(destination && (target.platform === 'android' ? destination.track && destination.releaseStatus : /^\d+$/.test(String(destination.ascAppId || ''))), 'Store destination must be resolved and retained before publishing.');
    let submissionArtifact;
    if (native.artifact?.kind === 'eas-build') {
      invariant(native.artifact.buildId === native.id && /^[a-f0-9]{64}$/.test(native.artifact.sha256), 'Missing exact EAS build artifact proof.');
      submissionArtifact = { kind: 'eas-build', buildId: native.id, sha256: native.artifact.sha256 };
    } else {
      const extension = target.platform === 'android' ? '.aab' : '.ipa';
      const files = artifact.receipt.manifest.files.filter(file => file.path.endsWith(extension));
      invariant(files.length === 1, 'Expected exactly one retained store artifact for this target.');
      submissionArtifact = { kind: 'retained-file', origin: artifact.receipt.origin, path: repositoryPath(artifact.directory, files[0].path), sha256: files[0].sha256 };
    }
    spec = { ...expected, destination, artifact: submissionArtifact, sourceProof,
      build: { ...expected, marker: `expo-release:${plan.runId}:build:${target.id}` } };
  } else {
    const retained = binding || metadata;
    invariant(target.kind === 'ota' && action === 'publish' && retained.branch?.id && retained.branch?.name && retained.payload, 'OTA publication lacks its retained destination/payload.');
    const directory = binding ? repositoryPath(artifact.directory, binding.directory) : resolve(artifact.directory);
    const payload = await exportPayload(directory, target.platform);
    invariant(hashIdentity(payload) === hashIdentity(retained.payload), 'Retained OTA bytes differ from the source export.');
    spec = { ...expected, marker, sourceProof, directory, branch: retained.branch, payload };
  }
  const workspace = createEasPublisherWorkspace({ ...spec, expoConfig }, { env: publisherEnvironment });
  try {
    const provider = transport || workspace.transport;
    return { spec, provider: target.kind === 'ota' ? createEasOtaProvider(spec, provider) : createCorrectableEasSubmissionProvider({ spec, transport: provider, operation }),
      /** Dispose only the generated data-only publisher workspace. */
      dispose: () => workspace.dispose() };
  } catch (error) { workspace.dispose(); throw error; }
}
