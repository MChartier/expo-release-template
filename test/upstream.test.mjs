/** @file Verify the pinned upstream CLI exposes every supported interface, without authenticating or publishing. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { run, readJson, hash, inventory } from '../src/io.mjs';
import { publisher } from '../src/eas.mjs';
import { config } from './helpers.mjs';
const cli = process.env.EXPO_RELEASE_TEST_EAS;
/** Invoke only version/help commands against the installed upstream CLI. */
function command(args) { return cli === 'eas' ? run('eas', args) : run(process.execPath, [cli, ...args]); }

test('official EAS version and public command flags match the adapter contract', { skip: !cli }, () => {
  assert.match(command(['--version']), /eas-cli\/25\.3\.0/);
  for (const [name, flags] of Object.entries({
    build: ['--json', '--freeze-credentials', '--non-interactive', '--[no-]wait'],
    'build:view': ['--json'], 'build:version:get': ['--json', '--platform'],
    submit: ['--id', '--path', '--[no-]wait', '--non-interactive'],
    update: ['--input-dir', '--skip-bundler', '--environment', '--json'],
    'env:pull': ['--path', '--environment', '--non-interactive']
  })) {
    const help = command([name, '--help']); for (const flag of flags) assert.ok(help.includes(flag), `${name} needs ${flag}`);
  }
  assert.ok(!command(['submit', '--help']).includes('--json'), 'submission acknowledgement uses the documented provider URL');
});

test('official EAS OTA preflight accepts inert exported metadata without installing or rewriting anything', { skip: !cli }, async t => {
  const binary = cli === 'eas' ? run(process.platform === 'win32' ? 'where.exe' : 'which', [process.platform === 'win32' ? 'eas.cmd' : 'eas']).trim().split(/\r?\n/)[0] : cli;
  const manifest = binary.endsWith('.cmd') ? [path.resolve(path.dirname(binary), '../eas-cli/package.json'),
    path.join(path.dirname(binary), 'node_modules/eas-cli/package.json')].find(file => fs.existsSync(file)) : path.resolve(fs.realpathSync(binary), '../../package.json');
  const upstream = createRequire(manifest), value = config();
  const root = publisher(value, 'production', { updatesVersion: '57.0.8', expo: { sdkVersion: '57.0.0', version: '1.2.3', runtimeVersion: '1',
    updates: { url: `https://u.expo.dev/${value.mobile.projectId}` }, extra: { releaseVersion: '1.2.3' } } });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const exp = readJson(path.join(root, 'app.json')).expo, before = hash(inventory(root));
  // Exercise installed upstream preflight functions only; no provider client or publication is invoked.
  assert.equal(upstream('./build/project/projectUtils.js').isExpoUpdatesInstalledOrAvailable(root, exp.sdkVersion), true);
  await upstream('./build/update/configure.js').ensureEASUpdateIsConfiguredAsync({ exp, projectId: value.mobile.projectId,
    projectDir: root, platform: 'android', vcsClient: {}, manifestHostOverride: null });
  const runtimes = await upstream('./build/project/publish.js').getRuntimeVersionInfoObjectsAsync({ exp, projectDir: root,
    platforms: ['android'], workflows: { android: 'managed' }, env: {} });
  assert.equal(runtimes[0].runtimeVersionInfo.runtimeVersion, '1');
  assert.equal(hash(inventory(root)), before);
  assert.equal(fs.existsSync(path.join(root, 'node_modules')), false);
});
