/** @file Source-only inspection and stamping; repository code never receives publication credentials. */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { hash, inputIdentity, run, git, readJson, writeJson, within, sourceEnvironment } from './io.mjs';
import { assert, selectRelease } from './engine.mjs';
import { configured } from './config.mjs';

/** Invoke a declared argv hook with a JSON request and a credential-free environment. */
export function hook(root, config, action, request, extraEnvironment = {}) {
  const command = config.hooks?.[action];
  if (!command) return {};
  const result = run(command[0], command.slice(1), { cwd: root, env: sourceEnvironment(extraEnvironment),
    input: JSON.stringify({ root, action, ...request }) });
  return JSON.parse(result || '{}');
}

/** Inspect native compatibility using the consumer's installed official Expo SDK. */
export function expoInfo(root, config, profile, platform, extra = {}) {
  const directory = within(root, config.mobile.directory);
  const require = createRequire(path.join(directory, 'package.json'));
  const environment = sourceEnvironment({ ...config.profiles[profile].publicEnvironment, ...extra,
    EAS_BUILD_PLATFORM: platform, EAS_BUILD_PROFILE: config.profiles[profile].easProfile });
  const expo = JSON.parse(run(process.execPath, [path.join(path.dirname(require.resolve('expo/package.json')), 'bin/cli'), 'config', '--type', 'public', '--json'], { cwd: directory, env: environment }));
  const fingerprintModule = require.resolve('@expo/fingerprint');
  const script = `const f=require(process.argv[1]);f.createFingerprintAsync(process.cwd(),{platforms:[process.argv[2]],silent:true,sourceSkips:3}).then(x=>console.log(JSON.stringify(x)));`;
  const fingerprint = JSON.parse(run(process.execPath, ['-e', script, fingerprintModule, platform], { cwd: directory, env: environment }));
  assert(typeof fingerprint.hash === 'string' && fingerprint.hash.length >= 32, 'Expo returned no fingerprint.');
  assert(expo.extra?.eas?.projectId === config.mobile.projectId && expo.owner === config.mobile.owner && expo.slug === config.mobile.slug, 'Resolved Expo project differs from configuration.');
  const applicationId = platform === 'android' ? expo.android?.package : expo.ios?.bundleIdentifier;
  assert(config.mobile.targets.filter(t => t.platform === platform).every(t => t.applicationId === applicationId), 'Resolved application identifier differs.');
  return { fingerprint: fingerprint.hash, expo };
}

/** Inspect every configured native environment so a shared runtime family is stable across profiles. */
export function inspect(root, rawConfig, ref = git(root, ['rev-parse', 'HEAD']), environments = {}) {
  const config = configured(rawConfig);
  const custom = hook(root, config, 'inspect', { source: ref, config });
  const observation = { server: config.server ? custom.server ?? inputIdentity(root, ref, config.server.inputs) : null,
    js: {}, fingerprints: {}, metadata: {}, family: null };
  if (config.mobile) {
    for (const platform of config.mobile.platforms) observation.js[platform] = custom.js?.[platform] ?? inputIdentity(root, ref, config.mobile.inputs);
    for (const profile of Object.keys(config.profiles)) {
      observation.fingerprints[profile] = {};
      observation.metadata[profile] = {};
      for (const platform of config.mobile.platforms) {
        const info = expoInfo(root, config, profile, platform, environments[profile]);
        observation.fingerprints[profile][platform] = info.fingerprint;
        observation.metadata[profile][platform] = { version: info.expo.version, runtime: info.expo.runtimeVersion };
      }
    }
    observation.family = hash({ fingerprints: observation.fingerprints, extraNative: custom.extraNative ?? null,
      environments: Object.fromEntries(Object.entries(config.profiles).map(([profile, spec]) => [profile, { ...spec.publicEnvironment, ...environments[profile] }])),
      targets: config.mobile.targets.map(({ id, platform, applicationId }) => ({ id, platform, applicationId })) });
  }
  return observation;
}

/** Prepare an immutable versioned build commit without writing to the default branch. */
export function prepare(root, config, context, profile, rebuild) {
  assert(git(root, ['rev-parse', 'HEAD']) === context.source && !git(root, ['branch', '--show-current'])
    && !git(root, ['status', '--porcelain', '--untracked-files=no']), 'Prepare requires a clean detached checkout of the selected source.');
  const observation = inspect(root, config, context.source, context.environments);
  const plan = { ...selectRelease(configured(config), profile, observation, context.history, rebuild),
    config, environments: context.environments, repository: config.repository, source: context.source, toolkit: context.toolkit, run: context.run };
  if (plan.noop) return plan;
  hook(root, config, 'prepare', { plan });
  if (config.mobile) {
    const current = inspect(root, config, context.source, context.environments);
    assert(current.family === observation.family, 'Version stamping changed native compatibility.');
    if (plan.bump) assert(Object.values(current.metadata[profile]).every(info => info.version === plan.versions.mobile && info.runtime === plan.runtime),
      'Preparation must stamp the allocated version and major-only runtime.');
  }
  hook(root, config, 'validate', { plan }, plan.environments[profile]);
  const changed = git(root, ['diff', '--name-only']).split(/\r?\n/).filter(Boolean);
  assert(changed.every(file => config.metadataFiles.includes(file)), 'Preparation changed files outside declared metadata.');
  if (changed.length) git(root, ['add', '--', ...changed]);
  git(root, ['-c', 'user.name=Release automation', '-c', 'user.email=release@users.noreply.github.com',
    'commit', '--allow-empty', '-m', `Prepare release ${plan.versions.mobile ?? plan.versions.server}`]);
  plan.build = git(root, ['rev-parse', 'HEAD']);
  return plan;
}

/** Export exact OTA bytes from the tagged build checkout without an Expo token. */
export function exportBundle(root, plan, platform, directory) {
  const { config, profile } = plan;
  const current = expoInfo(root, config, profile, platform, plan.environments[profile]);
  assert(current.fingerprint === plan.observation.fingerprints[profile][platform] && current.expo.runtimeVersion === plan.runtime,
    'Export is incompatible with the planned runtime.');
  const app = within(root, config.mobile.directory), require = createRequire(path.join(app, 'package.json'));
  run(process.execPath, [path.join(path.dirname(require.resolve('expo/package.json')), 'bin/cli'), 'export', '--platform', platform,
    '--output-dir', path.resolve(directory)], { cwd: app, env: sourceEnvironment({ ...config.profiles[profile].publicEnvironment, ...plan.environments[profile],
      EAS_BUILD_PLATFORM: platform, EAS_BUILD_PROFILE: config.profiles[profile].easProfile }), stdio: 'inherit' });
  writeJson(path.join(directory, 'expo-release.json'), { expo: current.expo, runtime: plan.runtime, version: plan.versions.mobile, platform });
}
