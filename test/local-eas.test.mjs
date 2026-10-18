/** @file Characterizes the macOS local EAS boundary, canonical IPA receipts and rejection of credential leakage or nonlocal authority using inert provider fixtures. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { planRelease, finalizePlan } from '../src/planner.mjs';
import { buildLocalEas } from '../src/local-eas.mjs';
import { buildLocally } from '../src/local-build.mjs';
import { verifyLocalBuild } from '../src/local-submit.mjs';
import { validateConfig } from '../src/config.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-eas-'));
  const settings = fs.mkdtempSync(path.join(os.tmpdir(), 'local-eas-settings-'));
  t.after(() => fs.rmSync(settings, { recursive: true, force: true }));
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const config = { schemaVersion: 1, repository: 'fixture/app', defaultBranch: 'main', defaultProfile: 'internal',
    profiles: { internal: { easProfile: 'internal', channel: 'internal', environment: 'preview', submit: false } },
    expo: { environmentPolicy: { platformVariable: 'APP_FINGERPRINT_PLATFORM' } },
    components: [{ id: 'ios', kind: 'native', platform: 'ios', builder: 'eas', localBuilder: 'eas', runtimePolicy: 'appVersion', appDirectory: 'mobile' }] };
  const observations = [{ id: 'ios', identity: 'native-inputs', version: '1.2.3', versionCode: 4, runtime: '1.2.3', fingerprint: 'd'.repeat(40),
    environmentHash: 'e'.repeat(64), environment: { APP_CHANNEL: 'internal' } }];
  const source = { repository: config.repository, commit: 'a'.repeat(40), toolkitCommit: 'b'.repeat(40), origin: 'local' };
  const plan = planRelease({ config, source, origin: { kind: 'local' }, operation: 'build', observations });
  const prepared = finalizePlan(plan, source, observations); const calls = [];
  const environment = { EXPO_TOKEN: 'expo-sentinel', GH_TOKEN: 'github-sentinel', ANDROID_STORE_PASSWORD: 'android-sentinel', NODE_OPTIONS: '--unsafe', HOME: root,
    LOCALAPPDATA: settings, XDG_CONFIG_HOME: settings };
  const args = { plan: prepared, component: prepared.components[0], root, outputRoot: path.join(root, 'output'),
    inputs: { environment: observations[0].environment, hash: observations[0].environmentHash, components: {} }, environment,
    platform: 'darwin', verifySource: () => calls.push('source'),
    transportFactory: options => { calls.push('provider'); assert.equal(options.cwd, path.join(root, 'mobile'));
      assert.equal(options.env.EXPO_TOKEN, 'expo-sentinel'); assert.equal(options.env.APP_CHANNEL, 'internal'); assert.equal(options.env.APP_FINGERPRINT_PLATFORM, 'ios');
      for (const key of ['GH_TOKEN', 'ANDROID_STORE_PASSWORD', 'NODE_OPTIONS']) assert.equal(options.env[key], undefined);
      return { cli: async (argv, json) => { assert.equal(json, false); assert.deepEqual(argv.slice(0, 7), ['build', '--local', '--platform', 'ios', '--profile', 'internal', '--output']);
        fs.writeFileSync(argv[7], 'inert signed IPA fixture'); } }; },
    hook: (_config, action, request, options) => { calls.push('verify'); assert.equal(action, 'verify');
      for (const key of ['EXPO_TOKEN', 'GH_TOKEN', 'ANDROID_STORE_PASSWORD', 'NODE_OPTIONS']) { assert.equal(options.environment[key], undefined); assert.equal(request.environment[key], undefined); }
      assert.equal(request.artifact.nativeOrigin, 'local'); return { schemaVersion: 1, verified: true }; } };
  return { root, plan, prepared, observations, environment, args, calls };
}

test('only the fixed local iOS EAS invocation receives Expo auth; source verification and canonical receipts remain local', async t => {
  const f = fixture(t); const original = structuredClone(f.plan);
  const result = await buildLocally({ plan: f.plan, root: f.root, environment: f.environment,
    git: (_root, args) => args[0] === 'rev-parse' ? f.plan.source.commit : '', inspect: (_config, request) => {
      assert.equal(request.environment.EXPO_TOKEN, undefined); return f.observations;
    }, prepare: () => { throw Error('iOS must not invoke command prebuild'); }, signing: () => { throw Error('iOS must not load Android credentials'); },
    eas: input => buildLocalEas({ ...f.args, ...input }) });
  assert.deepEqual(f.calls, ['source', 'provider', 'source', 'verify']); assert.deepEqual(f.plan, original);
  const restored = await verifyLocalBuild(result.file); const receipt = restored.artifacts[0].receipt;
  assert.equal(receipt.origin.kind, 'local'); assert.equal(receipt.metadata.nativeOrigin, 'local'); assert.equal(receipt.metadata.versionCode, 4);
  assert.equal(receipt.metadata.runtime, '1.2.3'); assert.ok(!JSON.stringify(restored).includes('sentinel'));
});

test('local EAS rejects non-macOS, unsupported Android override and failed IPA verification without accepting output', async t => {
  const f = fixture(t);
  await assert.rejects(buildLocalEas({ ...f.args, platform: 'win32' }), /macOS/); assert.deepEqual(f.calls, []);
  assert.throws(() => validateConfig({ ...f.plan.config, components: [{ ...f.plan.config.components[0], platform: 'android' }] }), /local native builder/);
  await assert.rejects(buildLocalEas({ ...f.args, hook: () => ({ verified: false }) }), /IPA verification failed/);
});
