/** @file Resolves committed Expo identity and reads reproducible public provider inputs outside the application source process. */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { invariant } from '../packages/release-engine/index.mjs';
import { readPointer, repositoryPath } from './config.mjs';
import { configuredComponents } from './planner.mjs';
import { sourceEnvironment } from './hooks.mjs';
import { createEasTransport } from './providers/eas.mjs';

const hashValues = values => createHash('sha256').update(JSON.stringify(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
const matches = (name, pattern) => new RegExp(`^${pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`, 'i').test(name);
const secretName = /(?:^|_)(TOKEN|PASSWORD|SECRET|PRIVATE_KEY|SERVICE_ACCOUNT|ACCESS_KEY)(?:_|$)|^(OPENAI_API_KEY|AAC_OPENAI_KEY|GOOGLE_APPLICATION_CREDENTIALS|SSH_AUTH_SOCK)$/i;

/** Resolve literal values or declared JSON pointers without importing executable application configuration. */
export function resolveConfigurationValue(value, root = process.cwd()) {
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.file === 'string' && typeof value.pointer === 'string') {
    const data = JSON.parse(readFileSync(repositoryPath(root, value.file), 'utf8'));
    try { return readPointer(data, value.pointer); }
    catch (error) { if (value.optional === true && error.message.startsWith('Missing version field')) return undefined; throw error; }
  }
  if (Array.isArray(value)) return value.map(item => resolveConfigurationValue(item, root));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .map(([key, item]) => [key, resolveConfigurationValue(item, root)]).filter(([, item]) => item !== undefined));
  return value;
}

/** Resolve and validate configured project identity; no Expo identity is required for server-only applications. */
export function resolveExpoConfiguration(config, root = process.cwd(), profile = config.defaultProfile ?? '') {
  if (!config.expo) return null;
  const expo = resolveConfigurationValue(config.expo, root);
  const overrides = config.profiles?.[profile]?.expo ?? {};
  invariant(Object.keys(overrides).every(key => key === 'serverUrl'), 'Profiles may override only the Expo server origin.');
  Object.assign(expo, overrides);
  invariant(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(expo.projectId ?? '')
    && /^[\w-]+$/.test(expo.owner ?? '') && /^[\w-]+$/.test(expo.slug ?? ''), 'Invalid configured Expo identity.');
  if (expo.serverUrl) {
    const url = new URL(expo.serverUrl);
    invariant(url.protocol === 'https:' && !url.username && !url.password && !url.hash && !url.search && url.pathname === '/', 'Expo server URL must be an HTTPS origin.');
    expo.serverUrl = url.origin;
  }
  return expo;
}

function publicValues(variables, defaults, policy, channel) {
  invariant(Array.isArray(variables), 'Provider returned no reproducible environment inventory.');
  const values = {}; const names = new Set();
  const validateName = name => {
    invariant(typeof name === 'string' && /^[A-Z][A-Z0-9_]*$/.test(name), 'Invalid source environment name.');
    invariant(!secretName.test(name) && !(policy.forbiddenNames || []).some(pattern => matches(name, pattern)), `Forbidden source environment variable ${name}.`);
  };
  for (const variable of variables) {
    validateName(variable.name);
    invariant(!names.has(variable.name), 'Duplicate provider environment variable.'); names.add(variable.name);
    invariant(variable.type === 'STRING' && ['PUBLIC', 'SENSITIVE'].includes(variable.visibility) && typeof variable.value === 'string', 'Source variables must be readable strings; credentials stay outside the source process.');
    invariant(!policy.allowedNames || policy.allowedNames.some(pattern => matches(variable.name, pattern)) || variable.name === policy.channelVariable,
      `Source environment variable ${variable.name} is not declared public.`);
    invariant(variable.visibility !== 'SENSITIVE' || policy.allowedNames?.some(pattern => matches(variable.name, pattern)), 'Sensitive variables require an explicit public-name declaration.');
    invariant(variable.name !== policy.channelVariable || variable.value === channel, 'Provider source channel differs from the selected destination.');
    values[variable.name] = variable.value;
  }
  for (const [name, value] of Object.entries(defaults || {})) {
    validateName(name); invariant(typeof value === 'string', 'Declared public defaults must be strings.');
    const expected = name === policy.channelVariable ? channel : value;
    invariant(!Object.hasOwn(values, name) || values[name] === expected, `Provider variable ${name} differs from its committed public value.`);
    values[name] = expected;
  }
  // Reuse the source-process guard against executable/workflow environment capabilities.
  sourceEnvironment({}, values);
  return { environment: values, hash: hashValues(values) };
}

/**
 * Verify the project once and return only approved public inputs, their historical sorted-entry hashes,
 * and distinct per-component environments. The optional environment string selects one EAS environment.
 */
export async function readReleaseEnvironment(config, { root = process.cwd(), profile = config.defaultProfile ?? '', transport,
  environment: environmentOverride, targets = [], deferProtected = false } = {}) {
  invariant(environmentOverride === undefined || ['development', 'preview', 'production'].includes(environmentOverride), 'Unknown EAS environment.');
  const available = configuredComponents(config, profile);
  invariant(targets.every(id => available.some(component => component.id === id)), 'Unknown environment target.');
  const components = targets.length ? available.filter(component => targets.includes(component.id)) : available;
  const expo = resolveExpoConfiguration(config, root, profile);
  const profileDefaults = config.profiles?.[profile] || {};
  const defaults = { ...config.inspection?.environment, ...profileDefaults.publicEnvironment };
  if (targets.length && targets.every(id => components.some(component => component.id === id && component.kind === 'server'))) {
    return { expo, environment: {}, hash: hashValues({}), components: Object.fromEntries(targets.map(id => [id, { environment: {}, hash: hashValues({}) }])) };
  }
  if (!expo) {
    const result = publicValues([], defaults, {}, '');
    return { expo, ...result, components: Object.fromEntries(components.map(component => [component.id, { ...result }])) };
  }
  const policy = expo.environmentPolicy || {};
  const eligible = components.filter(component => component.kind !== 'server' && component.environmentSource !== 'declared'
    && !(deferProtected && component.approvalEnvironment));
  const provider = transport || createEasTransport();
  if (eligible.length) await provider.project(expo);
  const cache = new Map();
  const read = async component => {
    const selected = environmentOverride || component.environment || profileDefaults.environment;
    invariant(['development', 'preview', 'production'].includes(selected), 'Each Expo target requires an explicit EAS environment.');
    if (!cache.has(selected)) cache.set(selected, await provider.environment(expo.projectId, selected));
    const channel = component.channel || profileDefaults.channel;
    const result = publicValues(cache.get(selected), defaults, policy, channel);
    return { ...result, channel, easEnvironment: selected };
  };
  const resolvedTargets = {};
  for (const component of components) {
    if (component.kind === 'server') resolvedTargets[component.id] = { environment: {}, hash: hashValues({}) };
    else if (deferProtected && component.approvalEnvironment) {
      const channel = component.channel || profileDefaults.channel;
      const declared = publicValues([], defaults, policy, channel);
      resolvedTargets[component.id] = { environment: declared.environment, hash: null, deferred: true, channel, easEnvironment: environmentOverride || component.environment || profileDefaults.environment };
    } else if (component.environmentSource === 'declared') {
      resolvedTargets[component.id] = { ...publicValues([], defaults, policy, component.channel), channel: component.channel,
        easEnvironment: component.environment, source: 'declared' };
    } else resolvedTargets[component.id] = await read(component);
  }
  const common = resolvedTargets[eligible[0]?.id] || Object.values(resolvedTargets).find(value => !value.deferred) || { environment: {}, hash: null, deferred: true };
  return { expo, ...common, components: resolvedTargets };
}
