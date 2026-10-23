/** @file Checks external credential isolation, exact EAS identity, atomic refresh and removal of stale submission settings. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { configureLocalCredentials, readLocalSettings, localSettingsPath, externalCredential, saveLocalCredentialPaths } from '../src/local-credentials.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'local-credentials-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'app'); fs.mkdirSync(root);
  const config = { repository: 'fixture/app', expo: { projectId: '11111111-1111-4111-8111-111111111111', owner: 'fixture', slug: 'app' },
    components: [{ id: 'phone', kind: 'native', platform: 'android', builder: 'command', applicationId: 'app.fixture', signing: {} }] };
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
  let account = { client_email: 'fixture@example.invalid', private_key: privateKey }; let failed = false;
  const calls = [];
  const args = { config, root, target: 'phone', platform: 'win32', environment: { LOCALAPPDATA: directory, EXPO_TOKEN: 'expo-secret', GOOGLE_ACCESS_TOKEN: 'must-not-pass' },
    log: () => {}, transportFactory: options => { calls.push(options); return {
      cli: async args => calls.push(args), project: async value => assert.deepEqual(value, config.expo),
      androidCredentials: async value => { assert.equal(value.applicationId, 'app.fixture'); assert.equal(value.projectId, config.expo.projectId);
        if (failed) throw new Error('secret-response-must-not-leak');
        return { keystore: Buffer.alloc(256, 7).toString('base64'), keystorePassword: 'store-secret', keyAlias: 'upload', keyPassword: null }; },
      assignedPlayCredentials: async () => account
    }; } };
  return { args, calls, setFailed: () => { failed = true; }, clearPlay: () => { account = null; } };
}

test('credentials stay external and only EAS receives authentication', async t => {
  const { args, calls } = fixture(t);
  const result = await configureLocalCredentials(args);
  const saved = fs.readFileSync(result.file, 'utf8');
  assert.ok(!saved.includes('store-secret') && !saved.includes('PRIVATE KEY'));
  assert.equal(calls[0].env.EXPO_TOKEN, 'expo-secret'); assert.equal(calls[0].env.GOOGLE_ACCESS_TOKEN, undefined);
  assert.equal(calls[1][0], 'credentials:configure-build');
  const signing = JSON.parse(fs.readFileSync(result.credentialsFile, 'utf8')).android.keystore;
  assert.equal(signing.keyPassword, 'store-secret');
  assert.ok(!result.credentialsFile.startsWith(`${args.root}${path.sep}`));
  assert.equal(readLocalSettings(args).credentials.serviceAccountFile, result.serviceAccountFile);
});

test('failed refresh preserves previous paths and unassigned Play key explicitly clears stale submission settings', async t => {
  const fixtureValue = fixture(t); const first = await configureLocalCredentials(fixtureValue.args);
  const previous = fs.readFileSync(first.file, 'utf8');
  fixtureValue.clearPlay(); const second = await configureLocalCredentials(fixtureValue.args);
  assert.equal(second.serviceAccountFile, undefined); assert.equal(readLocalSettings(fixtureValue.args).credentials.serviceAccountFile, undefined);
  const current = fs.readFileSync(second.file, 'utf8'); assert.notEqual(current, previous);
  fixtureValue.setFailed();
  await assert.rejects(configureLocalCredentials(fixtureValue.args), error => /Previous settings are unchanged/.test(error.message) && !error.message.includes('secret-response'));
  assert.equal(fs.readFileSync(second.file, 'utf8'), current);
});

test('settings and credential paths cannot enter the application repository', t => {
  const { args } = fixture(t);
  assert.throws(() => localSettingsPath(args.config, args.root, { LOCALAPPDATA: args.root }, 'win32'), /outside/);
  const file = path.join(args.root, 'secret.json'); fs.writeFileSync(file, '{}');
  assert.throws(() => externalCredential(args.root, file), /outside/);
});
