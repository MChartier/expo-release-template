/** @file Verifies environment reads stay outside source hooks and reject credential/capability leaks, identity drift and nonreproducible provider values. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { resolveConfigurationValue, resolveExpoConfiguration, readReleaseEnvironment } from '../src/environment.mjs';

const projectId = '00000000-0000-4000-8000-000000000000';

test('declared command-build profiles retain their own server origin without provider environment reads', async () => {
  const { config, calls, transport } = fixture();
  config.profiles.local = { execution: 'local', environment: 'preview', channel: 'internal',
    expo: { serverUrl: 'https://private.invalid' }, publicEnvironment: { PUBLIC_SETTING: 'private' } };
  config.components = [{ ...config.components[0], builder: 'command', environmentSource: 'declared' }];
  const inputs = await readReleaseEnvironment(config, { profile: 'local', transport });
  assert.deepEqual(calls, []); assert.equal(inputs.expo.serverUrl, 'https://private.invalid');
  assert.equal(inputs.components.android.environment.PUBLIC_SETTING, 'private');
  assert.equal(inputs.components.android.channel, 'internal');
});
function fixture() {
  const calls = []; const variables = [];
  const config = { repository: 'fixture/app', defaultBranch: 'main', defaultProfile: 'production',
    profiles: { production: { environment: 'production', channel: 'production' } },
    expo: { projectId, owner: 'fixture', slug: 'app', environmentPolicy: { allowedNames: ['PUBLIC_SETTING'], channelVariable: 'APP_CHANNEL', forbiddenNames: ['EXPO_PUBLIC_*'] } },
    components: [{ id: 'android', kind: 'native', platform: 'android', builder: 'eas' },
      { id: 'ota', kind: 'ota', platform: 'android', nativeTarget: 'android', channel: 'internal', environment: 'preview' }] };
  const transport = { project: async value => { assert.equal(value.projectId, projectId); calls.push('project'); },
    environment: async (id, name) => { assert.equal(id, projectId); calls.push(name); return variables; } };
  return { config, transport, calls, variables };
}

test('distinct target environments are read once and hashed without injecting artificial channel inputs', async () => {
  const f = fixture(); f.variables.push({ name: 'PUBLIC_SETTING', value: 'public', visibility: 'PUBLIC', type: 'STRING' });
  const result = await readReleaseEnvironment(f.config, { transport: f.transport });
  assert.deepEqual(f.calls, ['project', 'production', 'preview']);
  assert.deepEqual(result.environment, { PUBLIC_SETTING: 'public' });
  assert.equal(result.hash, createHash('sha256').update(JSON.stringify([['PUBLIC_SETTING', 'public']])).digest('hex'));
  assert.equal(result.components.ota.channel, 'internal'); assert.equal(result.components.ota.easEnvironment, 'preview');
});

test('credentials, executable environment capabilities, unreadable values and conflicting channels are rejected', async () => {
  for (const change of [
    { name: 'EXPO_TOKEN' }, { name: 'NODE_OPTIONS' }, { name: 'GITHUB_OUTPUT' }, { name: 'EXPO_PUBLIC_URL' },
    { name: 'OPENAI_API_KEY' }, { name: 'PUBLIC_SETTING', visibility: 'SECRET' }, { name: 'PUBLIC_SETTING', type: 'FILE' },
    { name: 'APP_CHANNEL', value: 'other' }, { name: 'UNKNOWN_VALUE' },
  ]) {
    const f = fixture(); f.variables.push({ name: 'PUBLIC_SETTING', value: 'value', visibility: 'PUBLIC', type: 'STRING', ...change });
    await assert.rejects(readReleaseEnvironment(f.config, { transport: f.transport }));
  }
});

test('explicit public declarations permit reproducible sensitive strings but never credentials', async () => {
  const f = fixture(); f.variables.push({ name: 'PUBLIC_SETTING', value: 'approved', visibility: 'SENSITIVE', type: 'STRING' });
  assert.deepEqual((await readReleaseEnvironment(f.config, { transport: f.transport })).environment, { PUBLIC_SETTING: 'approved' });
  delete f.config.expo.environmentPolicy.allowedNames;
  await assert.rejects(readReleaseEnvironment(f.config, { transport: f.transport }), /explicit public/);
});

test('committed public defaults must match remote values and channel defaults resolve per target', async () => {
  const f = fixture(); f.config.inspection = { environment: { PUBLIC_SETTING: 'committed', APP_CHANNEL: 'production' } };
  const result = await readReleaseEnvironment(f.config, { transport: f.transport });
  assert.equal(result.components.ota.environment.APP_CHANNEL, 'internal');
  f.variables.push({ name: 'PUBLIC_SETTING', value: 'changed', visibility: 'PUBLIC', type: 'STRING' });
  await assert.rejects(readReleaseEnvironment(f.config, { transport: f.transport }), /committed/);
});

test('mapped project identity reads data only and optional pointers never suppress unsafe paths', () => {
  const root = mkdtempSync(resolve(tmpdir(), 'expo-config-'));
  try {
    writeFileSync(resolve(root, 'metadata.json'), JSON.stringify({ project: projectId, owner: 'fixture' }));
    const mapped = { projectId: { file: 'metadata.json', pointer: '/project' }, owner: { file: 'metadata.json', pointer: '/owner' }, slug: 'app' };
    assert.equal(resolveExpoConfiguration({ expo: mapped }, root).projectId, projectId);
    assert.equal(resolveConfigurationValue({ file: 'metadata.json', pointer: '/missing', optional: true }, root), undefined);
    assert.throws(() => resolveConfigurationValue({ file: '../metadata.json', pointer: '/missing', optional: true }, root), /relative/);
    assert.throws(() => resolveExpoConfiguration({ expo: { ...mapped, serverUrl: 'http://fixture.invalid' } }, root), /HTTPS/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('server-only configuration requires no provider credentials', async () => {
  const result = await readReleaseEnvironment({ repository: 'fixture/app', defaultBranch: 'main', components: [{ id: 'server', kind: 'server' }] },
    { transport: { project: () => { throw Error('must not authenticate'); } } });
  assert.equal(result.expo, null); assert.deepEqual(result.environment, {});
  const f = fixture(); f.config.components.push({ id: 'server', kind: 'server' });
  const explicit = await readReleaseEnvironment(f.config, { targets: ['server'], transport: { project: () => { throw Error('must not authenticate'); } } });
  assert.equal(explicit.expo.projectId, projectId); assert.deepEqual(explicit.environment, {});
});

test('explicit target reads exclude other providers and protected environments remain unobserved until approved', async () => {
  const f = fixture(); f.config.components[1].approvalEnvironment = 'production';
  const deferred = await readReleaseEnvironment(f.config, { transport: f.transport, targets: ['ota'], deferProtected: true });
  assert.deepEqual(f.calls, []); assert.equal(deferred.components.ota.deferred, true); assert.equal(deferred.components.ota.hash, null);
  assert.equal(deferred.components.android, undefined);
  const approved = await readReleaseEnvironment(f.config, { transport: f.transport, targets: ['ota'] });
  assert.deepEqual(f.calls, ['project', 'preview']); assert.equal(approved.components.ota.deferred, undefined);
  assert.match(approved.components.ota.hash, /^[a-f0-9]{64}$/);
});
