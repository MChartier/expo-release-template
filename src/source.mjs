/** @file Credential-free source inspection and mapped metadata transformations shared by CLI and workflow workers. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { invariant, hashIdentity, verifyPlan } from '../packages/release-engine/index.mjs';
import { readPointer, repositoryPath } from './config.mjs';
import { runHook, sourceEnvironment } from './hooks.mjs';
import { configuredComponents } from './planner.mjs';

/** Read tracked source without replacement objects, shell evaluation, or inherited Git credentials/config overrides. */
export function sourceGit(root, args, options = {}) {
  return execFileSync('git', ['--no-replace-objects', ...args], { cwd: root, encoding: 'utf8', windowsHide: true,
    maxBuffer: 64 * 1024 * 1024, env: { ...sourceEnvironment(), GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1' }, ...options }).trim();
}

/** Hash selected tracked file bytes with an application-owned normalization callback. */
export function trackedIdentity(root, source, { include = () => true, normalize = (file, text) => text, content = () => 'text' } = {}) {
  invariant(/^[a-f0-9]{40}$/.test(source), 'Source inspection requires a full Git commit.');
  const files = sourceGit(root, ['ls-tree', '-r', '--name-only', source]).split(/\r?\n/).filter(file => file && include(file)).sort();
  const hash = createHash('sha256');
  for (const file of files) {
    const representation = content(file);
    invariant(['text', 'blob'].includes(representation), 'Unknown tracked input representation.');
    const value = normalize(file, sourceGit(root, representation === 'blob' ? ['rev-parse', `${source}:${file}`] : ['show', `${source}:${file}`]));
    hash.update(`${file}\0${value}\0`);
  }
  return hash.digest('hex');
}

/** Resolve current metadata from mappings after the source-only application inspection. */
export function inspectSource(config, { root = process.cwd(), source, profile = config.defaultProfile ?? '', environment = {}, environmentHash,
  componentEnvironments = {}, baseline = {}, runtimeOverrides = {} } = {}) {
  const result = runHook(config, 'inspect', { source, profile, environment, environmentHash, componentEnvironments, baseline, runtimeOverrides }, { root });
  invariant(Array.isArray(result.observations), 'Inspect hook must return component observations.');
  return configuredComponents(config, profile).map(component => {
    const matches = result.observations.filter(value => value.id === component.id);
    invariant(matches.length === 1, `Inspect hook must return exactly one ${component.id} observation.`);
    const resolved = componentEnvironments[component.id];
    const observation = { ...matches[0],
      ...(resolved?.deferred ? { environmentHash: null, environmentDeferred: true } : {}),
      environment: resolved?.environment ?? environment };
    const mapping = component.version;
    if (!mapping) return observation;
    const metadata = JSON.parse(fs.readFileSync(repositoryPath(root, mapping.file), 'utf8'));
    return { ...observation, version: readPointer(metadata, mapping.pointer),
      ...(mapping.codePointer ? { versionCode: Number(readPointer(metadata, mapping.codePointer)) } : {}) };
  });
}

/** Update an existing owned JSON field; an absent path is a contract error rather than implicit schema creation. */
export function writePointer(value, pointer, next) {
  const parts = pointer.slice(1).split('/').map(part => part.replace(/~1/g, '/').replace(/~0/g, '~'));
  const key = parts.pop();
  let parent = value;
  for (const part of parts) { invariant(parent && Object.hasOwn(parent, part), `Missing metadata field ${pointer}.`); parent = parent[part]; }
  invariant(parent && Object.hasOwn(parent, key) && !['__proto__', 'prototype', 'constructor'].includes(key), `Missing or unsafe metadata field ${pointer}.`);
  parent[key] = next;
}

/** Prepare declared version mirrors, then invoke only the application's metadata transformation hook. */
export function prepareSource(plan, { root = process.cwd(), environment = {} } = {}) {
  verifyPlan(plan);
  const originals = {};
  const changed = new Map();
  const assign = (mapping, value) => {
    const file = repositoryPath(root, mapping.file);
    if (!changed.has(mapping.file)) {
      originals[mapping.file] = fs.readFileSync(file, 'utf8');
      changed.set(mapping.file, JSON.parse(originals[mapping.file]));
    }
    writePointer(changed.get(mapping.file), mapping.pointer, value);
  };
  for (const component of plan.components.filter(value => value.selected && value.next)) {
    const group = plan.config.versionGroups?.find(value => value.targets.includes(component.id));
    const mapping = group?.version ?? component.version;
    invariant(mapping, `No metadata mapping for reserved target ${component.id}.`);
    assign(mapping, component.next.version);
    if (component.version) assign(component.version, component.next.version);
    for (const mirror of mapping.mirrors ?? []) assign(mirror, component.next.version);
    if (component.version?.codePointer) assign({ file: component.version.file, pointer: component.version.codePointer },
      component.version.codeType === 'string' ? String(component.next.versionCode) : component.next.versionCode);
  }
  for (const [file, value] of changed) fs.writeFileSync(repositoryPath(root, file), `${JSON.stringify(value, null, 2)}\n`);
  if (plan.config.hooks?.prepare) runHook(plan.config, 'prepare', { plan, originals, environment, profile: plan.profile }, { root });
  return { files: sourceGit(root, ['diff', '--name-only']).split(/\r?\n/).filter(Boolean), identity: hashIdentity(Object.fromEntries(changed)) };
}

/** Verify a single immutable package/workflow revision rather than another consumer-owned snapshot lock. */
export function verifyToolkitPins(root, { expectedRevision } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const dependency = manifest.dependencies?.['@mchartier/expo-release'] ?? manifest.devDependencies?.['@mchartier/expo-release'];
  const match = /^git\+https:\/\/github\.com\/MChartier\/expo-release-template\.git#([a-f0-9]{40})$/.exec(dependency ?? '');
  invariant(match, 'Install @mchartier/expo-release through its full-SHA git+https dependency.');
  const revision = match[1];
  invariant(!expectedRevision || revision === expectedRevision, 'Installed toolkit revision differs from the trusted worker.');
  const workflowRoot = path.join(root, '.github', 'workflows');
  let references = 0;
  for (const file of fs.existsSync(workflowRoot) ? fs.readdirSync(workflowRoot) : []) {
    if (!/\.ya?ml$/.test(file)) continue;
    const text = fs.readFileSync(path.join(workflowRoot, file), 'utf8');
    for (const use of text.matchAll(/MChartier\/expo-release-template\/[^\s@]+@([^\s#]+)/g)) {
      references += 1;
      invariant(use[1] === revision, `Toolkit workflow pin differs in ${file}.`);
    }
  }
  invariant(references > 0, 'No shared release workflow callers are configured.');
  const lockPath = path.join(root, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
    const installed = lock.packages?.['node_modules/@mchartier/expo-release'];
    invariant(installed?.resolved?.endsWith(`#${revision}`), 'Package lock does not resolve the configured toolkit revision.');
  }
  return revision;
}
