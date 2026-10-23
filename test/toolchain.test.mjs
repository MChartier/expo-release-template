/** @file Checks atomic provider setup, cache reuse, failed installs and credential-free subprocesses. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { setupToolchain, toolchainLocation, resolveToolchain } from '../src/toolchain.mjs';

function fixture(t) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'release-setup-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const environment = { ...process.env, EXPO_RELEASE_TOOLCHAIN_CACHE: base, EXPO_TOKEN: 'must-not-pass', GH_TOKEN: 'must-not-pass' };
  const calls = [];
  const run = (file, args, options) => {
    calls.push({ file, args });
    assert.equal(options.env.EXPO_TOKEN, undefined); assert.equal(options.env.GH_TOKEN, undefined);
    if (args[1] === 'ci') {
      assert.ok(args.includes('--ignore-scripts'));
      const directory = args[args.indexOf('--prefix') + 1];
      const cli = path.join(directory, 'node_modules/eas-cli'); fs.mkdirSync(path.join(cli, 'bin'), { recursive: true });
      fs.writeFileSync(path.join(cli, 'package.json'), JSON.stringify({ version: '22.4.0' }));
      fs.writeFileSync(path.join(cli, 'bin/run'), '// fixture');
    }
    return 'eas-cli/22.4.0';
  };
  return { base, environment, calls, run, npmCli: process.execPath };
}

test('setup publishes only a complete cache and subsequent invocations do no installation', t => {
  const f = fixture(t); assert.throws(() => resolveToolchain(f.environment), /setup/);
  const installed = setupToolchain(f); assert.equal(installed.cached, false); assert.equal(f.calls.length, 2);
  assert.equal(resolveToolchain(f.environment), installed.directory);
  assert.equal(setupToolchain(f).cached, true); assert.equal(f.calls.length, 2);
  assert.deepEqual(fs.readdirSync(f.base), [path.basename(installed.directory)]);
});

test('an interrupted installation leaves no reusable marker and can be retried from scratch', t => {
  const f = fixture(t);
  assert.throws(() => setupToolchain({ ...f, run: () => { throw Object.assign(Error('private npm diagnostic'), { stderr: 'npm error code ECONNRESET\nprivate registry token', status: 1 }); } }), error => {
    assert.match(error.message, /npm installation \(ECONNRESET, exit 1\)/); assert.match(error.message, /no incomplete cache/);
    assert.doesNotMatch(error.message, /private/); return true;
  });
  assert.deepEqual(fs.readdirSync(f.base), []);
  assert.equal(fs.existsSync(toolchainLocation(f.environment)), false);
  assert.equal(setupToolchain(f).cached, false);
});

test('a modified cached version fails instead of silently selecting ambient EAS', t => {
  const f = fixture(t); const { directory } = setupToolchain(f);
  fs.writeFileSync(path.join(directory, 'node_modules/eas-cli/package.json'), '{"version":"0.0.0"}');
  assert.throws(() => setupToolchain(f), /incomplete/);
});
