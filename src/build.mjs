/** @file Source-only artifact construction and credential-free prebuild, with signing admitted only for the prepared compilation phase. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { invariant, hashIdentity } from '../packages/release-engine/index.mjs';
import { repositoryPath } from './config.mjs';
import { runHook, sourceEnvironment } from './hooks.mjs';
import { sourceGit, inspectSource } from './source.mjs';
import { createArtifactReceipt, saveArtifactReceipt } from './artifacts.mjs';
import { inspectOciArchive } from './providers/ghcr.mjs';
import { exportOta } from './ota.mjs';
import { smokeImage } from './image-smoke.mjs';

/** Verify source and target before admitting source tools; the caller independently obtains the plan from its verified ledger. */
export function verifyBuildSource(plan, target, root) {
  invariant(plan.prepared && ['github', 'local'].includes(plan.origin.kind), 'Builds require a prepared plan with explicit origin.');
  invariant(sourceGit(root, ['rev-parse', 'HEAD']) === plan.source.commit, 'Build checkout differs from the prepared source.');
  invariant(!sourceGit(root, ['status', '--porcelain', '--untracked-files=no']), 'Build checkout has tracked changes.');
  const component = plan.components.find(value => value.id === target && value.selected);
  invariant(component, 'Artifact target is not selected.');
  return component;
}

/** Materialize only configured Android signing values, after prebuild; cleanup remains the caller's responsibility. */
export function signingInputs(component, directory, environment) {
  const mapping = component.signing?.variables;
  if (!mapping) return { environment: {}, dispose() {} };
  invariant(component.builder === 'command' && component.platform === 'android', 'Only command Android builders accept local signing material.');
  invariant(['file', 'storePassword', 'alias', 'keyPassword'].every(key => /^[A-Z][A-Z0-9_]*$/.test(mapping[key] ?? '')), 'Incomplete application signing variable mapping.');
  const bytes = Buffer.from(environment.ANDROID_KEYSTORE_BASE64 ?? '', 'base64');
  invariant(bytes.length > 128 && bytes.length < 1024 * 1024 && environment.ANDROID_STORE_PASSWORD
    && environment.ANDROID_KEY_ALIAS && environment.ANDROID_KEY_PASSWORD, 'Android signing environment is not configured.');
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'android-upload.keystore');
  invariant(!fs.existsSync(file), 'Signing workspace must be fresh.');
  fs.writeFileSync(file, bytes, { mode: 0o600 });
  return { environment: { [mapping.file]: file, [mapping.storePassword]: environment.ANDROID_STORE_PASSWORD,
    [mapping.alias]: environment.ANDROID_KEY_ALIAS, [mapping.keyPassword]: environment.ANDROID_KEY_PASSWORD },
    dispose() { fs.rmSync(file, { force: true }); } };
}

/** Run app prebuild before any signing key exists; fingerprint runtimes must stay identical after native generation. */
export function prepareBuild({ plan, target, root, inputs }) {
  const component = verifyBuildSource(plan, target, root);
  invariant(component.kind === 'native' && (plan.origin.kind === 'local' ? component.localBuilder ?? component.builder : component.builder) === 'command', 'Prebuild requires a command native target.');
  runHook(plan.config, 'build', { plan, source: plan.source, target, phase: 'prepare', profile: plan.profile,
    environment: inputs.environment }, { root });
  const actual = inspectSource(plan.config, { root, source: plan.source, profile: plan.profile, baseline: plan.baseline,
    environment: inputs.environment, componentEnvironments: inputs.components }).find(value => value.id === target);
  if (component.runtimePolicy === 'fingerprint') invariant(actual?.runtime === component.observation.runtime, 'Native generation changed the prepared runtime.');
}

/** Build an OCI archive with no registry credentials; image execution and scanner gates remain source-only validation. */
export async function buildServer({ plan, component, root, directory, execute = execFileSync }) {
  const dockerfile = repositoryPath(root, component.dockerfile);
  const context = component.context === '.' ? root : repositoryPath(root, component.context ?? '.');
  const platforms = component.platforms ?? ['linux/amd64'];
  invariant(platforms.length && platforms.every(value => ['linux/amd64', 'linux/arm64'].includes(value)), 'Unsupported server image platform.');
  fs.mkdirSync(directory, { recursive: true });
  const archive = path.join(directory, 'image.oci.tar');
  execute('docker', ['buildx', 'build', '--file', dockerfile, '--platform', platforms.join(','), '--provenance=false', '--sbom=false',
    '--label', `org.opencontainers.image.source=https://github.com/${plan.source.repository}`, '--label', `org.opencontainers.image.revision=${plan.source.commit}`,
    '--label', `org.opencontainers.image.version=${component.observation.version}`,
    '--output', `type=oci,dest=${archive}`, context], { cwd: root, env: sourceEnvironment(), windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit'], timeout: 45 * 60 * 1000 });
  const oci = await inspectOciArchive(archive);
  invariant(JSON.stringify(oci.manifests.map(value => value.platform).sort()) === JSON.stringify([...platforms].sort()), 'Built image platform inventory differs.');
  return { directory, kind: 'server', oci, version: component.observation.version, image: component.image };
}

/** Seal only explicitly supported public artifact metadata; hook output never controls publisher commands or credentials. */
export async function sealBuild({ plan, component, artifacts, outputRoot, inputs, origin, workflowCommit, toolkitCommit }) {
  const result = [];
  for (const artifact of artifacts) {
    const target = artifact.target ?? component.id;
    const selected = plan.components.find(value => value.id === target && value.selected);
    invariant(selected && (target === component.id || selected.buildGroup && selected.buildGroup === component.buildGroup), 'Builder returned an unrelated target.');
    const directory = repositoryPath(outputRoot, `${target}/files`);
    invariant(path.resolve(artifact.directory) === directory, 'Builder output is outside its assigned artifact directory.');
    const metadata = { kind: selected.kind, expo: inputs.expo ?? plan.providerConfiguration.expo ?? null,
      destination: plan.providerConfiguration.destinations?.[target] ?? null,
      environment: inputs.components?.[target]?.environment ?? inputs.environment ?? {},
      environmentHash: inputs.components?.[target]?.hash ?? inputs.hash ?? null,
      runtime: artifact.runtime ?? selected.observation.runtime ?? null,
      version: artifact.version ?? selected.observation.version ?? null,
      versionCode: artifact.versionCode ?? selected.observation.versionCode ?? null,
      expoConfig: artifact.expoConfig ?? artifact.metadata?.expoConfig ?? selected.observation.expoConfig ?? null,
      ...(inputs.components?.[target]?.branch ? { branch: inputs.components[target].branch } : {}),
      ...(artifact.native ? { native: artifact.native } : {}), ...(artifact.oci ? { oci: artifact.oci, image: selected.image } : {}) };
    if (artifact.nativeOrigin) metadata.nativeOrigin = artifact.nativeOrigin;
    if (selected.kind === 'ota') {
      metadata.bindings = artifact.bindings;
      metadata.skipped = artifact.skipped;
      metadata.noCompatibleRuntime = artifact.noCompatibleRuntime;
    }
    const receipt = await createArtifactReceipt({ plan, target, directory, metadata, origin, workflowCommit, toolkitCommit });
    const receiptFile = repositoryPath(outputRoot, `${target}/receipt.json`);
    saveArtifactReceipt(receiptFile, receipt);
    result.push({ target, directory, receiptFile, receipt, hash: hashIdentity(receipt) });
  }
  invariant(result.length && new Set(result.map(value => value.target)).size === result.length, 'Builder returned no artifacts or duplicate targets.');
  return result;
}

/** Execute the app builder and application-specific assertions with no provider publication credentials. */
export async function buildApplication({ plan, target, root, outputRoot, inputs, origin, workflowCommit, toolkitCommit,
  signingDirectory, environment = process.env }) {
  const component = verifyBuildSource(plan, target, root);
  const outputDirectory = repositoryPath(outputRoot, `${target}/files`);
  fs.mkdirSync(outputDirectory, { recursive: true });
  let artifacts;
  if (component.kind === 'server') {
    const artifact = await buildServer({ plan, component, root, directory: outputDirectory });
    if (component.smoke) await smokeImage({ plan, component, root, artifact, environment: inputs.environment });
    else if (plan.config.hooks?.verify) {
      const checked = runHook(plan.config, 'verify', { plan, target, artifact, profile: plan.profile, environment: inputs.environment }, { root });
      invariant(checked.verified === true, 'Application image verification failed.');
    }
    artifacts = [artifact];
  }
  else if (component.kind === 'ota') {
    const exporter = plan.compatibility?.format === 'calibrate-v1-ota' ? (await import('./compat/calibrate-ota.mjs')).exportCalibrateOta : exportOta;
    artifacts = [await exporter({ plan, component, root, inputs, directory: outputDirectory })];
  } else {
    const signingComponent = plan.origin.kind === 'local' && component.localBuilder ? { ...component, builder: component.localBuilder } : component;
    const signing = component.kind === 'native' ? signingInputs(signingComponent, signingDirectory, environment) : { environment: {}, dispose() {} };
    try {
      const built = runHook(plan.config, 'build', { plan, target, source: plan.source, phase: 'compile', profile: plan.profile,
        outputDirectory, environment: { ...inputs.environment, ...signing.environment } }, { root });
      artifacts = built.artifacts ?? [built.artifact];
      invariant(artifacts.every(Boolean), 'Application builder returned no artifact.');
      for (const artifact of artifacts) {
        const verified = runHook(plan.config, 'verify', { plan, target: artifact.target ?? target, artifact,
          environment: inputs.environment, profile: plan.profile }, { root });
        invariant(verified.verified === true, 'Application artifact verification failed.');
      }
    } finally { signing.dispose(); }
    const actual = inspectSource(plan.config, { root, source: plan.source, profile: plan.profile, baseline: plan.baseline,
      environment: inputs.environment, environmentHash: inputs.hash, componentEnvironments: inputs.components });
    for (const item of artifacts) {
      const target = plan.components.find(value => value.id === (item.target ?? component.id));
      if (target.runtimePolicy === 'fingerprint') invariant(actual.find(value => value.id === target.id)?.runtime === target.observation.runtime,
        'Compilation changed the prepared native fingerprint.');
    }
  }
  verifyBuildSource(plan, target, root);
  return sealBuild({ plan, component, artifacts, outputRoot, inputs, origin, workflowCommit, toolkitCommit });
}
