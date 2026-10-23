/** @file Clean package and full-SHA Git installation checks; installs tools but never accesses a release provider. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sourceEnvironment } from '../src/hooks.mjs';
import { setupToolchain, resolveToolchain } from '../src/toolchain.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
test('clean tarball and immutable Git installs expose only the public contract and share official tool setup', { skip: process.env.EXPO_RELEASE_INSTALL_TEST !== '1', timeout: 600000 }, () => {
  setupToolchain(); const toolchain = resolveToolchain();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'release-install-'));
  const npm = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const run = (args, cwd = directory) => execFileSync(process.execPath, args, { cwd, env: sourceEnvironment(), windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  try {
    const packed = JSON.parse(run([npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', directory], root))[0];
    const specs = [path.join(directory, packed.filename)];
    const revision = process.env.EXPO_RELEASE_TEST_SHA;
    if (revision) { assert.match(revision, /^[a-f0-9]{40}$/); specs.push(`git+https://github.com/MChartier/expo-release-template.git#${revision}`); }
    for (const [index, spec] of specs.entries()) for (const ignore of [false, true]) {
      const cwd = path.join(directory, `${index}-${ignore}`); fs.mkdirSync(cwd); fs.writeFileSync(path.join(cwd, 'package.json'), '{"private":true,"type":"module"}');
      run([npm, 'install', '--no-audit', '--no-fund', ...(ignore ? ['--ignore-scripts'] : []), spec], cwd);
      const installed = path.join(cwd, 'node_modules/@mchartier/expo-release');
      const manifest = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8'));
      assert.equal(manifest.dependencies['eas-cli'], undefined); assert.equal(manifest.scripts.prepare, undefined);
      assert.equal(fs.existsSync(path.join(installed, 'vendor')), false);
      const check = `import assert from 'node:assert/strict';import {createRequire} from 'node:module';
        import * as api from '@mchartier/expo-release';
        assert.equal(typeof api.planRelease,'function');assert.equal(api.createEasTransport,undefined);
        assert.deepEqual(createRequire(import.meta.url)('@mchartier/expo-release/expo').runtimeVersion(),{policy:'appVersion'});
        assert.equal(api.setupToolchain().directory,${JSON.stringify(toolchain)});
        console.log(api.resolveEasCli());`;
      run(['--input-type=module', '-e', check], cwd);
      run([path.join(installed, 'bin/expo-release.mjs'), 'help'], cwd);
    }
  } finally {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
