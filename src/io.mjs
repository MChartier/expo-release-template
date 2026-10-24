/** @file Portable process, JSON, Git-input and artifact primitives shared by fixed workflow steps. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { assert } from './engine.mjs';

/** Hash canonical JSON or bytes for deterministic identities. */
export function hash(value) {
  const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object'
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
  return createHash('sha256').update(Buffer.isBuffer(value) ? value : JSON.stringify(stable(value))).digest('hex');
}

/** Read a saved JSON document; malformed or missing evidence is an error. */
export function readJson(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

/** Write JSON with a final newline, creating only its parent directory. */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** Resolve a repository-relative path without allowing traversal or another drive. */
export function within(root, relative) {
  const resolved = path.resolve(root, relative);
  assert(resolved === path.resolve(root) || resolved.startsWith(`${path.resolve(root)}${path.sep}`), 'Path escapes its checkout.');
  return resolved;
}

/** Execute argv without a shell; npm's JavaScript launcher also works on Windows. */
export function run(command, args = [], options = {}) {
  if (process.platform === 'win32' && ['npm', 'eas'].includes(command)) {
    const shim = execFileSync('where.exe', [`${command}.cmd`], { encoding: 'utf8', windowsHide: true }).trim().split(/\r?\n/)[0];
    args = [path.join(path.dirname(shim), 'node_modules', command === 'npm' ? 'npm/bin/npm-cli.js' : 'eas-cli/bin/run'), ...args];
    command = process.execPath;
  }
  return execFileSync(command, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    stdio: ['pipe', 'pipe', 'inherit'], ...options });
}

/** Run Git against an explicitly selected checkout. */
export function git(root, args) { return run('git', args, { cwd: root }).trimEnd(); }

/** Construct a source-only process environment; credentials never flow into repository hooks. */
export function sourceEnvironment(values = {}, base = process.env) {
  const allowed = /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|LOCALAPPDATA|APPDATA|JAVA_HOME|ANDROID_HOME|ANDROID_SDK_ROOT|ANDROID_BUILD_TOOLS_VERSION|BUNDLETOOL_JAR|LANG|LC_ALL|CI|NUMBER_OF_PROCESSORS)$/i;
  const env = Object.fromEntries(Object.entries(base).filter(([key]) => allowed.test(key)));
  for (const [key, value] of Object.entries(values)) {
    assert(!/TOKEN|PASSWORD|PRIVATE|SECRET|CREDENTIAL|NODE_OPTIONS|GITHUB_|AWS_/i.test(key), `Private or executable environment input: ${key}`);
    env[key] = String(value);
  }
  return { ...env, CI: '1', EXPO_NO_DOTENV: '1' };
}

/** Hash tracked paths and Git blob IDs, retaining binary, mode, rename, and deletion changes. */
export function trackedIdentity(root, ref, { include = () => true, content = () => 'blob', normalize = (_file, text) => text } = {}) {
  const entries = git(root, ['ls-tree', '-r', '-z', ref]).split('\0').filter(Boolean).map(line => {
    const boundary = line.indexOf('\t');
    return { file: line.slice(boundary + 1), info: line.slice(0, boundary) };
  }).filter(({ file }) => include(file)).sort((a, b) => a.file.localeCompare(b.file));
  return hash(entries.map(({ file, info }) => [file, info.split(' ')[0], content(file) === 'text'
    ? normalize(file, git(root, ['show', `${ref}:${file}`])) : info.split(' ').at(-1)]));
}

/** Match configured directory/file prefixes, excluding only documented non-production files. */
export function inputIdentity(root, ref, inputs) {
  return trackedIdentity(root, ref, { include: file => inputs.some(p => p === '.' || file === p || file.startsWith(`${p}/`))
    && !/(^|\/)(node_modules|docs|__tests__|__mocks__|test|tests)(\/|$)|\.(test|spec)\.|\.md$/.test(file) });
}

/** Hash every regular artifact file; reject links so publishers cannot read outside an artifact. */
export function inventory(directory) {
  const files = {};
  const visit = prefix => {
    for (const entry of fs.readdirSync(path.join(directory, prefix), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = path.posix.join(prefix, entry.name);
      assert(!entry.isSymbolicLink(), 'Artifact links are forbidden.');
      if (entry.isDirectory()) visit(relative);
      else { assert(entry.isFile(), 'Unsupported artifact entry.'); files[relative] = hash(fs.readFileSync(path.join(directory, relative))); }
    }
  };
  visit('');
  return files;
}

/** Bind exact artifact bytes to the producing run and immutable plan. */
export function seal(directory, plan, target) {
  const receipt = { format: 3, run: plan.run, source: plan.source, toolkit: plan.toolkit, plan: hash(plan), target, files: inventory(directory) };
  assert(Object.keys(receipt.files).length > 0, 'Cannot publish an empty artifact.');
  writeJson(`${directory}.json`, receipt);
  return receipt;
}

/** Accept only the current trusted run's exact files, never a local or previous-run receipt. */
export function verify(directory, plan, target, receipt = readJson(`${directory}.json`)) {
  assert(receipt.format === 3 && receipt.run === plan.run && receipt.source === plan.source && receipt.toolkit === plan.toolkit
    && receipt.plan === hash(plan) && receipt.target === target && hash(receipt.files) === hash(inventory(directory)), 'Artifact identity or digest mismatch.');
  return receipt;
}
