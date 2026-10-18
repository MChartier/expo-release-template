#!/usr/bin/env node
/** @file Verifies the already-installed shrinkwrapped toolchain before Git packaging; performs no downloads, mutation, compilation or provider calls. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'npm-shrinkwrap.json'), 'utf8'));
assert.deepEqual(lock.packages[''].dependencies, manifest.dependencies);
assert.deepEqual(lock.packages[''].bin, manifest.bin);
const locations = new Map([['', root]]); let verified = 0;
for (const [key, expected] of Object.entries(lock.packages).filter(([key, value]) => key && !value.dev).sort(([a], [b]) => a.split('/').length - b.split('/').length)) {
  const marker = key.lastIndexOf('node_modules/'); const owner = key.slice(0, Math.max(0, marker - 1)); const name = key.slice(marker + 13);
  const parent = locations.get(owner); if (!parent && expected.optional) continue;
  assert(parent, `Missing runtime dependency owner ${owner}.`);
  let location;
  for (let directory = parent; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) { location = candidate; break; }
    if (directory === path.dirname(directory)) break;
  }
  if (!location && expected.optional) continue;
  assert(location, `Missing runtime dependency ${key}; run npm ci.`);
  const actual = JSON.parse(fs.readFileSync(path.join(location, 'package.json'), 'utf8'));
  assert.equal(actual.version, expected.version, `Runtime dependency differs: ${key}.`);
  const lifecycle = ['preinstall', 'install', 'postinstall'].filter(name => actual.scripts?.[name]);
  if (lifecycle.length) {
    assert.equal(actual.name, 'dtrace-provider', `Unexpected lifecycle in ${key}.`);
    assert.deepEqual(lifecycle, ['install']);
    assert.equal(actual.scripts.install, 'node suppress-error.js', 'Optional instrumentation must use the existing JavaScript fallback.');
  } else assert(!fs.existsSync(path.join(location, 'binding.gyp')), `Implicit native compilation in ${key}.`);
  if (actual.name === 'eas-cli') {
    const receipt = JSON.parse(fs.readFileSync(path.join(root, 'vendor/eas-distribution.json'), 'utf8'));
    assert(actual.expoReleaseDistribution, 'EAS executable package must be the reviewed distribution.');
    for (const [name, version] of Object.entries(receipt.patches['eas-cli/package.json'].dependencies)) assert.equal(actual.dependencies[name], version, `EAS dependency declaration differs: ${name}.`);
  }
  locations.set(key, location); verified++;
}
console.log(`Verified ${verified} installed runtime packages; no compilation required.`);
