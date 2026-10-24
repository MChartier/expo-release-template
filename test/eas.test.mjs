/** @file Supported EAS CLI contracts, destination identity and exact exported bundle publication. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { eas, publisher, readEnvironments, verifyBuildFloors, verifyBuild, cloudBuild, submit, submissionId, update } from '../src/eas.mjs';
import { seal, writeJson, readJson } from '../src/io.mjs';
import { config, plan, temporary } from './helpers.mjs';

/** Mirror the official public build:view JSON fields used by the toolkit. */
function build(value = plan()) {
  return { id: 'provider-id', status: 'FINISHED', app: { id: value.config.mobile.projectId }, appIdentifier: 'app.example.mobile',
    platform: 'ANDROID', gitCommitHash: value.build, buildProfile: 'production', appVersion: value.versions.mobile,
    runtime: { version: value.runtime }, updateChannel: { name: 'production' }, fingerprint: { hash: value.observation.fingerprints.production.android }, isForIosSimulator: false };
}

test('public build record proves project, application, source, profile and runtime', () => {
  const value = plan(), target = value.config.mobile.targets[0]; assert.equal(verifyBuild(build(), value, target).id, 'provider-id');
  const changes = { status: 'IN_QUEUE', app: { id: 'other-project' }, appIdentifier: 'other.app', platform: 'IOS', gitCommitHash: value.source,
    buildProfile: 'other', appVersion: '0.9.9', runtime: { version: 'other' }, updateChannel: { name: 'other' }, fingerprint: { hash: 'other' }, isForIosSimulator: true };
  for (const [key, field] of Object.entries(changes)) assert.throws(() => verifyBuild({ ...build(), [key]: field }, value, target), /identity/);
});

test('cloud build starts once then reads its exact provider ID', async () => {
  const value = plan(), calls = [];
  const command = (args, cwd, options) => { calls.push({ args, cwd, options }); return args[0] === 'build' ? [{ id: 'provider-id' }] : build(value); };
  const result = await cloudBuild('source', value, value.config.mobile.targets[0], command);
  assert.equal(result.id, 'provider-id'); assert.equal(calls.length, 2);
  assert.ok(calls[0].args.includes('--no-wait')); assert.ok(calls[0].args.includes('--freeze-credentials'));
  assert.ok(!calls[0].args.includes('--auto-submit')); assert.deepEqual(calls[1].args, ['build:view', 'provider-id', '--json']);
});

test('lost build acknowledgement or failed build does not enqueue again', async () => {
  for (const failure of ['lost', 'empty', 'failed']) {
    let starts = 0;
    await assert.rejects(cloudBuild('source', plan(), config().mobile.targets[0], args => {
      if (args[0] === 'build') { starts++; if (failure === 'lost') throw new Error('lost acknowledgement'); return failure === 'empty' ? [] : [{ id: 'id' }]; }
      return { status: 'ERRORED' };
    }));
    assert.equal(starts, 1);
  }
});

test('publisher workspace contains inert identities and no source hooks or plugins', t => {
  const root = publisher(config(), 'production', { expo: { plugins: ['execute-me'], hooks: { postPublish: [] }, entryPoint: 'execute-me', extra: { releaseVersion: '1.0.0' } } });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const expo = readJson(path.join(root, 'app.json')).expo;
  assert.equal(expo.owner, 'owner'); assert.equal(expo.slug, 'app'); assert.equal(expo.extra.eas.projectId, config().mobile.projectId);
  for (const key of ['plugins', 'hooks', 'entryPoint']) assert.equal(expo[key], undefined);
  assert.equal(readJson(path.join(root, 'package.json')).scripts, undefined);
});

test('environment read pulls declared public strings, including explicit profile values', () => {
  const value = config(); value.mobile.publicVariables = ['PUBLIC_ORIGIN']; value.profiles.production.publicEnvironment = { CHANNEL: 'production' };
  const result = readEnvironments(value, (args, root, options) => {
    assert.equal(args[0], 'env:pull'); assert.equal(options.json, false); assert.ok(args.includes('--non-interactive'));
    fs.writeFileSync(args[args.indexOf('--path') + 1], 'PUBLIC_ORIGIN="https://example.invalid"\nCHANNEL=production\n');
    assert.ok(!fs.existsSync(path.join(root, 'app.config.js')));
  });
  assert.deepEqual(result.production, { PUBLIC_ORIGIN: 'https://example.invalid', CHANNEL: 'production' });
});

test('hidden secrets, files, undeclared input and profile overrides fail before source execution', () => {
  const value = config(); value.profiles.production.publicEnvironment = { CHANNEL: 'production' };
  for (const contents of ['EXPO_TOKEN=unsafe', '# SECRET=***** (secret)', 'CHANNEL=preview', 'UNDECLARED=one']) {
    assert.throws(() => readEnvironments(value, args => fs.writeFileSync(args[args.indexOf('--path') + 1], contents)));
  }
  assert.throws(() => readEnvironments(value, (args, root) => {
    fs.mkdirSync(path.join(root, '.eas/.env'), { recursive: true }); fs.writeFileSync(args[args.indexOf('--path') + 1], '');
  }), /readable strings/);
});

test('ordinary command gets Expo credentials only and build uses real Git identity', () => {
  eas(['build:view', 'id', '--json'], 'inert', { environment: { EAS_NO_VCS: '0' }, execute: (binary, args, options) => {
    assert.equal(binary, 'eas'); assert.equal(options.env.EAS_NO_VCS, undefined);
    for (const key of ['GITHUB_TOKEN', 'DEPLOY_TOKEN', 'ANDROID_STORE_PASSWORD']) assert.equal(options.env[key], undefined);
    return '{"id":"id"}';
  } });
});

test('managed counters must be initialized above verified platform floors before reserving', () => {
  const value = config(); for (const target of value.mobile.targets) target.buildNumberFloor = 5;
  verifyBuildFloors(value, () => ({ versionCode: '5', buildNumber: '7' }));
  for (const counters of [{}, { versionCode: '4', buildNumber: '7' }, { versionCode: '5', buildNumber: 'bad' }])
    assert.throws(() => verifyBuildFloors(value, () => counters), /Initialize EAS/);
  value.mobile.builder = 'command'; verifyBuildFloors(value, () => assert.fail('paired builds use immutable Git reservations'));
});

test('submit accepts only an exact current-run artifact or verified build ID and waits', () => {
  const value = plan(), target = value.config.mobile.targets[0]; let calls = 0;
  const result = submit(value, target, { buildId: 'exact-build-id' }, value.submitProfiles, (args, root, options) => {
    calls++; assert.ok(args.includes('--wait')); assert.ok(args.includes('--id')); assert.ok(args.includes('exact-build-id'));
    assert.ok(!args.includes('--latest')); assert.ok(!args.includes('--json')); assert.equal(options.json, false);
    assert.equal(readJson(path.join(root, 'eas.json')).submit.production.android.track, 'internal');
    return 'Submission details: https://expo.dev/accounts/owner/projects/app/submissions/12345678-1234-1234-1234-123456789012';
  });
  assert.equal(calls, 1); assert.equal(result.completed, true);
});

test('missing explicit destination or uncertain submission response cannot be treated as success', () => {
  const value = plan(); let calls = 0;
  assert.throws(() => submit(value, value.config.mobile.targets[1], { buildId: 'id' }, { production: { ios: {} } }, () => { calls++; }), /destination/);
  assert.equal(calls, 0);
  assert.throws(() => submit(value, value.config.mobile.targets[0], { file: 'native.aab' }, value.submitProfiles, () => { calls++; return 'accepted'; }), /uncertain/);
  assert.equal(calls, 1);
  assert.throws(() => submissionId('https://expo.dev/accounts/other/projects/app/submissions/12345678-1234-1234-1234-123456789012', value.config.mobile), /uncertain/);
});

test('Calibrate phone and watch destinations stay distinct in EAS submit profiles', () => {
  const value = plan(), profiles = { phone: { android: { track: 'internal' } }, wear: { android: { track: 'wear:internal' } } };
  for (const id of ['phone','wear']) {
    const target = { id, platform: 'android', applicationId: 'app.example.mobile', submitProfile: id };
    submit(value, target, { file: `${id}.aab` }, profiles, (args, root) => {
      assert.equal(args[args.indexOf('--profile')+1], id);
      assert.equal(readJson(path.join(root,'eas.json')).submit[id].android.track, profiles[id].android.track);
      return 'https://expo.dev/accounts/owner/projects/app/submissions/12345678-1234-1234-1234-123456789012';
    });
  }
});

test('OTA publishes exact exported files with supported CLI options', t => {
  const directory = temporary(t), value = plan({ bump: 'patch', ota: ['android'], native: false });
  writeJson(path.join(directory,'metadata.json'), { version: 0, bundler: 'metro', fileMetadata: {} });
  writeJson(path.join(directory,'expo-release.json'), { version: value.versions.mobile, runtime: value.runtime, platform: 'android', updatesVersion: '57.0.8',
    expo: { version: value.versions.mobile, runtimeVersion: value.runtime, extra: { releaseVersion: value.versions.mobile } } });
  seal(directory,value,'ota-android'); t.after(() => fs.rmSync(`${directory}.json`,{force:true}));
  const result = update(value,'android',directory,(args,root) => {
    assert.ok(args.includes('--skip-bundler')); assert.equal(args[args.indexOf('--input-dir')+1], directory);
    assert.equal(args[args.indexOf('--channel')+1], 'production');
    assert.equal(readJson(path.join(root,'app.json')).expo.extra.releaseVersion,value.versions.mobile);
    assert.deepEqual(readJson(path.join(root,'package.json')).dependencies, { 'expo-updates': '57.0.8' });
    return [{ group:'group-id', runtimeVersion:value.runtime, platform:'android' }];
  });
  assert.equal(result.group,'group-id');
  fs.writeFileSync(path.join(directory,'metadata.json'),'tampered');
  assert.throws(() => update(value,'android',directory,() => assert.fail('must not publish')), /digest/);
});

test('OTA rejects incompatible export metadata before calling EAS', t => {
  const directory = temporary(t), value = plan();
  writeJson(path.join(directory,'expo-release.json'), { version:value.versions.mobile,runtime:'old-runtime',platform:'android' });
  seal(directory,value,'ota-android'); t.after(() => fs.rmSync(`${directory}.json`,{force:true}));
  assert.throws(() => update(value,'android',directory,() => assert.fail('must not publish')), /metadata differs/);
});
