/** @file Local cohort execution preserves credential-free preparation and produces explicit local artifact evidence. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { planRelease } from '../src/planner.mjs';
import { createArtifactReceipt, verifyRetainedArtifact } from '../src/artifacts.mjs';
import { buildLocally } from '../src/local-build.mjs';

function fixture(t, { builder = 'command', localBuilder } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-build-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { schemaVersion: 1, repository: 'fixture/app', defaultBranch: 'main', components: ['phone', 'watch'].map(id => ({
    id, kind: 'native', platform: 'android', builder, ...(localBuilder ? { localBuilder } : {}), buildGroup: 'pair', runtimePolicy: 'fingerprint', submit: false,
    signing: { variables: { file: 'APP_KEYSTORE', storePassword: 'APP_STORE_PASSWORD', alias: 'APP_KEY_ALIAS', keyPassword: 'APP_KEY_PASSWORD' } } })), nativeGroups: [['phone', 'watch']] };
  const observations = config.components.map(({ id }) => ({ id, identity: id, version: '1.0.0', runtime: 'a'.repeat(40), environmentHash: 'e'.repeat(64), environment: { PUBLIC_INPUT: 'public' } }));
  const source = { repository: config.repository, commit: 'b'.repeat(40), toolkitCommit: 'c'.repeat(40), origin: 'local' };
  const plan = planRelease({ config, source, origin: { kind: 'local' }, observations, operation: 'build', providerConfiguration: { expo: null } });
  const calls = [];
  const args = { root, plan, git: (_root, command) => command[0] === 'rev-parse' ? source.commit : '',
    inspect: () => observations, prepare: async value => { calls.push('prepare'); assert.equal(value.inputs.environment.ANDROID_STORE_PASSWORD, undefined); },
    signing: () => { calls.push('credentials'); return { ANDROID_STORE_PASSWORD: 'secret-sentinel' }; },
    build: async value => {
      calls.push('build'); assert.equal(value.environment.ANDROID_STORE_PASSWORD, 'secret-sentinel');
      return Promise.all(value.plan.components.filter(component => component.selected).map(async component => {
        const directory = path.join(value.outputRoot, component.id, 'files'); fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'native.aab'), 'inert fixture');
        const receipt = await createArtifactReceipt({ plan: value.plan, target: component.id, directory });
        return { target: component.id, directory, receipt };
      }));
    } };
  return { args, calls };
}

test('paired local build runs once, loads keys after prebuild, and cannot become hosted publication evidence', async t => {
  const { args, calls } = fixture(t); const result = await buildLocally(args);
  assert.deepEqual(calls, ['prepare', 'credentials', 'build']);
  assert.equal(result.receipt.artifacts.length, 2); assert.equal(result.receipt.origin.kind, 'local');
  assert.equal(result.receipt.plan.prepared, true);
  assert.ok(!fs.readFileSync(result.file, 'utf8').includes('secret-sentinel'));
  const artifact = result.receipt.artifacts[0];
  await assert.rejects(verifyRetainedArtifact({ plan: result.receipt.plan, target: artifact.target,
    directory: artifact.directory, receipt: artifact.receipt }), /Local build evidence/);
});

test('failed prebuild admits no credentials and compilation fingerprint drift prevents a retained build receipt', async t => {
  const first = fixture(t);
  await assert.rejects(buildLocally({ ...first.args, prepare: async () => { throw new Error('prebuild failed'); } }), /prebuild failed/);
  assert.deepEqual(first.calls, []);
  const second = fixture(t);
  await assert.rejects(buildLocally({ ...second.args, inspect: () => [{ id: 'phone', runtime: 'changed' }] }), /Compilation changed/);
  assert.ok(!fs.readdirSync(path.join(second.args.root, '.release')).some(name => name.startsWith('artifacts-')));
});

test('an explicit local command override retains the hosted EAS builder and original plan identity', async t => {
  const { args, calls } = fixture(t, { builder: 'eas', localBuilder: 'command' }); const original = structuredClone(args.plan);
  const result = await buildLocally(args);
  assert.deepEqual(calls, ['prepare', 'credentials', 'build']); assert.deepEqual(args.plan, original);
  assert.ok(result.receipt.plan.components.every(value => value.builder === 'eas' && value.localBuilder === 'command'));
  assert.equal(result.receipt.plan.source.commit, original.source.commit);
  const absent = fixture(t, { builder: 'eas' });
  await assert.rejects(buildLocally(absent.args), /explicit supported native builder/);
  assert.deepEqual(absent.calls, []);
});

test('the actual local command pipeline prepares without credentials and admits a temporary key only during compilation', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-command-boundary-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir())); fs.rmSync(root, { recursive: true, force: true }); });
  const config = { schemaVersion: 1, repository: 'fixture/app', defaultBranch: 'main', components: [{ id: 'android', kind: 'native',
    platform: 'android', builder: 'eas', localBuilder: 'command', runtimePolicy: 'appVersion',
    signing: { variables: { file: 'APP_KEYSTORE', storePassword: 'APP_STORE_PASSWORD', alias: 'APP_KEY_ALIAS', keyPassword: 'APP_KEY_PASSWORD' } } }],
    hooks: Object.fromEntries(['inspect', 'build', 'verify'].map(action => [action, { command: ['node', 'hook.mjs'] }])) };
  const observations = [{ id: 'android', identity: 'android-inputs', version: '1.0.0', versionCode: 7, runtime: '1.0.0', fingerprint: 'd'.repeat(40), environment: {} }];
  fs.writeFileSync(path.join(root, '.gitignore'), '# Generated fixture outputs.\ngenerated/\n.release/\n');
  fs.writeFileSync(path.join(root, 'observations.json'), JSON.stringify(observations));
  fs.writeFileSync(path.join(root, 'hook.mjs'), `/** @file Inert fixture characterizes credentials across actual shared source hooks. */
import fs from 'node:fs'; import path from 'node:path'; import assert from 'node:assert/strict';
const request=JSON.parse(fs.readFileSync(0,'utf8')); assert(!process.env.EXPO_TOKEN&&!process.env.GH_TOKEN&&!process.env.GITHUB_TOKEN);
if(request.action==='inspect'){assert(!process.env.APP_KEYSTORE);console.log(JSON.stringify({schemaVersion:1,observations:JSON.parse(fs.readFileSync('observations.json'))}));}
else if(request.action==='build'&&request.phase==='prepare'){assert(!process.env.APP_KEYSTORE&&!request.environment.APP_STORE_PASSWORD);fs.mkdirSync('generated',{recursive:true});fs.writeFileSync('generated/prepared','ok');console.log(JSON.stringify({schemaVersion:1,prepared:true}));}
else if(request.action==='build'&&request.phase==='compile'){assert(fs.existsSync('generated/prepared'));assert.equal(fs.readFileSync(process.env.APP_KEYSTORE).length,256);assert.equal(process.env.APP_STORE_PASSWORD,'fixture-password');fs.writeFileSync('generated/key-path',process.env.APP_KEYSTORE);fs.mkdirSync(request.outputDirectory,{recursive:true});fs.writeFileSync(path.join(request.outputDirectory,'application.aab'),'inert compiled output');console.log(JSON.stringify({schemaVersion:1,artifact:{kind:'native',directory:request.outputDirectory,version:'1.0.0',versionCode:7,runtime:'1.0.0'}}));}
else {assert.equal(request.action,'verify');assert(!process.env.APP_KEYSTORE&&!request.environment.APP_STORE_PASSWORD);assert(fs.existsSync(path.join(request.artifact.directory,'application.aab')));console.log(JSON.stringify({schemaVersion:1,verified:true}));}
`);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '--quiet']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  const source = { repository: config.repository, commit: git(['rev-parse', 'HEAD']), toolkitCommit: 'b'.repeat(40), origin: 'local' };
  const plan = planRelease({ config, source, observations, origin: { kind: 'local' }, operation: 'build' });
  const result = await buildLocally({ plan, root, environment: { EXPO_TOKEN: 'must-not-reach-hooks' }, signing: () => {
    assert(fs.existsSync(path.join(root, 'generated/prepared')));
    return { ANDROID_KEYSTORE_BASE64: Buffer.alloc(256, 7).toString('base64'), ANDROID_STORE_PASSWORD: 'fixture-password', ANDROID_KEY_ALIAS: 'upload', ANDROID_KEY_PASSWORD: 'fixture-password' };
  } });
  assert.equal(result.receipt.artifacts[0].receipt.metadata.versionCode, 7);
  assert.equal(fs.existsSync(fs.readFileSync(path.join(root, 'generated/key-path'), 'utf8')), false);
  assert.ok(!fs.readFileSync(result.file, 'utf8').includes('fixture-password'));
});
