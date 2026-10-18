/** @file Verifies per-platform OTA runtime binding, unchanged appVersion overlays, fingerprint runtimes, retirement and exact baseline evidence. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import { createPlan, hashIdentity } from '../packages/release-engine/index.mjs';
import { planRelease, baselineKey, runtimeBaselineKey } from '../src/planner.mjs';
import { resolveOtaBinding, resolveOtaBindings, verifyOtaBinding } from '../src/ota-runtime.mjs';

function fixture(t, { selectedNative = false, policy = 'appVersion' } = {}) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'ota-runtime-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = { repository: 'fixture/app', commit: 'a'.repeat(40), workflowCommit: 'b'.repeat(40), toolkitCommit: 'c'.repeat(40) };
  const expo = { projectId: '11111111-1111-4111-8111-111111111111', owner: 'fixture', slug: 'app', serverUrl: 'https://app.invalid' };
  const config = { schemaVersion: 1, repository: source.repository, defaultBranch: 'main', defaultProfile: 'production', expo,
    profiles: { production: { channel: 'production', environment: 'production', easProfile: 'production', distribution: 'store', submit: true } },
    components: [{ id: 'ios', kind: 'native', platform: 'ios', builder: 'eas', appDirectory: '.', applicationId: 'app.fixture', runtimePolicy: policy },
      { id: 'ios.ota', kind: 'ota', nativeTarget: 'ios', platform: 'ios', appDirectory: '.' }], policy: { runtimeSupportFile: 'runtime-policy.json' } };
  fs.writeFileSync(path.join(root, 'runtime-policy.json'), JSON.stringify({ schema: 1, retiredRuntimes: [] }));
  const environmentHash = 'e'.repeat(64);
  const runtime = policy === 'fingerprint' ? 'd'.repeat(40) : selectedNative ? '1.2.4' : '1.2.2';
  const observation = { id: 'ios', identity: 'native', compatibilityIdentity: 'normalized', runtime, fingerprint: 'd'.repeat(40), environmentHash,
    version: selectedNative ? '1.2.4' : '1.2.2', versionCode: selectedNative ? 8 : 6,
    releaseMetadata: { version: '1.2.2', androidVersionCode: 7, iosBuildNumber: '6', expoProjectId: expo.projectId, serverUrl: expo.serverUrl } };
  const ota = { ...observation, id: 'ios.ota', identity: 'bundle', compatibilityIdentity: undefined };
  delete ota.compatibilityIdentity;
  const native = { ...config.profiles.production, ...config.components[0], profile: 'production' };
  const previous = { ...observation, source: 'f'.repeat(40), identity: hashIdentity({ identity: 'normalized', environment: environmentHash }) };
  const baseline = { components: { [baselineKey(native, 'production')]: previous },
    runtimes: { [runtimeBaselineKey(native, 'production', runtime)]: previous }, reservations: { native: { version: '1.2.4', codes: { android: 9, ios: 6 } } } };
  const { schemaVersion, kind, digest, ...payload } = planRelease({ config, source, origin: { kind: 'github', runId: '123', runAttempt: 1 },
    observations: [selectedNative ? { ...observation, compatibilityIdentity: 'changed' } : observation, ota], baseline });
  const plan = createPlan({ ...payload, prepared: true, providerConfiguration: { expo, destinations: {} } });
  const calls = [];
  const args = { plan, component: 'ios.ota', root, inputs: { expo, hash: environmentHash, environment: {} },
    git: (directory, argv) => { calls.push(argv); return argv[0] === 'rev-parse' ? source.commit : ''; },
    inspect: (configuration, options) => { calls.push(options); return [observation, ota]; } };
  return { args, calls, previous, observation, ota, native };
}

test('unchanged appVersion platform uses original version overlay without changing reservations', async t => {
  const { args, calls } = fixture(t); const before = JSON.stringify(args.plan);
  const binding = await resolveOtaBinding(args);
  assert.equal(binding.origin, 'retained-native'); assert.equal(binding.runtime, '1.2.2');
  assert.deepEqual(binding.runtimeOverrides, { version: '1.2.2', androidVersionCode: 7, iosBuildNumber: '6' });
  assert.deepEqual(calls.find(value => value.runtimeOverrides)?.runtimeOverrides, binding.runtimeOverrides);
  assert.equal(JSON.stringify(args.plan), before); assert.ok(Object.isFrozen(binding));
  assert.ok(calls.some(value => Array.isArray(value) && value[0] === 'merge-base'));
});

test('selected native runtime uses prepared full fingerprint with no historical version overlay', async t => {
  const { args } = fixture(t, { selectedNative: true });
  const binding = await resolveOtaBinding(args); assert.equal(binding.origin, 'prepared-native');
  assert.equal(binding.runtime, '1.2.4'); assert.deepEqual(binding.runtimeOverrides, {});
});

test('fingerprint runtime history requires the full current fingerprint without appVersion metadata overrides', async t => {
  const { args } = fixture(t, { policy: 'fingerprint' });
  const binding = await resolveOtaBinding(args); assert.equal(binding.runtime, 'd'.repeat(40)); assert.deepEqual(binding.runtimeOverrides, {});
});

test('retired runtimes, nonancestor sources, unknown environments and changed fingerprints are blocked', async t => {
  const { args, observation, ota } = fixture(t);
  await assert.rejects(resolveOtaBinding({ ...args, inputs: { ...args.inputs, hash: null, deferred: true } }), /approved OTA environment/);
  await assert.rejects(resolveOtaBinding({ ...args, git: (root, argv) => { if (argv[0] === 'merge-base') throw new Error('not ancestor'); return args.git(root, argv); } }), /ancestor/);
  await assert.rejects(resolveOtaBinding({ ...args, inspect: () => [{ ...observation, fingerprint: 'changed' }, { ...ota, fingerprint: 'changed' }] }), /fingerprint/);
  fs.writeFileSync(path.join(args.root, 'runtime-policy.json'), JSON.stringify({ schema: 1, retiredRuntimes: [{ profile: 'production', platform: 'ios', runtimeVersion: '1.2.2' }] }));
  await assert.rejects(resolveOtaBinding(args), /retired/);
});

test('optional historical baseline must belong to the exact target history and preserve project/server identity', async t => {
  const { args, previous, native } = fixture(t);
  await assert.rejects(resolveOtaBinding({ ...args, baseline: { ...previous, runtime: 'invented' } }), /target history/);
  assert.equal((await resolveOtaBinding({ ...args, baseline: previous })).baselineIdentity, hashIdentity(previous));
  const bad = { ...previous, releaseMetadata: { ...previous.releaseMetadata, serverUrl: 'https://other.invalid' } };
  const { schemaVersion, kind, digest, ...payload } = args.plan;
  const plan = createPlan({ ...payload, baseline: { ...args.plan.baseline, components: { [baselineKey(native, 'production')]: bad } } });
  await assert.rejects(resolveOtaBinding({ ...args, plan }), /server origin/);
});

test('export input changes and a different checkout cannot reuse a runtime proof', async t => {
  const { args, observation, ota } = fixture(t);
  await assert.rejects(resolveOtaBinding({ ...args, inspect: () => [observation, { ...ota, identity: 'changed' }] }), /planned source inputs/);
  await assert.rejects(resolveOtaBinding({ ...args, git: () => 'other' }), /clean exact prepared/);
  await assert.rejects(resolveOtaBinding({ ...args, inputs: { ...args.inputs, hash: 'f'.repeat(64) } }), /approved environment/);
});

test('runtime enumeration preserves multiple compatible versions and explicit retirement evidence', async t => {
  const { args, previous, native, observation, ota } = fixture(t);
  const older = { ...previous, runtime: '1.2.1', version: '1.2.1', versionCode: 5, fingerprint: '9'.repeat(40),
    releaseMetadata: { ...previous.releaseMetadata, version: '1.2.1', iosBuildNumber: '5' } };
  const { schemaVersion, kind, digest, ...payload } = args.plan;
  const plan = createPlan({ ...payload, baseline: { ...args.plan.baseline, runtimes: { ...args.plan.baseline.runtimes,
    [runtimeBaselineKey(native, 'production', older.runtime)]: older } } });
  const inspect = (config, options) => options.runtimeOverrides.version === '1.2.1' ? [
    { ...observation, runtime: older.runtime, fingerprint: older.fingerprint, version: older.version, versionCode: 5 },
    { ...ota, runtime: older.runtime, fingerprint: older.fingerprint } ] : [observation, ota];
  const result = await resolveOtaBindings({ ...args, plan, inspect });
  assert.deepEqual(result.bindings.map(value => value.runtime), ['1.2.2', '1.2.1']); assert.equal(result.noCompatibleRuntime, false);
  for (const binding of result.bindings) assert.equal(verifyOtaBinding({ plan, component: 'ios.ota', binding }).key, binding.key);
  const binding = result.bindings[0];
  assert.throws(() => verifyOtaBinding({ plan, component: 'ios.ota', binding: { ...binding, directory: '../escape' } }), /binding differs/);
  fs.writeFileSync(path.join(args.root, 'runtime-policy.json'), JSON.stringify({ schema: 1, retiredRuntimes: [{ profile: 'production', platform: 'ios', runtimeVersion: '1.2.1' }] }));
  const retired = await resolveOtaBindings({ ...args, plan, inspect });
  assert.deepEqual(retired.bindings.map(value => value.runtime), ['1.2.2']); assert.deepEqual(retired.skipped, [{ runtime: '1.2.1', reason: 'retired' }]);
});

test('no compatible runtimes is explicit evidence and conflicting runtime histories fail closed', async t => {
  const { args, previous, native } = fixture(t);
  const result = await resolveOtaBindings({ ...args, inputs: { ...args.inputs, hash: '8'.repeat(64) } });
  assert.equal(result.noCompatibleRuntime, true); assert.deepEqual(result.bindings, []);
  assert.deepEqual(result.skipped, [{ runtime: '1.2.2', reason: 'environment-changed' }]);
  const { schemaVersion, kind, digest, ...payload } = args.plan;
  const plan = createPlan({ ...payload, baseline: { ...args.plan.baseline, runtimes: {
    [runtimeBaselineKey(native, 'production', previous.runtime)]: { ...previous, fingerprint: 'changed' } } } });
  await assert.rejects(resolveOtaBindings({ ...args, plan }), /conflicting/);
});

test('explicit fingerprint compatibility preserves separate OTA and native environments while requiring identical full runtimes', async t => {
  const { args, observation, ota } = fixture(t, { policy: 'fingerprint' });
  const { schemaVersion, kind, digest, ...payload } = args.plan;
  const plan = createPlan({ ...payload, components: args.plan.components.map(value => value.id === 'ios' ? { ...value, runtimeCompatibility: 'fingerprint' } : value) });
  const hash = '7'.repeat(64);
  const input = { ...args, plan, inputs: { ...args.inputs, hash }, inspect: () => [{ ...observation, environmentHash: hash }, { ...ota, environmentHash: hash }] };
  const result = await resolveOtaBindings(input);
  assert.equal(result.bindings[0].environmentHash, hash); assert.equal(result.bindings[0].nativeEnvironmentHash, observation.environmentHash);
  assert.equal(result.bindings[0].runtime, result.bindings[0].fingerprint);
  await assert.rejects(resolveOtaBindings({ ...input, inspect: () => [{ ...observation, environmentHash: hash, fingerprint: 'changed' }, { ...ota, environmentHash: hash, fingerprint: 'changed' }] }), /fingerprint/);
  const invalid = createPlan({ ...payload, components: args.plan.components.map(value => value.id === 'ios' ? { ...value, runtimePolicy: 'appVersion', runtimeCompatibility: 'fingerprint' } : value) });
  await assert.rejects(resolveOtaBindings({ ...input, plan: invalid }), /requires fingerprint runtime/);
});

test('explicit source binding verifies the actual export without claiming installed-native compatibility', async t => {
  const { args, observation, ota } = fixture(t, { policy: 'fingerprint' });
  const { schemaVersion, kind, digest, ...payload } = args.plan;
  const plan = createPlan({ ...payload, components: args.plan.components.map(value => value.id === 'ios.ota' ? {
    ...value, runtimeBinding: 'source', observation: { ...value.observation, environmentHash: null } } : value) });
  const runtime = '6'.repeat(40); const hash = '7'.repeat(64);
  const result = await resolveOtaBindings({ ...args, plan, inputs: { ...args.inputs, hash },
    inspect: () => [{ ...observation, runtime, fingerprint: runtime, environmentHash: hash }, { ...ota, runtime, fingerprint: runtime, environmentHash: hash }] });
  const binding = result.bindings[0];
  assert.equal(binding.origin, 'source-validated'); assert.equal(binding.runtime, runtime);
  assert.equal(binding.nativeEnvironmentHash, null); assert.equal(binding.baselineIdentity, null);
  assert.throws(() => verifyOtaBinding({ plan: args.plan, component: 'ios.ota', binding: { ...binding, planDigest: args.plan.digest } }), /binding differs/);
  assert.throws(() => verifyOtaBinding({ plan, component: 'ios.ota', binding: { ...binding, origin: 'retained-native' } }), /binding differs/);
});
