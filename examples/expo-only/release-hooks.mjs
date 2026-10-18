/** @file Minimal serverless Expo source hooks: inspect real native fingerprints and shipped Git inputs, validate source, export OTA and check public identity. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { hashIdentity } from '@mchartier/expo-release';

/** Observe application facts only; the shared planner owns comparison, selection, versions and stage order. */
export function expoOnlyObservations({ fingerprint, compatibility, bundle, expoConfig, environmentHash }) {
  const common = { runtime: expoConfig.version, version: expoConfig.version, versionCode: expoConfig.android.versionCode,
    fingerprint, environmentHash, expoConfig, releaseMetadata: { version: expoConfig.version, androidVersionCode: expoConfig.android.versionCode, expoProjectId: expoConfig.extra?.eas?.projectId } };
  return [{ ...common, id: 'android', identity: compatibility, compatibilityIdentity: compatibility }, { ...common, id: 'android.ota', identity: bundle }];
}

function bundleIdentity(root, source) {
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  const files = git(['ls-tree', '-r', '--name-only', source, '--', 'app', 'src', 'assets', 'App.tsx', 'index.js', 'package.json', 'package-lock.json', 'app.json', 'app.config.cjs', 'babel.config.js', 'metro.config.js'])
    .trim().split(/\r?\n/).filter(file => file && !/(?:^|\/)(__tests__|fixtures)(?:\/|$)|\.(test|spec)\./.test(file));
  return hashIdentity(files.map(file => {
    let contents = git(['show', `${source}:${file}`]);
    if (['package.json', 'package-lock.json', 'app.json'].includes(file)) {
      contents = JSON.parse(contents); delete contents.version;
      if (contents.expo) { delete contents.expo.version; delete contents.expo.android?.versionCode; delete contents.expo.ios?.buildNumber; }
      if (contents.packages?.['']) delete contents.packages[''].version;
    }
    return [file, contents];
  }));
}

/** Execute the bounded source-hook JSON protocol; credentials are scrubbed by the shared caller before this process starts. */
export async function runExpoOnlyHook(request) {
  const root = request.root; const require = createRequire(resolve(root, 'package.json'));
  if (request.runtimeOverrides) process.env.EXPO_ONLY_RUNTIME_METADATA = JSON.stringify(request.runtimeOverrides);
  const publicConfig = () => require('@expo/config').getConfig(root, { isPublicConfig: true }).exp;
  const run = args => execFileSync(process.execPath, args, { cwd: root, stdio: ['ignore', 2, 2], windowsHide: true });
  if (request.action === 'inspect') {
    const { createFingerprintAsync, DEFAULT_SOURCE_SKIPS, SourceSkips } = require('@expo/fingerprint');
    const fingerprint = (await createFingerprintAsync(root, { platforms: ['android'], silent: true })).hash;
    const compatibility = (await createFingerprintAsync(root, { platforms: ['android'], silent: true, sourceSkips: DEFAULT_SOURCE_SKIPS | SourceSkips.ExpoConfigVersions })).hash;
    return { schemaVersion: 1, observations: expoOnlyObservations({ fingerprint, compatibility, bundle: bundleIdentity(root, typeof request.source === 'string' ? request.source : request.source.commit), expoConfig: publicConfig(), environmentHash: request.environmentHash }) };
  }
  if (request.action === 'validate') {
    // The consumer supplies its own check script; shared CI never guesses application tests.
    execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'check'], { cwd: root, stdio: ['ignore', 2, 2], shell: process.platform === 'win32', windowsHide: true });
    return { schemaVersion: 1, validated: true };
  }
  if (request.action === 'build' && request.phase === 'export') {
    run([require.resolve('expo/bin/cli'), 'export', '--platform', 'android', '--output-dir', request.outputDirectory]);
    return { schemaVersion: 1, artifact: { target: request.target, directory: request.outputDirectory, runtime: publicConfig().version, metadata: { expoConfig: publicConfig() } } };
  }
  if (request.action === 'verify') {
    const config = publicConfig(); const expected = request.binding;
    if (config.android.package !== request.config.components.find(value => value.id === 'android').applicationId
      || config.extra?.eas?.projectId !== request.config.expo.projectId || expected && config.version !== expected.runtime) throw new Error('Exported application/runtime identity differs.');
    return { schemaVersion: 1, verified: true };
  }
  throw new Error('Unsupported Expo-only source hook phase.');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = await runExpoOnlyHook(JSON.parse(readFileSync(0, 'utf8')));
  process.stdout.write(`${JSON.stringify(result)}\n`);
}
