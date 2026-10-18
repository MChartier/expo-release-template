/** @file Shared OTA export enumeration and per-runtime publication; successful suboperations survive partial failures. */
import fs from 'node:fs';
import path from 'node:path';
import { invariant, hashIdentity } from '../packages/release-engine/index.mjs';
import { repositoryPath } from './config.mjs';
import { resolveOtaBindings, verifyOtaBinding } from './ota-runtime.mjs';
import { exportPayload } from './providers/eas.mjs';
import { runHook } from './hooks.mjs';
import { createEasStage } from './eas-stages.mjs';
import { stageContext, completeStage, runProviderStage } from './stages.mjs';

/** Export every supported runtime using source-only hooks and the exact approved public environment. */
export async function exportOta({ plan, component, root, inputs, directory,
  resolveBindings = resolveOtaBindings, hook = runHook }) {
  const resolution = await resolveBindings({ plan, component, root, inputs });
  const environment = inputs.components?.[component.id] ?? inputs;
  invariant(resolution.noCompatibleRuntime || environment.branch?.id && environment.branch?.name, 'OTA export requires a resolved channel branch.');
  const bindings = [];
  for (const binding of resolution.bindings) {
    const outputDirectory = repositoryPath(directory, binding.directory);
    fs.mkdirSync(outputDirectory, { recursive: true });
    const result = hook(plan.config, 'build', { plan, source: plan.source, target: component.id, phase: 'export',
      profile: plan.profile, runtimeOverrides: binding.runtimeOverrides, binding,
      environment: environment.environment, outputDirectory }, { root });
    const artifact = result.artifact;
    invariant(artifact && path.resolve(artifact.directory) === outputDirectory && artifact.runtime === binding.runtime,
      'OTA hook export differs from its resolved runtime or assigned directory.');
    const expoConfig = artifact.expoConfig ?? artifact.metadata?.expoConfig;
    invariant(!expoConfig || hashIdentity(expoConfig) === hashIdentity(binding.expoConfig), 'Exported public Expo configuration differs from runtime inspection.');
    const checked = hook(plan.config, 'verify', { plan, target: component.id, artifact, binding,
      source: plan.source, runtimeOverrides: binding.runtimeOverrides, environment: environment.environment, profile: plan.profile }, { root });
    invariant(checked.verified === true, 'Application OTA artifact verification failed.');
    bindings.push({ ...binding, branch: environment.branch, payload: await exportPayload(outputDirectory, component.platform) });
  }
  const evidence = { ...resolution, bindings };
  fs.writeFileSync(path.join(directory, 'runtime-bindings.json'), `${JSON.stringify(evidence, null, 2)}\n`);
  return { directory, kind: 'ota', bindings, skipped: resolution.skipped, noCompatibleRuntime: resolution.noCompatibleRuntime };
}

/** Independently validate all export payloads before signing and again before publication. */
export async function verifyOtaExports({ plan, component, directory, metadata }) {
  invariant(Array.isArray(metadata.bindings) && Array.isArray(metadata.skipped)
    && metadata.noCompatibleRuntime === (metadata.bindings.length === 0), 'Invalid retained runtime inventory.');
  const evidence = JSON.parse(fs.readFileSync(repositoryPath(directory, 'runtime-bindings.json'), 'utf8'));
  invariant(evidence.schemaVersion === 1 && evidence.kind === 'expo-ota-runtime-bindings' && evidence.planDigest === plan.digest
    && evidence.target === component.id && hashIdentity(evidence.bindings) === hashIdentity(metadata.bindings)
    && hashIdentity(evidence.skipped) === hashIdentity(metadata.skipped) && evidence.noCompatibleRuntime === metadata.noCompatibleRuntime,
  'Retained runtime inventory differs from its receipt.');
  invariant(new Set(metadata.bindings.map(binding => binding.key)).size === metadata.bindings.length, 'Duplicate retained runtime binding.');
  for (const binding of metadata.bindings) {
    verifyOtaBinding({ plan, component, binding });
    invariant(binding.branch?.id && binding.branch?.name && hashIdentity(binding.payload)
      === hashIdentity(await exportPayload(repositoryPath(directory, binding.directory), component.platform)), 'Retained runtime bytes differ from export evidence.');
  }
  return true;
}

/** Publish each retained runtime independently, then complete the canonical stage only after every binding succeeds. */
export async function publishOta({ ledger, releaseId, plan, component, artifact, providerEnvironment, retry = false, retryStage,
  stageFactory = createEasStage, verify = verifyOtaExports, run = runProviderStage }) {
  const context = await stageContext(ledger, releaseId, component.id, 'publish');
  if (context.complete) return;
  await verify({ plan, component, directory: artifact.directory, metadata: artifact.receipt.metadata });
  const { bindings, skipped, noCompatibleRuntime } = artifact.receipt.metadata;
  const publications = [];
  for (const binding of bindings) {
    const built = await stageFactory({ action: 'publish', plan, component, artifact,
      sourceProof: artifact.sourceProof, binding, providerEnvironment });
    try {
      const operation = await run({ ledger, releaseId, target: component.id, action: 'publish', binding, provider: built.provider,
        retry: retryStage ? retryStage === `${component.id}:publish:runtime-${binding.key}` : retry });
      invariant(operation.status === 'complete', 'Runtime publication is not complete.');
      publications.push({ binding: binding.key, runtime: binding.runtime, operationId: operation.operationId, receipt: operation.receipt });
    } finally { built.dispose?.(); }
  }
  return completeStage({ ledger, releaseId, target: component.id, action: 'publish', receipt: {
    outcome: noCompatibleRuntime ? 'skipped' : 'published', publications, skipped, manifest: artifact.receipt.manifest.digest } });
}
