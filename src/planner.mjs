/** @file Common release selection, version reservations and phase topology for hosted and local execution. */
import { buildReleaseGraph, bumpVersion, createPlan, hashIdentity, invariant, nextReservedVersion,
  selectComponents, summarizeRelease, verifyPlan } from '../packages/release-engine/index.mjs';
import { validateConfig } from './config.mjs';

/** Keep deployment/profile/environment histories distinct even when they share application source. */
export function baselineKey(component, profile = '') {
  if (component.kind === 'server') return [component.id, '', '', '', ''].join('|');
  return [component.id, profile, component.platform ?? '', component.channel ?? '', component.environment ?? ''].join('|');
}

/** Preserve each actual runtime's history separately from the latest compatible component baseline. */
export function runtimeBaselineKey(component, profile, runtime) {
  invariant(typeof runtime === 'string' && runtime, 'Runtime history requires an actual runtime.');
  return `${baselineKey(component, profile)}|${encodeURIComponent(runtime)}`;
}

/** Resolve profile defaults once and persist their concrete values in the plan. */
export function configuredComponents(config, profile = config.defaultProfile ?? '') {
  const defaults = config.profiles?.[profile] ?? {};
  invariant(!profile || !config.profiles || Object.hasOwn(config.profiles, profile), `Unknown release profile ${profile}.`);
  return config.components.filter(component => !component.profiles || component.profiles.includes(profile))
    .map(component => {
      const value = { ...defaults, ...component, profile: component.profile ?? defaults.easProfile ?? profile };
      if (value.approvalEnvironment && typeof value.approvalEnvironment === 'object') value.approvalEnvironment = value.approvalEnvironment[profile] ?? '';
      return value;
    });
}

/** Reserve versions above every prior attempt, retaining independent build counters and explicit residue lanes. */
export function reserveVersions(config, components, selected, observations, baseline, bump) {
  const reservations = structuredClone(baseline.reservations ?? {});
  const updates = {};
  for (const group of config.versionGroups ?? []) {
    const targets = components.filter(component => group.targets.includes(component.id) && selected.includes(component.id));
    if (!targets.length) continue;
    const previous = reservations[group.id] ?? {};
    const versions = targets.map(target => observations.get(target.id)?.version).filter(Boolean);
    const current = versions[0];
    invariant(current, `Missing observed version for ${group.id}.`);
    const semver = value => value.split('.').map(Number);
    const compare = (a, b) => { const aa = semver(a); const bb = semver(b); return aa[0] - bb[0] || aa[1] - bb[1] || aa[2] - bb[2]; };
    const baseVersion = previous.version && compare(previous.version, current) > 0 ? previous.version : current;
    const reuse = group.reusePrepared === true && previous.version && compare(current, previous.version) > 0
      && targets.every(target => observations.get(target.id).versionCode > Math.max(0, ...Object.values(previous.codes ?? {})));
    const version = reuse ? current : bumpVersion(baseVersion, group.bump === 'patch' ? 'patch' : bump);
    const codes = { ...(previous.codes ?? {}) };
    const allObserved = components.filter(component => group.targets.includes(component.id)).map(target => observations.get(target.id)?.versionCode).filter(Number.isSafeInteger);
    for (const target of targets) {
      const observed = observations.get(target.id);
      const used = group.codeAllocation === 'global' ? [...allObserved, ...Object.values(codes)] : [observed.versionCode, codes[target.id]].filter(Number.isSafeInteger);
      const lane = group.lanes?.[target.id] ?? {};
      if (target.kind === 'native') {
        codes[target.id] = reuse ? observed.versionCode : nextReservedVersion({ used: used.filter(code => code > 0), after: group.minimumCode ?? 0, ...lane });
        invariant(codes[target.id] <= (target.platform === 'android' ? 2100000000 : Number.MAX_SAFE_INTEGER), 'Native build number exceeds provider limits.');
      }
      updates[target.id] = { version, ...(codes[target.id] ? { versionCode: codes[target.id] } : {}) };
    }
    reservations[group.id] = { version, codes };
  }
  return { updates, reservations };
}

/** Build the supported phase topology; targets supply constraints, never executable workflow paths. */
export function releaseStages(config, components, selected, operation = 'release') {
  const stages = [];
  const specs = {};
  const active = components.filter(component => selected.includes(component.id));
  const servers = active.filter(component => component.kind === 'server');
  const natives = active.filter(component => component.kind === 'native');
  const add = (component, action, needs = []) => {
    const id = `${component.id}:${action}`;
    stages.push({ id, component: component.id, needs: [...new Set(needs)] });
    specs[id] = { action, target: component.id };
    return id;
  };
  const deployments = [];
  for (const component of servers) {
    const build = add(component, 'build');
    if (operation === 'build') continue;
    let publication = add(component, 'publish', [build]);
    if (component.publication) publication = add(component, 'finalize', [publication]);
    if (config.deployment) deployments.push(add(component, 'deploy', [publication]));
  }
  if (!servers.length && config.deployment && config.policy?.deployment === 'server-or-ota' && operation !== 'build') {
    const ota = active.find(component => component.kind === 'ota');
    if (ota) deployments.push(add(ota, 'deploy'));
  }
  for (const component of natives) {
    const build = add(component, 'build');
    if (operation === 'build' || component.submit === false) continue;
    const predecessors = (component.after ?? []).filter(id => selected.includes(id)).map(id => `${id}:submit`);
    const handoff = add(component, 'handoff', [build, ...deployments, ...predecessors]);
    add(component, 'submit', [handoff]);
  }
  if (operation !== 'build') {
    for (const component of active.filter(item => item.kind === 'ota')) {
      const native = natives.find(item => item.id === component.nativeTarget);
      const needs = [...deployments];
      if (native) needs.push(`${native.id}:${native.submit === false ? 'build' : 'handoff'}`);
      needs.push(...(component.after ?? []).filter(id => selected.includes(id)).map(id => `${id}:publish`));
      const exported = add(component, 'export', needs);
      add(component, 'publish', [exported, ...needs]);
    }
  }
  const topology = { graph: buildReleaseGraph(stages), stages: specs };
  publicationWaves(topology);
  return topology;
}

/** Assign the fixed workers from actual stage dependencies before any reservation or candidate mutation. */
export function publicationWaves({ graph, stages }) {
  const waves = new Map();
  const wave = id => {
    if (waves.has(id)) return waves.get(id);
    const spec = stages[id];
    const stage = graph.stages.find(value => value.id === id);
    let result = 1;
    for (const dependency of stage.needs) {
      const previous = stages[dependency];
      if (spec.action === 'handoff' && previous.action === 'submit') result = Math.max(result, wave(dependency) + 1);
      if (spec.action === 'submit' && previous.action === 'handoff') result = Math.max(result, wave(dependency));
      if (spec.action === 'export' && previous.action === 'handoff') result = Math.max(result, wave(dependency));
      if (spec.action === 'export' && previous.action === 'publish'
        && stages[`${previous.target}:export`]) result = Math.max(result, wave(dependency) + 1);
      if (spec.action === 'publish' && previous.action === 'export') result = Math.max(result, wave(dependency));
    }
    invariant(result <= 2, 'Supported target ordering has at most two publication waves.');
    waves.set(id, result);
    return result;
  };
  for (const stage of graph.stages) wave(stage.id);
  return waves;
}

/** Select effective changes against independently successful baselines and seal the requested source/configuration. */
export function planRelease({ config, source, origin, observations, baseline = {}, profile = config.defaultProfile ?? '',
  bump = 'patch', operation = 'release', targets = [], runId, providerConfiguration = {} }) {
  validateConfig(config);
  invariant(['major', 'minor', 'patch'].includes(bump), 'Invalid release bump.');
  invariant(['release', 'build', 'submit', 'ota', 'deploy', 'promote'].includes(operation), 'Unsupported release operation.');
  invariant(origin?.kind === 'local' || origin?.kind === 'github', 'Explicit evidence origin is required.');
  if (origin.kind === 'local') invariant(!origin.runId && !source.workflowCommit, 'Local evidence cannot claim a hosted run.');
  else invariant(/^[1-9]\d*$/.test(String(origin.runId)) && /^[1-9]\d*$/.test(String(origin.runAttempt)), 'Hosted evidence requires its producing run and attempt.');
  const components = configuredComponents(config, profile);
  const observed = new Map(observations.map(value => [value.id, value]));
  invariant(observed.size === observations.length, 'Duplicate component observations.');
  const candidates = components.map(component => {
    const observation = observed.get(component.id);
    invariant(observation && typeof observation.identity === 'string' && observation.identity.length > 0, `Missing identity for ${component.id}.`);
    const old = baseline.components?.[baselineKey(component, profile)];
    const identity = hashIdentity({ identity: observation.compatibilityIdentity ?? observation.identity,
      environment: component.compareEnvironment === false ? null : observation.environmentHash ?? null });
    const compatibleOperation = operation === 'ota' ? component.kind === 'ota' : operation === 'build' ? component.kind !== 'ota' : true;
    const requested = !targets.length || targets.includes(component.id);
    const enabled = compatibleOperation;
    return { id: component.id, kind: component.kind, identity,
      baselineIdentity: requested ? old?.identity ?? observation.baselineIdentity ?? null : identity, enabled,
      force: enabled && requested && (operation !== 'release' || observation.environmentDeferred && component.compareEnvironment !== false),
      reasons: [...(observation.reasons ?? []), ...(observation.environmentDeferred ? ['environment-awaiting-approval'] : [])] };
  });
  const available = new Set(components.map(component => component.id));
  for (const target of targets) invariant(available.has(target), `Unknown target ${target}.`);
  const dependencies = operation === 'release' ? (config.dependencies ?? []).filter(dependency => !dependency.when && available.has(dependency.component)
    && dependency.requires.every(id => available.has(id))) : [];
  let selection = selectComponents({ components: candidates,
    groups: (config.nativeGroups ?? []).filter(group => group.every(id => available.has(id))), dependencies });
  const nativeChanged = new Set(selection.selected.filter(id => components.find(component => component.id === id)?.kind === 'native'));
  const extra = new Set();
  for (const component of components) {
    if (component.kind === 'ota' && nativeChanged.has(component.nativeTarget) && config.policy?.otaForNewRuntime !== false) extra.add(component.id);
    if (component.kind === 'ota' && bump === 'major' && config.policy?.otaForServerMajor
      && selection.selected.some(id => components.find(item => item.id === id)?.kind === 'server')) extra.add(component.id);
  }
  if (extra.size) selection = selectComponents({ components: candidates.map(component => ({ ...component, force: component.force || extra.has(component.id) })),
    groups: (config.nativeGroups ?? []).filter(group => group.every(id => available.has(id))), dependencies });
  let versions = operation === 'release' ? reserveVersions(config, components, selection.selected, observed, baseline, bump)
    : { updates: {}, reservations: structuredClone(baseline.reservations ?? {}) };
  const metadataDependencies = operation === 'release' ? (config.dependencies ?? []).filter(dependency => dependency.when === 'version-reservation'
    && versions.updates[dependency.component] && versions.updates[dependency.component].version !== observed.get(dependency.component)?.version
    && dependency.requires.every(id => available.has(id))) : [];
  if (metadataDependencies.length) {
    selection = selectComponents({ components: candidates.map(component => ({ ...component, force: selection.selected.includes(component.id) })),
      groups: (config.nativeGroups ?? []).filter(group => group.every(id => available.has(id))), dependencies: [...dependencies, ...metadataDependencies] });
    versions = reserveVersions(config, components, selection.selected, observed, baseline, bump);
  }
  const topology = releaseStages(config, components, selection.selected, operation);
  const plannedComponents = components.map(component => ({ ...component, key: baselineKey(component, profile),
    selected: selection.selected.includes(component.id), observation: observed.get(component.id),
    identity: candidates.find(candidate => candidate.id === component.id).identity,
    ...(versions.updates[component.id] ? { next: versions.updates[component.id] } : {}) }));
  return createPlan({ source, origin, runId: String(runId ?? origin.runId ?? `local-${hashIdentity(source).slice(0, 20)}`),
    config, profile, operation, bump, targets, components: plannedComponents, selection, ...topology,
    reservations: versions.reservations, baseline, providerConfiguration, prepared: false });
}

/** Bind final candidate runtimes after metadata preparation; normalized selection hashes never prove publication compatibility. */
export function finalizePlan(plan, source, observations) {
  verifyPlan(plan);
  invariant(source.repository === plan.source.repository, 'Prepared source repository changed.');
  const observed = new Map(observations.map(value => [value.id, value]));
  const { schemaVersion, kind, digest, ...payload } = plan;
  const components = plan.components.map(component => {
    if (!component.selected) return component;
    const result = observed.get(component.id);
    invariant(result, `Prepared source lacks ${component.id}.`);
    if (component.next) invariant(result.version === component.next.version
      && (!component.next.versionCode || result.versionCode === component.next.versionCode), 'Prepared version allocation differs from its reservation.');
    if (component.kind !== 'server') invariant(typeof result.runtime === 'string' && result.runtime.length > 0, 'Prepared native/OTA runtime is missing.');
    return { ...component, observation: result };
  });
  return createPlan({ ...payload, source, components, prepared: true, requestedSource: plan.source, reservationDigest: digest });
}

/** Rebind validated candidate-tree observations to the verified protected merge commit without changing the reservation. */
export function bindMergedPlan(reservation, prepared, source) {
  verifyPlan(reservation); verifyPlan(prepared);
  invariant(prepared.prepared && prepared.reservationDigest === reservation.digest
    && hashIdentity(prepared.config) === hashIdentity(reservation.config), 'Prepared metadata does not bind this reservation.');
  invariant(source.repository === reservation.source.repository && source.workflowCommit === reservation.source.workflowCommit
    && source.toolkitCommit === reservation.source.toolkitCommit, 'Merge changed the workflow/toolkit authority.');
  const { schemaVersion, kind, digest, ...payload } = prepared;
  return createPlan({ ...payload, source, validatedCandidate: prepared.source.commit });
}

/** Carry only successful component histories forward while retaining all allocated versions after failure or abandonment. */
export function completedBaseline(plan, receipts) {
  verifyPlan(plan);
  const summary = summarizeRelease(plan.graph, receipts);
  const baseline = structuredClone(plan.baseline);
  if (plan.operation === 'build' || plan.retainedOperation) return baseline;
  baseline.reservations = structuredClone(plan.reservations);
  baseline.components ??= {};
  baseline.runtimes ??= {};
  const completed = new Set(summary.completedComponents);
  for (const group of plan.config.nativeGroups ?? []) {
    const selected = group.filter(id => plan.selection.selected.includes(id));
    if (!selected.every(id => completed.has(id))) selected.forEach(id => completed.delete(id));
  }
  for (const component of plan.components) {
    if (!completed.has(component.id)) continue;
    if (receipts.some(receipt => receipt.stage === `${component.id}:publish` && receipt.receipt?.outcome === 'skipped')) continue;
    baseline.components[component.key] = {
      ...component.observation, ...(component.next ?? {}), identity: component.identity,
      source: plan.source.commit, origin: plan.origin
    };
    if (component.observation.runtime) baseline.runtimes[runtimeBaselineKey(component, plan.profile, component.observation.runtime)] = baseline.components[component.key];
  }
  return baseline;
}
