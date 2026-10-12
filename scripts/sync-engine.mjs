/** @file Installs an immutable committed engine snapshot into a consumer repository without registry credentials. */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArguments, snapshotDigest, snapshotPath, verifySnapshot } from './verify-engine.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const repository = 'MChartier/expo-release-template';
const defaultSource = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const git = (root, args) => execFileSync('git', ['-C', root, ...args], { maxBuffer: 32 * 1024 * 1024 });

/** Load tracked regular files from one exact commit, never from uncommitted working files. */
export function committedSnapshot(source, revision) {
  if (!/^[a-f0-9]{40}$/.test(revision || '')) throw new Error('Supply the full immutable 40-character source commit.');
  const resolved = git(source, ['rev-parse', '--verify', `${revision}^{commit}`]).toString().trim();
  if (resolved !== revision) throw new Error('The requested revision does not resolve to that exact commit.');
  const entries = git(source, ['ls-tree', '-r', '-z', revision, '--', 'packages/release-engine']).toString().split('\0').filter(Boolean);
  const files = {};
  for (const entry of entries) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\tpackages\/release-engine\/(.+)$/.exec(entry);
    if (!match) throw new Error('Engine source contains a symlink, submodule, or unsupported Git entry.');
    snapshotPath(resolve(source, 'packages/release-engine'), match[3]);
    files[match[3]] = git(source, ['cat-file', 'blob', match[2]]);
  }
  if (!files['index.mjs'] || !files['package.json']) throw new Error('The commit does not contain a complete engine package.');
  if (new Set(Object.keys(files).map(name => name.toLowerCase())).size !== Object.keys(files).length) throw new Error('Engine paths collide on case-insensitive filesystems.');
  const verifier = git(source, ['show', `${revision}:scripts/verify-engine.mjs`]);
  return { files, verifier };
}

/** Replace only a verified managed snapshot; refuse untracked destinations or locally modified managed files. */
export async function syncEngine({ source = defaultSource, revision, target } = {}) {
  if (!target) throw new Error('A consumer repository target is required.');
  const targetRoot = resolve(target);
  const gitRoot = git(targetRoot, ['rev-parse', '--show-toplevel']).toString().trim();
  if (resolve(gitRoot).toLowerCase() !== targetRoot.toLowerCase()) throw new Error('Target must be the consumer repository root.');
  const { files, verifier } = committedSnapshot(resolve(source), revision);
  const root = resolve(targetRoot, 'tools/release-engine');
  const lockPath = resolve(targetRoot, 'release-engine.lock.json');
  try {
    const info = await lstat(resolve(targetRoot, 'tools'));
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Consumer tools must be a real directory.');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  let previous;
  try { previous = JSON.parse(await readFile(lockPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous) await verifySnapshot({ target: targetRoot });
  else {
    for (const path of [root, resolve(targetRoot, 'tools/verify-release-engine.mjs')]) {
      try { await lstat(path); throw new Error(`Unmanaged destination already exists: ${path}`); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  await mkdir(root, { recursive: true });
  for (const name of Object.keys(previous?.files || {})) {
    if (!(name in files)) await unlink(snapshotPath(root, name));
  }
  for (const [name, content] of Object.entries(files)) {
    const path = snapshotPath(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  await writeFile(resolve(targetRoot, 'tools/verify-release-engine.mjs'), verifier);
  const hashes = Object.fromEntries(Object.entries(files).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, content]) => [name, sha256(content)]));
  const lock = { schemaVersion: 1, repository, revision, packageVersion: JSON.parse(files['package.json'].toString()).version, digest: snapshotDigest(hashes), verifierDigest: sha256(verifier), files: hashes };
  await writeFile(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  const attributesPath = resolve(targetRoot, '.gitattributes');
  let attributes = '';
  try {
    if ((await lstat(attributesPath)).isSymbolicLink()) throw new Error('Consumer Git attributes must not be a symbolic link.');
    attributes = await readFile(attributesPath, 'utf8');
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const directives = ['tools/release-engine/** -text', 'tools/verify-release-engine.mjs -text'];
  const missing = directives.filter(line => !attributes.split(/\r?\n/).includes(line));
  if (missing.length) await writeFile(attributesPath, `${attributes.replace(/\s*$/, '')}\n\n# Preserve the shared release engine snapshot byte-for-byte across platforms.\n${missing.join('\n')}\n`);
  return verifySnapshot({ target: targetRoot, revision });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await syncEngine(parseArguments(process.argv.slice(2), ['source', 'revision', 'target']));
    process.stdout.write(`Installed ${result.repository}@${result.revision} (${result.files} files). Update the pinned action/workflow reference to the same revision.\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
