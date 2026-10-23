/** @file Installs official provider tools in an atomic external cache without release credentials. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { invariant } from '../packages/release-engine/index.mjs';
import { sourceEnvironment } from './hooks.mjs';

const source = fileURLToPath(new URL('../toolchain/', import.meta.url));
const version = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8')).dependencies['eas-cli'];

/** Resolve the cache from the shipped lock and host ABI without installing or authenticating. */
export function toolchainLocation(environment = process.env) {
  const digest = createHash('sha256');
  for (const name of ['package.json', 'package-lock.json']) digest.update(fs.readFileSync(path.join(source, name)));
  const base = environment.EXPO_RELEASE_TOOLCHAIN_CACHE || path.join(environment.LOCALAPPDATA || environment.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'expo-release');
  return path.resolve(base, `${digest.digest('hex')}-${process.platform}-${process.arch}-node${process.versions.node.split('.')[0]}`);
}

/** Verify completed setup before resolving a provider module or executable. */
export function resolveToolchain(environment = process.env) {
  const directory = toolchainLocation(environment);
  invariant(fs.existsSync(path.join(directory, '.ready')), 'Provider tools are not installed. Run expo-release setup.');
  const manifest = path.join(directory, 'node_modules/eas-cli/package.json');
  invariant(JSON.parse(fs.readFileSync(manifest, 'utf8')).version === version && fs.existsSync(path.join(directory, 'node_modules/eas-cli/bin/run')), 'Provider toolchain is incomplete. Run expo-release setup in a fresh external cache.');
  return directory;
}

/** Install a locked official toolchain atomically; failed installs never become reusable cache entries. */
export function setupToolchain({ environment = process.env, run = execFileSync, npmCli } = {}) {
  const directory = toolchainLocation(environment);
  if (fs.existsSync(path.join(directory, '.ready'))) return { directory: resolveToolchain(environment), version, cached: true };
  const parent = path.dirname(directory);
  invariant(!directory.startsWith(`${path.resolve(process.cwd())}${path.sep}`), 'Provider tools must use an external cache, outside application source.');
  fs.mkdirSync(parent, { recursive: true });
  const temporary = fs.mkdtempSync(path.join(parent, '.install-'));
  let phase = 'npm installation';
  try {
    for (const name of ['package.json', 'package-lock.json']) fs.copyFileSync(path.join(source, name), path.join(temporary, name));
    const candidates = [npmCli, environment.npm_execpath, path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'), path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js')].filter(Boolean);
    const executable = candidates.find(file => fs.existsSync(file));
    invariant(executable, 'Cannot locate npm. Run setup through npm exec -- expo-release setup.');
    run(process.execPath, [executable, 'ci', '--prefix', temporary, '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: temporary, env: sourceEnvironment(environment), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000, maxBuffer: 16 * 1024 * 1024,
    });
    phase = 'EAS executable check';
    run(process.execPath, [path.join(temporary, 'node_modules/eas-cli/bin/run'), '--version'], {
      cwd: temporary, env: sourceEnvironment(environment), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000,
    });
    fs.writeFileSync(path.join(temporary, '.ready'), `${version}\n`);
    phase = 'cache activation';
    try { fs.renameSync(temporary, directory); }
    catch (error) { if (!fs.existsSync(path.join(directory, '.ready'))) throw error; }
    return { directory: resolveToolchain(environment), version, cached: false };
  } catch (error) {
    // Report only fixed phase/status/code fields; npm output can include private registry configuration.
    const code = /npm (?:ERR!|error) code ([A-Z][A-Z0-9_]{1,40})\b/.exec(String(error.stderr ?? ''))?.[1]
      || (/^[A-Z][A-Z0-9_]{1,40}$/.test(error.code ?? '') ? error.code : 'unknown');
    throw new Error(`Provider setup failed during ${phase} (${code}, exit ${Number.isInteger(error.status) ? error.status : 'unknown'}); no incomplete cache was activated. Check npm registry access and rerun expo-release setup.`);
  }
  finally {
    invariant(path.dirname(path.resolve(temporary)) === parent, 'Toolchain cleanup escaped its cache.');
    // Windows scanners can briefly hold files open. An inaccessible staging folder is never a reusable cache.
    try { fs.rmSync(temporary, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
    catch { /* Preserve the setup failure instead of masking it with a cleanup error; the next attempt uses a new directory. */ }
  }
}
