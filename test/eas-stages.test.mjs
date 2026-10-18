/** @file Verifies EAS stage composition uses sealed destinations, branded retained artifacts and exact runtime metadata rather than consumer source at publication. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { createPlan, hashIdentity } from '../packages/release-engine/index.mjs';
import { planRelease } from '../src/planner.mjs';
import { createArtifactReceipt, verifyRetainedArtifact } from '../src/artifacts.mjs';
import { createEasStage, baselineRuntimeOverrides, verifyCompatibleRuntime } from '../src/eas-stages.mjs';
import { exportPayload } from '../src/providers/eas.mjs';

const projectId = '00000000-0000-4000-8000-000000000000';
const source = { repository: 'fixture/app', commit: 'a'.repeat(40), workflowCommit: 'b'.repeat(40), toolkitCommit: 'c'.repeat(40) };
const origin = { kind: 'github', runId: '123', runAttempt: 1 };
const expo = { projectId, owner: 'fixture', slug: 'app', serverUrl: 'https://fixture.invalid' };
function fixture() {
  const config = { schemaVersion: 1, repository: source.repository, defaultBranch: 'main', defaultProfile: 'production', expo,
    profiles: { production: { channel: 'production', environment: 'production', easProfile: 'production', distribution: 'store', submit: true } },
    components: [ { id: 'android', kind: 'native', platform: 'android', builder: 'eas', appDirectory: 'apps/mobile', applicationId: 'app.fixture', submission: { track: 'internal', releaseStatus: 'draft' } },
      { id: 'android.ota', kind: 'ota', platform: 'android', nativeTarget: 'android', appDirectory: 'apps/mobile' } ] };
  const observations = config.components.map(component => ({ id: component.id, identity: component.id, version: '1.2.3', versionCode: 7, runtime: '1.2.3', fingerprint: 'd'.repeat(40), environmentHash: 'e'.repeat(64) }));
  const { schemaVersion, kind, digest, ...payload } = planRelease({ config, source, origin, observations });
  const plan = createPlan({ ...payload, providerConfiguration: { expo, destinations: { android: { track: 'internal', releaseStatus: 'draft' } } } });
  return { plan, observations };
}

async function retained(plan, target, directory, metadata) {
  const receipt = await createArtifactReceipt({ plan, target, directory, metadata });
  const sourceProof = await verifyRetainedArtifact({ plan, target, directory, receipt, verifyProducer: async () => true, verifyAttestation: async () => true });
  return { artifact: { directory, receipt }, sourceProof };
}

test('cloud build stage resolves source/profile/version and requires explicit signing preflight', async () => {
  const { plan } = fixture();
  const stage = await createEasStage({ action: 'build', plan, component: 'android', environment: { expo, environment: {} }, transport: {} });
  assert.equal(stage.spec.source, source.commit); assert.equal(stage.spec.profile, 'production'); assert.equal(stage.spec.runtime, '1.2.3');
  assert.equal(stage.spec.marker, 'expo-release:123:build:android'); assert.equal(typeof stage.preflight, 'function'); stage.dispose();
});

test('submission consumes exact retained bytes and rejects forged proofs or changed destinations', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'release-stage-'));
  try {
    writeFileSync(resolve(directory, 'app.aab'), 'signed fixture');
    const { plan } = fixture(); const metadata = { expo, expoConfig: { extra: { eas: { projectId } } }, destination: plan.providerConfiguration.destinations.android };
    const evidence = await retained(plan, 'android', directory, metadata);
    const stage = await createEasStage({ action: 'handoff', plan, component: 'android', ...evidence, transport: {} });
    try {
      assert.equal(stage.spec.artifact.kind, 'retained-file'); assert.deepEqual(stage.spec.artifact.origin, origin);
      assert.equal(stage.spec.artifact.path, resolve(directory, 'app.aab')); assert.deepEqual(stage.spec.destination, metadata.destination);
    } finally { stage.dispose(); }
    await assert.rejects(createEasStage({ action: 'handoff', plan, component: 'android', ...evidence, sourceProof: structuredClone(evidence.sourceProof), transport: {} }), /verified hosted/);
    const changed = await retained(plan, 'android', directory, { ...metadata, destination: { track: 'production', releaseStatus: 'completed' } });
    await assert.rejects(createEasStage({ action: 'handoff', plan, component: 'android', ...changed, transport: {} }), /destination differs/);
    const changedProject = await retained(plan, 'android', directory, { ...metadata, expo: { ...expo, slug: 'other' } });
    await assert.rejects(createEasStage({ action: 'handoff', plan, component: 'android', ...changedProject, transport: {} }), /Expo identity/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('OTA stage rehashes its retained export and does not need an application checkout', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'release-ota-stage-'));
  try {
    mkdirSync(resolve(directory, 'assets')); writeFileSync(resolve(directory, 'bundle.hbc'), 'bundle');
    writeFileSync(resolve(directory, 'metadata.json'), JSON.stringify({ fileMetadata: { android: { bundle: 'bundle.hbc', assets: [] } } }));
    const { plan } = fixture(); const metadata = { expo, expoConfig: { extra: { eas: { projectId } } }, branch: { id: 'branch', name: 'production' }, payload: await exportPayload(directory, 'android') };
    const evidence = await retained(plan, 'android.ota', directory, metadata);
    const stage = await createEasStage({ action: 'publish', plan, component: 'android.ota', ...evidence, root: resolve(directory, 'absent-source'), transport: {} });
    assert.equal(stage.spec.marker, 'expo-release:123:ota:android.ota'); assert.deepEqual(stage.spec.payload, metadata.payload); stage.dispose();
    writeFileSync(resolve(directory, 'bundle.hbc'), 'changed');
    await assert.rejects(createEasStage({ action: 'publish', plan, component: 'android.ota', ...evidence, transport: {} }), /OTA bytes/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('retained runtime overlays preserve unchanged platform metadata and require full compatibility and ancestry', async () => {
  const baseline = { source: 'a'.repeat(40), runtime: '1.2.2', fingerprint: 'd'.repeat(40), environmentHash: 'e'.repeat(64), compatibilityIdentity: 'normalized',
    releaseMetadata: { version: '1.2.2', androidVersionCode: 6, iosBuildNumber: '5', expoProjectId: projectId, serverUrl: expo.serverUrl } };
  assert.deepEqual(baselineRuntimeOverrides(baseline), { version: '1.2.2', androidVersionCode: 6, iosBuildNumber: '5' });
  const request = { component: { platform: 'ios' }, baseline, observation: { ...baseline }, source: 'b'.repeat(40), profile: 'production', isAncestor: async () => true };
  assert.equal((await verifyCompatibleRuntime(request)).runtime, '1.2.2');
  await assert.rejects(verifyCompatibleRuntime({ ...request, observation: { ...baseline, fingerprint: 'changed' } }), /fingerprint/);
  await assert.rejects(verifyCompatibleRuntime({ ...request, isAncestor: async () => false }), /ancestor/);
  await assert.rejects(verifyCompatibleRuntime({ ...request, retiredRuntimes: [{ platform: 'ios', profile: 'production', runtimeVersion: '1.2.2' }] }), /retired/);
});

test('multi-runtime publisher verifies the whole receipt while selecting only its bound older runtime export', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'release-runtime-stage-'));
  try {
    const initial = fixture().plan; const target = initial.components.find(value => value.id === 'android');
    const baseline = { runtime: '1.2.2', version: '1.2.2', versionCode: 6, fingerprint: 'f'.repeat(40), environmentHash: 'e'.repeat(64), source: 'f'.repeat(40),
      releaseMetadata: { version: '1.2.2', androidVersionCode: 6, iosBuildNumber: '5', expoProjectId: projectId, serverUrl: expo.serverUrl } };
    const { schemaVersion, kind, digest, ...payload } = initial;
    const plan = createPlan({ ...payload, prepared: true, baseline: { components: { [target.key]: baseline } } });
    const key = hashIdentity({ target: 'android.ota', runtime: baseline.runtime });
    const exportDirectory = resolve(directory, `runtime-${key}`); mkdirSync(exportDirectory);
    writeFileSync(resolve(exportDirectory, 'bundle.hbc'), 'old runtime bundle');
    writeFileSync(resolve(exportDirectory, 'metadata.json'), JSON.stringify({ fileMetadata: { android: { bundle: 'bundle.hbc', assets: [] } } }));
    const binding = { schemaVersion: 1, kind: 'expo-ota-runtime-binding', planDigest: plan.digest, target: 'android.ota', nativeTarget: 'android',
      source: source.commit, profile: 'production', platform: 'android', channel: 'production', environment: 'production', origin: 'retained-native',
      baselineIdentity: hashIdentity(baseline), baselineSource: baseline.source, key, directory: `runtime-${key}`, runtime: baseline.runtime,
      version: baseline.version, versionCode: baseline.versionCode, fingerprint: baseline.fingerprint, environmentHash: baseline.environmentHash,
      runtimeOverrides: baselineRuntimeOverrides(baseline), expoConfig: { extra: { eas: { projectId }, serverUrl: expo.serverUrl } },
      branch: { id: 'branch', name: 'production' }, payload: await exportPayload(exportDirectory, 'android') };
    const evidence = await retained(plan, 'android.ota', directory, { expo, bindings: [binding] });
    const stage = await createEasStage({ action: 'publish', plan, component: 'android.ota', ...evidence, binding, transport: {} });
    try { assert.equal(stage.spec.runtime, '1.2.2'); assert.equal(stage.spec.directory, exportDirectory); assert.ok(stage.spec.marker.endsWith(`:${key}`)); }
    finally { stage.dispose(); }
    await assert.rejects(createEasStage({ action: 'publish', plan, component: 'android.ota', ...evidence, binding: { ...binding, runtime: '1.2.3' }, transport: {} }), /exact member/);
    const bad = { ...binding, versionCode: 99 };
    const altered = await retained(plan, 'android.ota', directory, { expo, bindings: [bad] });
    await assert.rejects(createEasStage({ action: 'publish', plan, component: 'android.ota', ...altered, binding: bad, transport: {} }), /native version/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
