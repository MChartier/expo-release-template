/** @file Validate the small configuration contract; EAS remains authoritative for build/submit profiles. */
import Ajv from 'ajv';
import { readJson, within, sourceEnvironment, hash } from './io.mjs';
import { assert } from './engine.mjs';
const validate = new Ajv({ allErrors: true }).compile(readJson(new URL('../schemas/release.config.schema.json', import.meta.url)));

/** Load only JSON, rejecting unsupported legacy contracts before any source or provider operation. */
export function loadConfig(root = process.cwd()) {
  const value = readJson(within(root, 'release.config.json'));
  assert(validate(value), `Invalid release.config.json: ${JSON.stringify(validate.errors)}`);
  assert(value.mobile || value.server, 'Configure at least one release path.');
  for (const file of [...value.metadataFiles, ...(value.mobile?.inputs ?? []), ...(value.server?.inputs ?? []), value.mobile?.directory, value.server?.dockerfile].filter(Boolean)) within(root, file);
  for (const profile of Object.values(value.profiles)) {
    assert(profile.approvalEnvironment, 'Publication needs a protected environment.');
    sourceEnvironment(profile.publicEnvironment);
    if (value.mobile) assert(profile.channel && profile.easProfile, 'Mobile profiles need channel and easProfile.');
    if (value.server) assert(profile.deployEnvironment, 'Deployment needs a protected environment.');
  }
  if (value.mobile) {
    assert(new Set(value.mobile.targets.map(t => t.id)).size === value.mobile.targets.length, 'Duplicate native target.');
    assert(value.mobile.builder !== 'command' || (value.hooks?.buildPrepare && value.hooks?.build && value.hooks?.verify), 'Command builds require preparation, build and verification hooks.');
    assert(value.mobile.pairCodeFloor === undefined || (value.mobile.builder === 'command' && value.mobile.targets.length === 2
      && value.mobile.targets.every(t => t.platform === 'android')), 'Paired codes require two Android command-build targets.');
  }
  return value;
}

/** Add derived platforms without growing the configuration DSL. */
export function configured(config) {
  return { ...config, ...(config.mobile ? { mobile: { ...config.mobile, platforms: [...new Set(config.mobile.targets.map(t => t.platform))] } } : {}) };
}

/** Require package and workflow installation to name the exact immutable toolkit revision. */
export function verifyPins(root, sha) {
  assert(/^[a-f0-9]{40}$/.test(sha), 'Toolkit must be pinned to a full commit SHA.');
  const packageJson = readJson(within(root, 'package.json'));
  const dependency = packageJson.devDependencies?.['@mchartier/expo-release'] ?? packageJson.dependencies?.['@mchartier/expo-release'];
  assert(dependency === `git+https://github.com/MChartier/expo-release-template.git#${sha}`, 'Package/workflow toolkit pins differ.');
  const lock = readJson(within(root, 'package-lock.json'));
  assert(lock.packages?.['node_modules/@mchartier/expo-release']?.resolved?.endsWith(`#${sha}`), 'Regenerate the consumer dependency lock normally.');
}

/** Verify that source-generated plans cannot redirect the trusted publisher to other destinations. */
export function verifyPlan(plan, config, identity) {
  assert(plan.format === 3 && hash(plan.config) === hash(config) && plan.repository === identity.repository
    && plan.source === identity.source && plan.toolkit === identity.toolkit && plan.run === identity.run, 'Plan producer or configured destination differs.');
}
