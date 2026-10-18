/** @file Exercises original OTA-only recovery with no native artifact, exact production baseline compatibility, and an unchanged historical ledger. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrateReader } from '../src/compat/calibrate.mjs';
import { prepareCalibrateOta, exportCalibrateOta } from '../src/compat/calibrate-ota.mjs';
import { verifyOtaExports } from '../src/ota.mjs';

const fixtures = new URL('./fixtures/calibrate-held/', import.meta.url);
const json = name => JSON.parse(fs.readFileSync(new URL(name, fixtures), 'utf8').replace(/^\uFEFF/, ''));
const runtime = '8b61a231da5765e424ce6cb65087944ddbd80d04';
const originalNative = { runtime_version: runtime, version: '0.2.8', phone_code: 15, wear_code: 16,
  source_commit: 'c'.repeat(40), wear_hash: 'd'.repeat(64) };

function fixture(channel, baseline = originalNative) {
  const release = json('release.json'); const record = JSON.parse(release.body); const originalRun = json('run.json');
  record.baseline = { reserved_native_code: 16, reserved_native_version: '0.2.8', ...(baseline ? { native: structuredClone(baseline) } : {}) };
  record.plan = { ...record.plan, server: false, native: false, reserve_native: false, native_codes: null, native_version: null,
    ota_internal: channel === 'internal', ota_production: channel === 'production', runtime_version: runtime };
  release.body = JSON.stringify(record); const originalBody = release.body;
  const assets = release.assets.filter(value => value.name.startsWith('checkpoint-prepared-')); const bytes = new Map();
  const workflow = 'a'.repeat(40);
  const config = { schemaVersion: 1, repository: record.repository, defaultBranch: 'master', defaultProfile: 'production',
    profiles: { production: { channel: 'production', environment: 'production' } }, github: { handlerWorkflow: 'release-handler.yml' },
    expo: { projectId: 'fda8f8c5-e646-47ac-82fb-35003c9cbec7', owner: 'calibrate-health', slug: 'calibrate-health-app' },
    components: [{ id: 'phone', kind: 'native', platform: 'android', builder: 'command', appDirectory: 'mobile',
      applicationId: 'net.darkmachines.healthtracker', runtimePolicy: 'fingerprint', runtimeCompatibility: 'fingerprint' },
    { id: `ota-${channel}`, kind: 'ota', platform: 'android', nativeTarget: 'phone', appDirectory: 'mobile', channel,
      environment: channel === 'internal' ? 'preview' : 'production', runtimeBinding: channel === 'internal' ? 'source' : 'native' }],
    legacy: { format: 'calibrate-v1', handlerWorkflow: '.github/workflows/cut-release-handler.yml', recoveryWorkflow: '.github/workflows/publish-release-handler.yml' } };
  const app = { expo: { owner: config.expo.owner, slug: config.expo.slug, android: { package: 'net.darkmachines.healthtracker' },
    extra: { eas: { projectId: config.expo.projectId } } } };
  const requests = [];
  const api = async (route, options = {}) => {
    requests.push(route); assert.equal(options.method, undefined, 'No remote mutation belongs in this fixture.');
    if (route === `/actions/runs/${record.run_id}`) return originalRun;
    if (route === '/actions/runs/999') return { repository: { full_name: record.repository }, head_branch: 'master', head_sha: workflow,
      path: '.github/workflows/release-handler.yml', event: 'workflow_run', run_attempt: 1 };
    if (route.startsWith('/contents/')) {
      assert.ok(route.endsWith('?ref=3dfb97c064c55cb55b514415618220f03dce91f1'));
      const value = route.startsWith('/contents/mobile/app.json?') ? app : route.startsWith('/contents/shared/release.json?')
        ? { android: { mobile: { version_name: '0.2.8', version_code: 15 } } } : assert.fail(`Unexpected content ${route}`);
      return { type: 'file', encoding: 'base64', size: 1000, content: Buffer.from(JSON.stringify(value)).toString('base64') };
    }
    const asset = assets.find(value => route === `/releases/assets/${value.id}`); assert.ok(asset, `Unexpected ${route}`);
    return bytes.get(asset.id) ?? fs.readFileSync(new URL(asset.name, fixtures));
  };
  const ledger = { config, api, workflowCommit: workflow, origin: { kind: 'github', runId: '999', runAttempt: 1 },
    read: async () => calibrateReader.read({ release, record, assets, api, config }),
    async upload(_id, name, data) {
      const asset = { id: Math.max(...assets.map(value => value.id)) + 1, name, size: data.length, uploader: { login: 'github-actions[bot]' } };
      assets.push(asset); bytes.set(asset.id, data); return asset;
    } };
  const prepare = async () => prepareCalibrateOta({ ledger, state: await ledger.read(), target: `ota-${channel}`, toolkitCommit: 'b'.repeat(40),
    verifyNative: async () => assert.fail('OTA-only recovery must not require a build in this original release.') });
  return { ledger, prepare, config, record, release, originalBody, app, requests, assets };
}

function exportFixture(t, value, plan, inspectedRuntime = runtime, ancestor = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'original-ota-only-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const component = plan.components.find(value => value.selected);
  return { plan, component, root, directory: root,
    inputs: { expo: value.config.expo, hash: 'e'.repeat(64), environment: {}, branch: { id: 'branch', name: component.channel } },
    inspect: () => ({ runtime: inspectedRuntime, expoConfig: value.app.expo,
      resolution: { fingerprintSources: [{ id: 'expoAutolinkingConfig:android', contents: JSON.stringify({ modules: [{ packageName: 'expo-updates' }, { packageName: '@calibrate/wear-pairing' }] }) },
        { id: 'rncoreAutolinkingConfig:android', contents: JSON.stringify({ 'react-native-health-connect': {} }) }] } }),
    exportSource: ({ outputDirectory }) => {
      fs.writeFileSync(path.join(outputDirectory, 'main.js'), 'inert fixture bundle');
      fs.writeFileSync(path.join(outputDirectory, 'metadata.json'), JSON.stringify({ fileMetadata: { android: { bundle: 'main.js', assets: [] } } }));
    },
    git: (_root, args) => { if (args[0] === 'merge-base' && !ancestor) throw new Error('Not an ancestor'); return args[0] === 'rev-parse' ? plan.source.commit : ''; } };
}

test('original internal OTA-only source continuation needs no native artifact or invented baseline', async t => {
  const value = fixture('internal', null); const before = await value.ledger.read(); const plan = await value.prepare();
  assert.equal(before.nativeMetadata, null); assert.deepEqual(plan.baseline.components, {});
  assert.deepEqual(plan.reservations, before.baseline.reservations); assert.equal(plan.source.commit, before.origin.sourceCommit);
  assert.equal((await value.prepare()).digest, plan.digest); assert.equal(value.assets.length, 2);
  const args = exportFixture(t, value, plan, 'f'.repeat(40)); const artifact = await exportCalibrateOta(args);
  assert.equal(artifact.bindings[0].origin, 'source-validated'); assert.equal(artifact.bindings[0].runtime, 'f'.repeat(40));
  assert.equal(artifact.bindings[0].version, '0.2.8'); assert.equal(artifact.bindings[0].baselineIdentity, null);
  await verifyOtaExports({ plan, component: args.component, directory: args.root, metadata: artifact });
  assert.equal(value.release.body, value.originalBody); assert.equal((await value.ledger.read()).nativeMetadata, null);
});

test('original production OTA-only source binds the captured native runtime, version and source ancestry', async t => {
  const value = fixture('production'); const plan = await value.prepare();
  const retained = Object.values(plan.baseline.components)[0];
  assert.equal(retained.source, originalNative.source_commit); assert.equal(retained.origin, undefined);
  assert.deepEqual(retained.legacy.original, originalNative);
  await assert.rejects(exportCalibrateOta(exportFixture(t, value, plan, 'f'.repeat(40))), /fingerprint\/environment differs/);
  await assert.rejects(exportCalibrateOta(exportFixture(t, value, plan, runtime, false)), /not an ancestor/);
  const args = exportFixture(t, value, plan); const artifact = await exportCalibrateOta(args);
  assert.equal(artifact.bindings[0].origin, 'retained-native'); assert.equal(artifact.bindings[0].runtime, originalNative.runtime_version);
  assert.equal(artifact.bindings[0].baselineSource, originalNative.source_commit); assert.equal(artifact.bindings[0].versionCode, 15);
  await verifyOtaExports({ plan, component: args.component, directory: args.root, metadata: artifact });
  assert.equal(value.release.body, value.originalBody);
});

test('production cannot invent a missing baseline or weaken captured native identity', async () => {
  for (const baseline of [null, { ...originalNative, runtime_version: 'f'.repeat(40) }, { ...originalNative, phone_code: 17 },
    { ...originalNative, source_commit: 'not-a-sha' }]) {
    const value = fixture('production', baseline); await assert.rejects(value.prepare(), /exact captured native/); assert.equal(value.assets.length, 1);
  }
  const identity = fixture('internal', null); identity.app.expo.android.package = 'wrong.application';
  await assert.rejects(identity.prepare(), /original OTA application identity/); assert.equal(identity.assets.length, 1);
  const policy = fixture('production'); policy.config.components[1].runtimeBinding = 'source';
  await assert.rejects(policy.prepare(), /runtime policy/); assert.equal(policy.assets.length, 1);
});
