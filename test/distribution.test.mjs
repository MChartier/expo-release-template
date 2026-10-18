/** @file Tests the published runtime inventory and optionally a clean tarball install, including the pinned EAS dependency graph and lightweight CommonJS Expo helper. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const shrinkwrap = JSON.parse(fs.readFileSync(path.join(root, 'npm-shrinkwrap.json'), 'utf8'));

function npmCli() {
  const adjacent = path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  for (const candidate of [process.env.npm_execpath, adjacent,
    ...(process.env.PATH || '').split(path.delimiter).map(directory => path.join(directory, process.platform === 'win32' ? 'npm.cmd' : 'npm'))]) {
    if (!candidate || !fs.existsSync(candidate)) continue;
    const actual = fs.realpathSync(candidate);
    if (actual.endsWith('.js')) return actual;
    const alongside = path.join(path.dirname(actual), 'node_modules/npm/bin/npm-cli.js');
    if (fs.existsSync(alongside)) return alongside;
  }
  throw new Error('Run distribution checks through npm test or an installed Node/npm distribution.');
}

function npm(args, cwd, timeout = 300000, environment = {}) {
  return execFileSync(process.execPath, [npmCli(), ...args], { cwd, encoding: 'utf8', windowsHide: true, timeout,
    stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false', ...environment } });
}

function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-package-test-'));
  t.after(() => {
    const absolute = path.resolve(directory); const parent = path.resolve(os.tmpdir());
    assert.equal(path.dirname(absolute), parent); assert(path.basename(absolute).startsWith('expo-package-test-'));
    fs.rmSync(absolute, { recursive: true, force: true });
  });
  return directory;
}

function pack(directory) {
  const packed = JSON.parse(npm(['pack', '--ignore-scripts', '--json', '--pack-destination', directory], root));
  assert.equal(packed.length, 1); return { ...packed[0], tarball: path.join(directory, packed[0].filename) };
}

function packageDirectory(from, name) {
  for (let directory = from; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (directory === path.dirname(directory)) throw new Error(`Installed package ${name} is unavailable from ${from}.`);
  }
}

function verifyRuntimeGraph(installed) {
  const locations = new Map([['', installed]]); let verified = 0;
  for (const [key, expected] of Object.entries(shrinkwrap.packages).filter(([key, value]) => key && !value.dev).sort(([a], [b]) => a.split('/').length - b.split('/').length)) {
    const marker = key.lastIndexOf('node_modules/'); const owner = key.slice(0, Math.max(0, marker - 1)); const name = key.slice(marker + 13);
    const parent = locations.get(owner); if (!parent && expected.optional) continue; assert(parent, `Missing installed owner ${owner}.`);
    let resolved;
    try { resolved = packageDirectory(parent, name); } catch (error) { if (expected.optional) continue; throw error; }
    const actual = JSON.parse(fs.readFileSync(path.join(resolved, 'package.json'), 'utf8'));
    assert.equal(actual.version, expected.version, key); locations.set(key, resolved); verified++;
    const lifecycle = ['preinstall', 'install', 'postinstall'].filter(name => actual.scripts?.[name]);
    if (lifecycle.length) { assert.equal(actual.name, 'dtrace-provider'); assert.deepEqual(lifecycle, ['install']); assert.equal(actual.scripts.install, 'node suppress-error.js'); }
    else assert(!fs.existsSync(path.join(resolved, 'binding.gyp')), `Implicit native compilation in ${key}.`);
  }
  assert(verified > 300, 'Expected the complete runtime graph, not just the direct EAS version.');
  const eas = packageDirectory(installed, 'eas-cli');
  assert(JSON.parse(fs.readFileSync(path.join(eas, 'package.json'), 'utf8')).expoReleaseDistribution);
  for (const [name, version] of Object.entries({ minimatch: '5.1.8', nanoid: '3.3.18', tar: '7.5.21' })) {
    assert.equal(JSON.parse(fs.readFileSync(path.join(packageDirectory(eas, name), 'package.json'), 'utf8')).version, version);
  }
  return { verified, eas };
}

test('packed distribution ships executable modules, declarations and shrinkwrap without consumer-copy tests or examples', t => {
  const packed = pack(temporary(t)); const names = packed.files.map(file => file.path);
  for (const required of ['src/index.mjs', 'src/index.d.mts', 'src/expo.cjs', 'src/expo.d.cts', 'npm-shrinkwrap.json',
    'bin/expo-release.mjs', 'bin/expo-release-credentials.mjs', 'packages/release-engine/index.mjs', 'packages/release-engine/index.d.mts', 'vendor/eas-cli-22.4.0.tgz', 'vendor/eas-distribution.json']) assert(names.includes(required), required);
  assert(!names.filter(name => !name.startsWith('node_modules/')).some(name => /(?:^|\/)(?:test|tests|fixtures|examples)(?:\/|$)|(?:^|\/)\.github\//.test(name)));
  for (const lifecycle of ['preinstall', 'install', 'postinstall', 'prepack', 'postpack']) assert.equal(manifest.scripts?.[lifecycle], undefined, lifecycle);
  assert.equal(manifest.scripts.prepare, 'node bin/verify-distribution.mjs');
  assert.deepEqual(manifest.bundleDependencies, ['eas-cli', 'tar', 'typescript']);
  assert.equal(manifest.dependencies['eas-cli'], 'file:vendor/eas-cli-22.4.0.tgz');
  assert.deepEqual(shrinkwrap.packages[''].bin, manifest.bin);
  assert.deepEqual(shrinkwrap.packages[''].dependencies, manifest.dependencies);
  assert.equal(shrinkwrap.packages['node_modules/eas-cli'].version, '22.4.0');
});

test('clean installed package preserves shrinkwrapped runtime graph, executable EAS and independent Expo helper',
  { skip: process.env.EXPO_RELEASE_DISTRIBUTION_TEST !== '1', timeout: 600000 }, t => {
    const directory = temporary(t); const packed = pack(directory); const consumer = path.join(directory, 'consumer');
    fs.mkdirSync(consumer); fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ private: true, dependencies: { [manifest.name]: `file:${packed.tarball.replaceAll('\\', '/')}` } }));
    npm(['install', '--package-lock-only', '--ignore-scripts'], consumer);
    npm(['ci'], consumer);
    npm(['ci', '--ignore-scripts'], consumer);
    const installed = path.join(consumer, 'node_modules', '@mchartier', 'expo-release');
    const { verified, eas: easRoot } = verifyRuntimeGraph(installed);
    const require = createRequire(path.join(consumer, 'package.json'));
    const before = new Set(Object.keys(require.cache));
    assert.deepEqual(require('@mchartier/expo-release/expo').runtimeVersion(), { policy: 'appVersion' });
    assert(!Object.keys(require.cache).filter(key => !before.has(key)).some(key => key.includes('eas-cli')));
    const version = execFileSync(process.execPath, [path.join(easRoot, 'bin/run'), '--version'], { cwd: consumer, encoding: 'utf8', windowsHide: true });
    assert.match(version, /eas-cli\/22\.4\.0/);
    const api = execFileSync(process.execPath, ['--input-type=module', '-e', 'import {planRelease, recoverRelease} from "@mchartier/expo-release"; console.log(typeof planRelease, typeof recoverRelease)'], { cwd: consumer, encoding: 'utf8', windowsHide: true });
    assert.equal(api.trim(), 'function function');
    t.diagnostic(`Verified ${verified} installed runtime package versions from npm-shrinkwrap.json.`);
  });

test('fresh full-SHA Git consumers install the exact runtime with normal and ignored scripts, without lifecycle compilation',
  { skip: process.env.EXPO_RELEASE_DISTRIBUTION_TEST !== '1', timeout: 600000 }, t => {
    const directory = temporary(t); const packed = pack(directory); const repository = path.join(directory, 'source');
    fs.mkdirSync(repository);
    for (const item of packed.files.filter(item => !item.path.startsWith('node_modules/'))) {
      const destination = path.join(repository, item.path); fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.copyFileSync(path.join(root, item.path), destination);
    }
    const git = args => execFileSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    git(['init', '-q']); git(['add', '.']); git(['-c', 'user.name=Package fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Installable package fixture']);
    const commit = git(['rev-parse', 'HEAD']);
    const url = `git+file:///${repository.replaceAll('\\', '/').replace(/^\//, '')}#${commit}`;
    for (const ignore of [false, true]) {
      const consumer = path.join(directory, ignore ? 'ignore-scripts' : 'normal'); fs.mkdirSync(consumer);
      fs.writeFileSync(path.join(consumer, 'package.json'), JSON.stringify({ private: true, dependencies: { [manifest.name]: url } }));
      const cache = path.join(directory, ignore ? 'cache-ignored' : 'cache-normal');
      const environment = { npm_config_cache: cache, npm_config_foreground_scripts: 'true' };
      const flags = ignore ? ['--ignore-scripts'] : [];
      const output = npm(['install', ...flags], consumer, 300000, environment);
      assert(!/\bnode-gyp\b|\bnode-gyp-build\b/.test(output), 'Git dependency preparation attempted native compilation.');
      npm(['ci', ...flags], consumer, 300000, environment);
      const installed = path.join(consumer, 'node_modules/@mchartier/expo-release');
      const { verified } = verifyRuntimeGraph(installed);
      assert.deepEqual(createRequire(path.join(consumer, 'package.json'))('@mchartier/expo-release/expo').runtimeVersion('fingerprint'), { policy: 'fingerprint' });
      t.diagnostic(`Full-SHA Git install ${ignore ? 'with ignored scripts' : 'with normal scripts'} verified ${verified} package versions.`);
    }
  });
