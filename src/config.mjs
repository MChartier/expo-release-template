/** @file Validate the declarative consumer boundary before invoking hooks or provider transports. */
import fs from 'node:fs';
import path from 'node:path';
import { invariant, validateId } from '../packages/release-engine/index.mjs';
import { validatePromotions } from './promotion-config.mjs';

const KINDS = new Set(['server', 'native', 'ota']);
const HOOKS = new Set(['inspect', 'prepare', 'validate', 'build', 'verify']);

/** Resolve a repository-relative path without admitting traversal, absolute paths, or Windows aliases. */
export function repositoryPath(root, relative) {
  invariant(typeof relative === 'string' && relative.length > 0 && !relative.includes('\\') && !relative.includes(':')
    && !relative.startsWith('/') && relative.split('/').every(part => part && part !== '.' && part !== '..'), 'Expected a repository-relative path.');
  const result = path.resolve(root, relative);
  invariant(result.startsWith(`${path.resolve(root)}${path.sep}`), 'Repository path escapes its root.');
  return result;
}

/** Validate supported component capabilities; application names never select implementation branches. */
export function validateConfig(config) {
  invariant(config?.schemaVersion === 1, 'Unsupported release configuration schema.');
  invariant(/^[\w.-]+\/[\w.-]+$/.test(config.repository ?? ''), 'A repository owner/name is required.');
  invariant(typeof config.defaultBranch === 'string' && /^[\w./-]+$/.test(config.defaultBranch), 'A default branch is required.');
  invariant(Array.isArray(config.components) && config.components.length > 0, 'Release components are required.');
  invariant(config.components.filter(component => component.kind === 'server').length <= 1, 'The supported pipeline has one optional server component.');
  const ids = new Set();
  for (const component of config.components) {
    validateId(component.id);
    invariant(component.id.length <= 80, 'Component IDs must leave space for durable runtime operation keys.');
    invariant(!component.environmentSource || ['declared', 'provider'].includes(component.environmentSource), 'Unsupported environment source.');
    invariant(!ids.has(component.id), `Duplicate component ${component.id}.`);
    ids.add(component.id);
    invariant(KINDS.has(component.kind), `Unsupported component kind ${component.kind}.`);
    if (component.approvalEnvironment && typeof component.approvalEnvironment === 'object') {
      invariant(!Array.isArray(component.approvalEnvironment) && Object.entries(component.approvalEnvironment).every(([profile, name]) =>
        Object.hasOwn(config.profiles ?? {}, profile) && typeof name === 'string' && (!name || /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(name))), 'Invalid profile approval environment.');
      for (const profile of component.profiles ?? Object.keys(config.profiles ?? {})) invariant(Object.hasOwn(component.approvalEnvironment, profile), 'Specify an approval environment for each applicable profile.');
    }
    if (component.kind !== 'server') invariant(['android', 'ios'].includes(component.platform), `Invalid platform for ${component.id}.`);
    if (component.kind === 'native') {
      invariant(['command', 'eas'].includes(component.builder), `Unsupported native builder for ${component.id}.`);
      invariant(!component.signingEnvironment || component.builder === 'command', 'A separate signing environment applies only to command builders; EAS owns cloud signing.');
      invariant(!component.localBuilder || component.localBuilder === 'command' || component.localBuilder === 'eas' && component.platform === 'ios', 'Unsupported local native builder.');
      invariant(component.localBuilder !== 'eas' || !component.buildGroup, 'Local iOS EAS builds cannot share a command build group.');
      invariant(['appVersion', 'fingerprint'].includes(component.runtimePolicy ?? 'appVersion'), 'Unsupported runtime policy.');
      invariant(['exact', 'fingerprint'].includes(component.runtimeCompatibility ?? 'exact'), 'Unsupported runtime compatibility policy.');
      invariant(component.runtimeCompatibility !== 'fingerprint' || component.runtimePolicy === 'fingerprint', 'Fingerprint compatibility requires fingerprint runtime policy.');
    }
    if (component.kind === 'ota') {
      invariant(component.nativeTarget, `OTA ${component.id} requires a native target.`);
      invariant(['native', 'source'].includes(component.runtimeBinding ?? 'native'), 'Unsupported OTA runtime binding policy.');
      const profiles = component.profiles ?? Object.keys(config.profiles ?? {});
      const resolved = profiles.length ? profiles.map(name => ({ ...config.profiles[name], ...component })) : [component];
      invariant(resolved.every(value => value.channel && value.environment), `OTA ${component.id} requires a channel and environment in each applicable profile.`);
    }
    if (component.appDirectory && component.appDirectory !== '.') repositoryPath(process.cwd(), component.appDirectory);
    if (component.version) {
      repositoryPath(process.cwd(), component.version.file);
      invariant(component.version.pointer?.startsWith('/'), 'Version mapping needs a JSON pointer.');
      if (component.version.codePointer) invariant(component.version.codePointer.startsWith('/'), 'Code mapping needs a JSON pointer.');
    }
  }
  for (const component of config.components) {
    if (component.kind === 'ota') invariant(config.components.some(target => target.id === component.nativeTarget && target.kind === 'native' && target.platform === component.platform), `Unknown native target for ${component.id}.`);
    if (component.runtimeBinding === 'source') invariant(component.kind === 'ota' && config.components.find(value => value.id === component.nativeTarget)?.runtimePolicy === 'fingerprint', 'Source runtime binding requires fingerprint native policy.');
    for (const id of component.after ?? []) invariant(ids.has(id) && id !== component.id, `Invalid predecessor ${id}.`);
  }
  for (const group of config.nativeGroups ?? []) invariant(Array.isArray(group) && group.length > 1
    && group.every(id => config.components.some(component => component.id === id && component.kind === 'native')), 'Native groups must contain configured native targets.');
  for (const dependency of config.dependencies ?? []) invariant(ids.has(dependency.component) && Array.isArray(dependency.requires)
    && dependency.requires.every(id => ids.has(id)), 'Unknown component dependency.');
  for (const [name, hook] of Object.entries(config.hooks ?? {})) {
    invariant(HOOKS.has(name), `Unsupported application hook ${name}.`);
    invariant(Array.isArray(hook.command) && hook.command.length > 0 && hook.command.every(value => typeof value === 'string' && value.length > 0), `Invalid ${name} hook command.`);
  }
  for (const group of config.versionGroups ?? []) {
    validateId(group.id);
    invariant(Array.isArray(group.targets) && group.targets.length && group.targets.every(id => ids.has(id)), 'Invalid version group targets.');
    invariant(['global', 'independent'].includes(group.codeAllocation ?? 'independent'), 'Unsupported build code allocation.');
    invariant(['patch', 'requested'].includes(group.bump ?? 'requested'), 'Unsupported version bump policy.');
    for (const lane of Object.values(group.lanes ?? {})) invariant(Number.isSafeInteger(lane.modulus) && lane.modulus > 0
      && Number.isSafeInteger(lane.residue) && lane.residue >= 0 && lane.residue < lane.modulus, 'Invalid native code lane.');
  }
  if (config.defaultProfile) invariant(Object.hasOwn(config.profiles ?? {}, config.defaultProfile), 'Default profile is not configured.');
  if (config.deployment) invariant(config.deployment.type === 'wireguard-webhook', 'Unsupported deployment transport.');
  return validatePromotions(config);
}

/** Read configuration as data; privileged workers never import executable consumer configuration. */
export function readConfig(root = process.cwd(), file = 'release.config.json') {
  return validateConfig(JSON.parse(fs.readFileSync(repositoryPath(root, file), 'utf8')));
}

/** Read one explicit JSON pointer, rejecting inherited object properties. */
export function readPointer(value, pointer) {
  invariant(typeof pointer === 'string' && pointer.startsWith('/'), 'Expected a JSON pointer.');
  return pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~')).reduce((current, key) => {
    invariant(current && Object.hasOwn(current, key), `Missing version field ${pointer}.`);
    return current[key];
  }, value);
}
