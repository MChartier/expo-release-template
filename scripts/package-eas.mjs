#!/usr/bin/env node
/** @file Reproduces the checked-in EAS distribution from integrity-verified npm archives, patching dependency metadata only and excluding optional native DTrace instrumentation. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { x } from 'tar';

const root = fileURLToPath(new URL('../', import.meta.url));
const lock = JSON.parse(fs.readFileSync(path.join(root, 'npm-shrinkwrap.json'), 'utf8'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-eas-distribution-'));
const stage = path.join(temp, 'eas'); fs.mkdirSync(stage);
const registryEas = JSON.parse(fs.readFileSync(path.join(root, 'vendor/eas-source.json'), 'utf8'));
const originals = [];

async function extract(record, destination, key) {
  assert.equal(new URL(record.resolved).origin, 'https://registry.npmjs.org');
  assert.match(record.integrity, /^sha512-[A-Za-z0-9+/=]+$/);
  const response = await fetch(record.resolved); assert(response.ok, `Cannot download ${key}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(`sha512-${createHash('sha512').update(bytes).digest('base64')}`, record.integrity, `Archive integrity differs: ${key}.`);
  const archive = path.join(temp, `${createHash('sha256').update(key).digest('hex')}.tgz`);
  fs.writeFileSync(archive, bytes); fs.mkdirSync(destination, { recursive: true });
  await x({ file: archive, cwd: destination, strip: 1, preservePaths: false, strict: true });
  originals.push({ key, version: record.version, resolved: record.resolved, integrity: record.integrity });
}

function locate(from, name) {
  for (let directory = from; ; directory = path.dirname(directory)) {
    const candidate = path.join(directory, 'node_modules', name);
    if (fs.existsSync(path.join(candidate, 'package.json'))) return candidate;
    if (directory === path.dirname(directory)) throw new Error(`Install the locked source graph before generating ${name}.`);
  }
}

try {
  assert.equal(registryEas.version, '22.4.0'); await extract(registryEas, stage, 'eas-cli');
  const previousReceipt = path.join(root, 'vendor/eas-distribution.json');
  const previous = fs.existsSync(previousReceipt) ? JSON.parse(fs.readFileSync(previousReceipt, 'utf8')) : null;
  const pending = previous ? [] : ['@expo/logger', 'minimatch', 'nanoid', 'tar'].map(name => locate(path.join(root, 'node_modules/eas-cli'), name));
  const found = new Set(); const entries = [];
  for (const record of previous?.sources || []) if (!['eas-cli', 'dtrace-provider'].includes(record.key)) entries.push({ key: record.key, expected: record,
    destination: path.join(stage, record.key.replace(/^node_modules\/eas-cli\//, '')) });
  while (pending.length) {
    const directory = pending.shift(); if (found.has(directory)) continue; found.add(directory);
    const key = path.relative(root, directory).replaceAll('\\', '/'); const expected = lock.packages[key];
    const pkg = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
    assert.equal(pkg.version, expected?.version, `Source graph differs: ${key}.`);
    const relative = key.replace(/^node_modules\/eas-cli\//, '');
    entries.push({ key, expected, destination: path.join(stage, relative) });
    for (const name of new Set([...Object.keys(pkg.dependencies || {}), ...Object.keys(pkg.optionalDependencies || {})])) {
      if (name === 'dtrace-provider') continue;
      try { pending.push(locate(directory, name)); } catch (error) { if (!pkg.optionalDependencies?.[name]) throw error; }
    }
  }
  for (let offset = 0; offset < entries.length; offset += 8) await Promise.all(entries.slice(offset, offset + 8).map(entry => extract(entry.expected, entry.destination, entry.key)));
  const packageFile = path.join(stage, 'package.json'); const pkg = JSON.parse(fs.readFileSync(packageFile, 'utf8'));
  const patched = { minimatch: '5.1.8', nanoid: '3.3.18', tar: '7.5.21' };
  for (const [name, version] of Object.entries(patched)) pkg.dependencies[name] = version;
  pkg.bundleDependencies = ['@expo/logger', ...Object.keys(patched)];
  pkg.expoReleaseDistribution = { source: registryEas.integrity, dependencyVersions: patched, omittedOptionalInstrumentation: ['dtrace-provider'] };
  fs.writeFileSync(packageFile, `${JSON.stringify(pkg, null, 2)}\n`);
  for (const entry of entries) {
    const file = path.join(entry.destination, 'package.json'); const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (value.name === 'bunyan') { delete value.optionalDependencies['dtrace-provider']; fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`); }
    assert(!['preinstall', 'install', 'postinstall'].some(name => value.scripts?.[name]) && !fs.existsSync(path.join(entry.destination, 'binding.gyp')), `Unexpected compilation lifecycle in ${value.name}.`);
  }
  const npm = process.env.npm_execpath || path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  const packed = JSON.parse(execFileSync(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', temp],
    { cwd: stage, encoding: 'utf8', windowsHide: true, maxBuffer: 32 * 1024 * 1024 }))[0];
  const destination = path.join(root, 'vendor', packed.filename); fs.copyFileSync(path.join(temp, packed.filename), destination);
  const traceSource = JSON.parse(fs.readFileSync(path.join(root, 'vendor/dtrace-source.json'), 'utf8'));
  const traceStage = path.join(temp, 'dtrace'); await extract(traceSource, traceStage, 'dtrace-provider');
  const traceFile = path.join(traceStage, 'package.json'); const trace = JSON.parse(fs.readFileSync(traceFile, 'utf8'));
  assert.equal(trace.scripts.install, 'node-gyp rebuild || node suppress-error.js'); trace.scripts.install = 'node suppress-error.js';
  fs.writeFileSync(traceFile, `${JSON.stringify(trace, null, 2)}\n`);
  const tracePacked = JSON.parse(execFileSync(process.execPath, [npm, 'pack', '--ignore-scripts', '--json', '--pack-destination', temp], { cwd: traceStage, encoding: 'utf8', windowsHide: true }))[0];
  fs.copyFileSync(path.join(temp, tracePacked.filename), path.join(root, 'vendor', tracePacked.filename));
  const receipt = { schemaVersion: 1, filename: packed.filename, sha256: createHash('sha256').update(fs.readFileSync(destination)).digest('hex'),
    bytes: fs.statSync(destination).size, patches: { 'eas-cli/package.json': { dependencies: patched, bundleDependencies: pkg.bundleDependencies },
      'bunyan/package.json': { removedOptionalDependencies: ['dtrace-provider'] }, 'dtrace-provider/package.json': { install: 'node suppress-error.js' } },
    optionalFallback: { filename: tracePacked.filename, sha256: createHash('sha256').update(fs.readFileSync(path.join(temp, tracePacked.filename))).digest('hex') },
    sources: originals.sort((a, b) => a.key.localeCompare(b.key)) };
  fs.writeFileSync(path.join(root, 'vendor/eas-distribution.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  console.log(JSON.stringify({ file: destination, bytes: receipt.bytes, packages: entries.length + 1, sha256: receipt.sha256 }));
} finally {
  assert.equal(path.dirname(path.resolve(temp)), path.resolve(os.tmpdir())); assert(path.basename(temp).startsWith('expo-eas-distribution-'));
  fs.rmSync(temp, { recursive: true, force: true });
}
