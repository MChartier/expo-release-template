/** @file Tests immutable consumer synchronization, upstream verification, drift detection, and filesystem boundaries. */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { committedSnapshot, syncEngine } from '../scripts/sync-engine.mjs';
import { snapshotPath, verifySnapshot } from '../scripts/verify-engine.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (cwd, args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'expo-engine-sync-'));
  const source = join(directory, 'source');
  const target = join(directory, 'consumer');
  await mkdir(join(source, 'packages/release-engine/test'), { recursive: true });
  await mkdir(join(source, 'scripts'), { recursive: true });
  await mkdir(target);
  await writeFile(join(source, 'packages/release-engine/index.mjs'), '/** @file Fixture library. */\nexport const version = 1;\n');
  await writeFile(join(source, 'packages/release-engine/package.json'), '{"name":"fixture","version":"1.0.0","type":"module"}\n');
  await writeFile(join(source, 'packages/release-engine/test/example.test.mjs'), '/** @file Fixture test inventory. */\n');
  await writeFile(join(source, 'scripts/verify-engine.mjs'), await readFile(join(root, 'scripts/verify-engine.mjs')));
  for (const directory of [source, target]) {
    git(directory, ['init', '--initial-branch=main']);
    git(directory, ['config', 'core.autocrlf', 'false']);
  }
  git(source, ['add', '.']);
  git(source, ['-c', 'user.name=Engine tests', '-c', 'user.email=engine@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'Fixture']);
  return { source, target, revision: git(source, ['rev-parse', 'HEAD']) };
}

test('installs committed bytes and verifies them against the authoritative revision', async () => {
  const f = await fixture();
  await writeFile(join(f.source, 'packages/release-engine/index.mjs'), 'uncommitted changes must not be copied');
  const result = await syncEngine(f);
  assert.equal(result.revision, f.revision);
  assert.match(await readFile(join(f.target, 'tools/release-engine/index.mjs'), 'utf8'), /version = 1/);
  await assert.rejects(verifySnapshot(f), /upstream source/);
  git(f.source, ['restore', 'packages/release-engine/index.mjs']);
  assert.deepEqual(await verifySnapshot(f), result);
  assert.deepEqual(await syncEngine(f), result);
});

test('accepts a repository root reached through a directory alias', async () => {
  const f = await fixture();
  const alias = join(f.source, 'consumer-alias');
  await symlink(f.target, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const result = await syncEngine({ ...f, target: alias });
  assert.equal(result.revision, f.revision);
  assert.deepEqual(await verifySnapshot(f), result);
});

test('refuses to overwrite locally modified managed files', async () => {
  const f = await fixture();
  await syncEngine(f);
  const path = join(f.target, 'tools/release-engine/index.mjs');
  await writeFile(path, 'keep this local edit');
  await assert.rejects(syncEngine(f), /snapshot changed/);
  assert.equal(await readFile(path, 'utf8'), 'keep this local edit');
});

test('rejects extra files, changed verifier, and a different action revision', async () => {
  const f = await fixture();
  await syncEngine(f);
  await assert.rejects(verifySnapshot({ ...f, revision: 'f'.repeat(40) }), /revision and engine lock differ/);
  await writeFile(join(f.target, 'tools/verify-release-engine.mjs'), 'changed');
  await assert.rejects(verifySnapshot(f), /verification script changed/);
  await writeFile(join(f.target, 'tools/verify-release-engine.mjs'), await readFile(join(f.source, 'scripts/verify-engine.mjs')));
  await writeFile(join(f.target, 'tools/release-engine/injected.mjs'), 'unexpected');
  await assert.rejects(verifySnapshot(f), /file set differs/);
});

test('rejects branch names and incomplete commits instead of following mutable refs', async () => {
  const f = await fixture();
  assert.throws(() => committedSnapshot(f.source, 'main'), /immutable/);
  assert.throws(() => committedSnapshot(f.source, f.revision.slice(0, 7)), /immutable/);
});

test('rejects existing unmanaged destination and linked tools directory', async () => {
  const f = await fixture();
  const outside = join(f.source, 'external-tools');
  await mkdir(outside);
  await symlink(outside, join(f.target, 'tools'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(syncEngine(f), /real directory/);
  const next = await fixture();
  await mkdir(join(next.target, 'tools/release-engine'), { recursive: true });
  await assert.rejects(syncEngine(next), /Unmanaged destination/);
});

test('rejects a linked falsy lock before modifying any consumer or outside file', async (t) => {
  const f = await fixture();
  const outside = join(f.source, 'outside-lock.json');
  await writeFile(outside, 'null\n');
  try {
    await symlink(outside, join(f.target, 'release-engine.lock.json'), 'file');
  } catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      t.skip('Windows requires symlink privilege for this file-link fixture; Linux CI verifies it.');
      return;
    }
    throw error;
  }
  await assert.rejects(syncEngine(f), /lock.*regular|lock.*symbolic|regular.*lock/i);
  assert.equal(await readFile(outside, 'utf8'), 'null\n');
  await assert.rejects(readFile(join(f.target, 'tools/release-engine/index.mjs')), { code: 'ENOENT' });
});

test('an existing falsy lock is corrupt managed state rather than a first installation', async () => {
  const f = await fixture();
  for (const invalid of ['null', 'false', '0', '""']) {
    await writeFile(join(f.target, 'release-engine.lock.json'), `${invalid}\n`);
    await assert.rejects(syncEngine(f));
    assert.equal(await readFile(join(f.target, 'release-engine.lock.json'), 'utf8'), `${invalid}\n`);
    await assert.rejects(readFile(join(f.target, 'tools/release-engine/index.mjs')), { code: 'ENOENT' });
  }
});

test('path validation rejects traversal, alternate data streams, and platform-dependent separators', () => {
  for (const name of ['../other', '/absolute', 'C:/other', 'a\\b', 'a//b', 'a/./b', 'a/../b', '']) {
    assert.throws(() => snapshotPath(root, name), /Unsafe|escapes/);
  }
  assert.equal(snapshotPath(root, 'test/file.mjs'), resolve(root, 'test/file.mjs'));
});
