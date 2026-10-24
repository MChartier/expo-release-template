/** @file Git binary/deletion detection, artifact binding and credential isolation. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { trackedIdentity, inputIdentity, sourceEnvironment, seal, verify, inventory, hash, within, writeJson } from '../src/io.mjs';
import { hostedIdentity } from '../src/worker.mjs';
import { verifyPlan, verifyPins, loadConfig } from '../src/config.mjs';
import { fingerprintTransform, runtimeVersion } from '../src/expo.cjs';
import { repository, temporary, config, plan } from './helpers.mjs';

test('tracked inputs detect binary changes, deleted paths and file renames', t => {
  const repo = repository(t);
  repo.save('app/icon.png', Buffer.from([0, 1, 2])); repo.save('server/main.js', 'one'); repo.commit();
  const initial = inputIdentity(repo.root, 'HEAD', ['app']);
  repo.save('server/main.js', 'two'); repo.commit();
  assert.equal(inputIdentity(repo.root, 'HEAD', ['app']), initial);
  repo.save('app/icon.png', Buffer.from([0, 1, 3])); repo.commit();
  const modified = inputIdentity(repo.root, 'HEAD', ['app']); assert.notEqual(modified, initial);
  fs.renameSync(path.join(repo.root, 'app/icon.png'), path.join(repo.root, 'app/renamed.png')); repo.commit();
  assert.notEqual(inputIdentity(repo.root, 'HEAD', ['app']), modified);
  fs.rmSync(path.join(repo.root, 'app/renamed.png')); repo.commit();
  assert.notEqual(inputIdentity(repo.root, 'HEAD', ['app']), initial);
});

test('shared packages and lockfile bytes participate in configured input sets', t => {
  const repo = repository(t);
  repo.save('packages/common/index.js', 'export const value=1'); repo.save('package-lock.json', '{"lockfileVersion":3}'); repo.commit();
  const before = inputIdentity(repo.root, 'HEAD', ['packages', 'package-lock.json']);
  repo.save('package-lock.json', '{"lockfileVersion":3,"packages":{}}'); repo.commit();
  assert.notEqual(inputIdentity(repo.root, 'HEAD', ['packages', 'package-lock.json']), before);
  const second = inputIdentity(repo.root, 'HEAD', ['packages']);
  repo.save('packages/common/index.js', 'export const value=2'); repo.commit();
  assert.notEqual(inputIdentity(repo.root, 'HEAD', ['packages']), second);
});

test('normalizers exclude allocated metadata while retaining actual configuration', t => {
  const repo = repository(t); repo.save('version.json', '{"version":"1.0.0","host":"one"}'); repo.commit();
  const options = { content: () => 'text', normalize: (_, text) => { const value = JSON.parse(text); delete value.version; return JSON.stringify(value); } };
  const before = trackedIdentity(repo.root, 'HEAD', options);
  repo.save('version.json', '{"version":"1.1.0","host":"one"}'); repo.commit();
  assert.equal(trackedIdentity(repo.root, 'HEAD', options), before);
  repo.save('version.json', '{"version":"1.1.0","host":"two"}'); repo.commit();
  assert.notEqual(trackedIdentity(repo.root, 'HEAD', options), before);
});

test('Expo normalization omits allocated metadata and preserves native inputs', () => {
  const source = { type: 'contents', id: 'expoConfig' };
  const config = { version: '1.0.0', runtimeVersion: '1', android: { versionCode: 7, package: 'example.app' },
    ios: { buildNumber: '7', bundleIdentifier: 'example.app' }, extra: { releaseVersion: '1.0.0', serverUrl: 'https://example.invalid' }, plugins: ['native-plugin'] };
  const before = fingerprintTransform(source, JSON.stringify(config));
  config.version = config.extra.releaseVersion = '1.2.3'; config.android.versionCode = 99; config.ios.buildNumber = '99'; config.runtimeVersion = '2';
  assert.equal(fingerprintTransform(source, JSON.stringify(config)), before);
  config.plugins.push('another-native-plugin');
  assert.notEqual(fingerprintTransform(source, JSON.stringify(config)), before);
  const bytes = Buffer.from([0, 1, 2]); assert.equal(fingerprintTransform({ type: 'file' }, bytes), bytes);
});

test('runtime is explicitly the shared major', () => {
  for (const version of ['2.0.0', '2.1.0', '2.1.7']) assert.equal(runtimeVersion(version), '2');
  for (const value of ['fingerprint', 'appVersion', '2', '1.2.3-beta']) assert.throws(() => runtimeVersion(value));
});

test('artifacts are bound to current run, source, toolkit, target and exact bytes', t => {
  const directory = temporary(t), value = plan(); fs.writeFileSync(path.join(directory, 'bundle.bin'), Buffer.from([0, 1, 2]));
  const receipt = seal(directory, value, 'ota/android');
  t.after(() => fs.rmSync(`${directory}.json`, { force: true }));
  assert.deepEqual(verify(directory, value, 'ota/android'), receipt);
  for (const key of ['run', 'source', 'toolkit']) assert.throws(() => verify(directory, { ...value, [key]: 'different' }, 'ota/android'), /identity/);
  assert.throws(() => verify(directory, value, 'ota/ios'), /identity/);
  fs.writeFileSync(path.join(directory, 'bundle.bin'), Buffer.from([0, 1, 3]));
  assert.throws(() => verify(directory, value, 'ota/android'), /digest/);
});

test('extra and missing artifact files fail verification', t => {
  const directory = temporary(t); fs.writeFileSync(path.join(directory, 'bundle'), 'one');
  const receipt = seal(directory, plan(), 'ota'); t.after(() => fs.rmSync(`${directory}.json`, { force: true }));
  fs.writeFileSync(path.join(directory, 'injected'), 'two');
  assert.throws(() => verify(directory, plan(), 'ota', receipt));
  fs.rmSync(path.join(directory, 'injected')); fs.rmSync(path.join(directory, 'bundle'));
  assert.throws(() => verify(directory, plan(), 'ota', receipt));
});

test('local, legacy and previous-run receipts cannot authorize hosted publication', t => {
  const directory = temporary(t); fs.writeFileSync(path.join(directory, 'bundle'), 'one');
  const current = seal(directory, plan(), 'ota'); t.after(() => fs.rmSync(`${directory}.json`, { force: true }));
  for (const receipt of [{ schemaVersion: 1 }, { ...current, format: 'local' }, { ...current, run: '122' }])
    assert.throws(() => verify(directory, plan(), 'ota', receipt), /identity/);
});

test('directory links cannot escape an artifact inventory', t => {
  const root = temporary(t), outside = temporary(t); fs.writeFileSync(path.join(outside, 'secret'), 'not-an-artifact');
  fs.symlinkSync(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => inventory(root), /links/);
});

test('source processes never inherit publication or signing variables', () => {
  const env = sourceEnvironment({ PUBLIC_ORIGIN: 'https://example.invalid' }, { PATH: 'bin', HOME: 'home', EXPO_TOKEN: 'x', GITHUB_TOKEN: 'x',
    ANDROID_STORE_PASSWORD: 'x', DEPLOY_TOKEN: 'x', AWS_ACCESS_KEY_ID: 'x', NODE_OPTIONS: '--import dangerous', JAVA_HOME: 'java' });
  assert.deepEqual(Object.keys(env).sort(), ['CI', 'EXPO_NO_DOTENV', 'HOME', 'JAVA_HOME', 'PATH', 'PUBLIC_ORIGIN'].sort());
  for (const key of ['EXPO_TOKEN', 'NODE_OPTIONS', 'ANDROID_KEY_PASSWORD', 'PRIVATE_KEY', 'GITHUB_ENV']) assert.throws(() => sourceEnvironment({ [key]: 'x' }));
});

test('publish context requires a fresh protected default-branch dispatch', () => {
  const env = { GITHUB_EVENT_NAME: 'workflow_dispatch', GITHUB_REF: 'refs/heads/main', GITHUB_REPOSITORY: 'owner/app',
    GITHUB_SHA: 'a'.repeat(40), TOOLKIT_SHA: 'c'.repeat(40), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' };
  assert.equal(hostedIdentity(config(), env).source, env.GITHUB_SHA);
  for (const [key, value] of Object.entries({ GITHUB_EVENT_NAME: 'pull_request', GITHUB_REF: 'refs/heads/feature', GITHUB_REPOSITORY: 'other/app', TOOLKIT_SHA: 'main', GITHUB_RUN_ATTEMPT: '2' }))
    assert.throws(() => hostedIdentity(config(), { ...env, [key]: value }), /fresh default-branch/);
});

test('artifact plans cannot change configured producer or destination', () => {
  const value = plan(), identity = { repository: value.repository, source: value.source, toolkit: value.toolkit, run: value.run };
  verifyPlan(value, value.config, identity);
  const changed = structuredClone(value); changed.config.server.image = 'ghcr.io/other/app';
  assert.throws(() => verifyPlan(changed, value.config, identity), /destination/);
  assert.throws(() => verifyPlan(value, value.config, { ...identity, run: '124' }), /producer/);
});

test('package and lock must use the workflow full SHA', t => {
  const root = temporary(t), sha = 'c'.repeat(40);
  writeJson(path.join(root, 'package.json'), { devDependencies: { '@mchartier/expo-release': `git+https://github.com/MChartier/expo-release-template.git#${sha}` } });
  writeJson(path.join(root, 'package-lock.json'), { packages: { 'node_modules/@mchartier/expo-release': { resolved: `git+ssh://git@github.com/MChartier/expo-release-template.git#${sha}` } } });
  verifyPins(root, sha); assert.throws(() => verifyPins(root, 'main'), /full commit/);
  assert.throws(() => verifyPins(root, 'd'.repeat(40)), /pins differ/);
});

test('configuration rejects legacy graph fields and unsafe paths', t => {
  const root = temporary(t), value = config(); delete value.mobile.platforms;
  writeJson(path.join(root, 'release.config.json'), value); assert.equal(loadConfig(root).schemaVersion, 3);
  value.stages = []; writeJson(path.join(root, 'release.config.json'), value); assert.throws(() => loadConfig(root), /Invalid/);
  delete value.stages; value.metadataFiles = ['../outside']; writeJson(path.join(root, 'release.config.json'), value);
  assert.throws(() => loadConfig(root), /escapes/); assert.throws(() => within(root, '../outside'), /escapes/);
  assert.equal(hash({ a: 1, b: 2 }), hash({ b: 2, a: 1 }));
});
