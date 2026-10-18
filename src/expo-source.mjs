/** @file Credential-free SDK resolution and export from an exact application checkout; providers never import this module. */
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { invariant } from '../packages/release-engine/index.mjs';
import { sourceEnvironment } from './hooks.mjs';

/** Resolve public Expo configuration and the managed SDK runtime using the application's installed dependency versions. */
export function inspectExpoSource({ directory, platform, environment = {}, execute = execFileSync }) {
  invariant(['android', 'ios'].includes(platform), 'Invalid Expo source platform.');
  const require = createRequire(path.join(directory, 'package.json'));
  const env = { ...sourceEnvironment(process.env, environment), NODE_ENV: 'production', EXPO_NO_DOTENV: '1', EXPO_NO_METRO_WORKSPACE_ROOT: '1',
    EXPO_UPDATES_WORKFLOW_OVERRIDE: 'managed', EXPO_UPDATES_FINGERPRINT_OVERRIDE: '' };
  const run = args => execute(process.execPath, args, { cwd: directory, env, encoding: 'utf8',
    windowsHide: true, maxBuffer: 32 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const runtime = JSON.parse(run([path.join(path.dirname(require.resolve('expo-updates/package.json')), 'bin', 'cli'),
    'runtimeversion:resolve', '--platform', platform, '--workflow', 'managed']));
  const expoConfig = JSON.parse(run([require.resolve('expo/bin/cli'), 'config', '--type', 'public', '--json']));
  invariant(typeof runtime.runtimeVersion === 'string' && runtime.runtimeVersion && expoConfig.extra?.eas?.projectId,
    'Expo source runtime/project identity is incomplete.');
  return { runtime: runtime.runtimeVersion, resolution: runtime, expoConfig };
}

/** Export only JavaScript/assets with no publication credentials and no provider invocation. */
export function exportExpoSource({ directory, platform, outputDirectory, environment = {}, execute = execFileSync }) {
  const require = createRequire(path.join(directory, 'package.json'));
  execute(process.execPath, [require.resolve('expo/bin/cli'), 'export', '--platform', platform, '--output-dir', outputDirectory], {
    cwd: directory, env: { ...sourceEnvironment(process.env, environment), NODE_ENV: 'production', EXPO_NO_DOTENV: '1', EXPO_NO_METRO_WORKSPACE_ROOT: '1' },
    windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'], maxBuffer: 32 * 1024 * 1024 });
}
