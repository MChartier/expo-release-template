/** @file Source-free Little Say recovery audits original EAS IDs, image aliases, OTA bytes and workflow deployment proof before appending separate recovery evidence. */
import { createHash } from 'node:crypto';
import { hashIdentity, invariant } from '../../packages/release-engine/index.mjs';
import { createEasTransport, createEasBuildProvider, createEasOtaProvider, verifyEasBuild, verifyEasSubmission } from '../providers/eas.mjs';
import { createGhcrTransport } from '../providers/ghcr.mjs';
import { createEasPublisherWorkspace } from '../providers/eas-workspace.mjs';
import { appendLittleSayRecovery } from './little-say.mjs';

const same = (left, right) => hashIdentity(left) === hashIdentity(right);
const terminalFailure = raw => ['ERRORED', 'CANCELED'].includes(raw.status);
const status = raw => raw.status === 'FINISHED' ? 'complete' : terminalFailure(raw) ? 'failed'
  : ['NEW', 'IN_QUEUE', 'IN_PROGRESS', 'AWAITING_BUILD', 'PENDING_CANCEL'].includes(raw.status) ? 'accepted' : 'unknown';

async function originalJson(api, source, file) {
  const result = await api(`/contents/${file}?ref=${source}`);
  invariant(result.type === 'file' && result.encoding === 'base64' && result.size < 1024 * 1024, 'Historical configuration is unavailable.');
  return JSON.parse(Buffer.from(result.content, 'base64').toString('utf8'));
}

async function pages(read, select, key) {
  const matches = []; const seen = new Set();
  for (let offset = 0; offset < 50000; offset += 50) {
    const page = await read(offset);
    invariant(Array.isArray(page) && page.length <= 50, 'Unexpected historical provider page.');
    for (const item of page) { const id = key(item); invariant(id && !seen.has(id), 'Historical provider pagination repeated an ID.'); seen.add(id); if (select(item)) matches.push(item); }
    if (page.length < 50) return matches;
  }
  throw new Error('Historical provider inventory exceeded its lookup bound.');
}

async function environmentHash(transport, plan) {
  const raw = await transport.environment(plan.nativeRelease.expoProjectId, plan.profile === 'internal' ? 'preview' : 'production');
  invariant(Array.isArray(raw), 'Historical environment inventory is unavailable.');
  const values = {};
  for (const item of raw) {
    invariant(item.type === 'STRING' && ['PUBLIC', 'SENSITIVE'].includes(item.visibility) && typeof item.value === 'string'
      && typeof item.name === 'string' && !Object.hasOwn(values, item.name), 'Historical environment cannot be reproduced.');
    invariant(!/^(EXPO_PUBLIC_|AAC_OPENAI_KEY$|OPENAI_API_KEY$|NODE_OPTIONS$|EXPO_NO_DOTENV$|EAS_BUILD_|LITTLE_SAY_OTA_VERSIONS$|LITTLE_SAY_FINGERPRINT_PLATFORM$|EAS_SKIP_AUTO_FINGERPRINT$)/i.test(item.name)
      && (item.name !== 'LITTLE_SAY_CHANNEL' || item.value === plan.profile), 'Historical environment violates its original contract.');
    values[item.name] = item.value;
  }
  const digest = createHash('sha256').update(JSON.stringify(Object.entries(values).sort(([a], [b]) => a.localeCompare(b)))).digest('hex');
  invariant(digest === plan.inputs.environmentHash, 'Historical environment changed.');
  return digest;
}

function buildSpec(plan, prepared, platform, app, eas, baseline) {
  const profile = eas.build?.[plan.profile];
  invariant(profile && !profile.extends && profile.autoIncrement === false && profile.channel === plan.profile
    && profile.environment === (plan.profile === 'internal' ? 'preview' : 'production')
    && profile.distribution === (plan.profile === 'internal' ? 'internal' : 'store'), 'Historical native build profile differs.');
  return { projectId: plan.nativeRelease.expoProjectId, applicationId: platform === 'android' ? app.expo.android.package : app.expo.ios.bundleIdentifier,
    source: prepared.commit, platform, profile: plan.profile, channel: profile.channel, environment: profile.environment,
    distribution: profile.distribution, version: plan.nativeRelease.version,
    versionCode: platform === 'android' ? plan.nativeRelease.androidVersionCode : plan.nativeRelease.iosBuildNumber,
    runtime: baseline?.runtimeVersion || plan.nativeRelease.version, marker: `little-say:${plan.runId}:build:${platform}`,
    ...(baseline ? { fingerprint: baseline.fingerprint, artifactSha256: baseline.artifactSha256 } : {}) };
}

function eligibleBaselines(plan, baselines, policy) {
  invariant(policy.schema === 1 && Array.isArray(policy.retiredRuntimes), 'Historical runtime policy is invalid.');
  const eligible = new Map(); const proofs = new Map(); const skipped = [];
  for (const baseline of baselines) {
    if (baseline.profile !== plan.profile || !plan.ota.includes(baseline.platform)) continue;
    const key = `${baseline.platform}-${baseline.runtimeVersion}`;
    if (policy.retiredRuntimes.some(value => value.profile === baseline.profile && value.platform === baseline.platform && value.runtimeVersion === baseline.runtimeVersion)) { skipped.push(`${key}: retired`); continue; }
    const previous = proofs.get(key);
    invariant(!previous || previous.fingerprint === baseline.fingerprint && previous.environmentHash === baseline.environmentHash, 'Historical runtime has contradictory native proof.');
    proofs.set(key, baseline);
    if (baseline.compatibility !== plan.inputs.native[baseline.platform] || baseline.environmentHash !== plan.inputs.environmentHash) { skipped.push(`${key}: incompatible native inputs/environment`); continue; }
    eligible.set(key, baseline);
  }
  for (const platform of plan.ota) if (![...eligible.values()].some(value => value.platform === platform)) skipped.push(`${platform}: no supported compatible runtime`);
  return { eligible, skipped };
}

/** Audit the original contract using concrete provider transports; this function never enqueues, publishes, rebuilds or deploys. */
export async function observeLittleSayRelease({ state, config, api, transport, registry, environment = process.env, scope }) {
  invariant(scope === undefined || /^(submit-(android|ios)|promote-server|ota)$/.test(scope), 'Unsupported historical provider audit scope.');
  if (transport || scope === 'promote-server' || !state.recovery?.prepared || !(state.legacyPlan?.native.length || state.legacyPlan?.ota.length || state.legacyPlan?.submissions.length)) {
    return auditOriginalRelease({ state, config, api, transport: transport || createEasTransport({ env: environment }), registry, scope });
  }
  const plan = state.legacyPlan; const app = await originalJson(api, state.recovery.prepared.commit, 'apps/mobile/app.json');
  const platform = plan.native[0] || plan.ota[0] || plan.submissions[0];
  const workspace = createEasPublisherWorkspace({ projectId: plan.nativeRelease.expoProjectId, owner: plan.nativeRelease.expoOwner,
    slug: app.expo.slug, platform, profile: plan.profile, channel: plan.profile, runtime: plan.nativeRelease.version,
    version: plan.nativeRelease.version, versionCode: platform === 'android' ? plan.nativeRelease.androidVersionCode : plan.nativeRelease.iosBuildNumber,
    applicationId: platform === 'android' ? app.expo.android.package : app.expo.ios.bundleIdentifier }, { env: environment });
  try { return await auditOriginalRelease({ state, config, api, transport: workspace.transport, registry, scope }); }
  finally { workspace.dispose(); }
}

async function auditOriginalRelease({ state, config, api, transport, registry, scope }) {
  invariant(state.legacy && state.recovery.format === 'little-say' && !state.resolved, 'An unresolved Little Say journal is required.');
  const originalPlan = state.legacyPlan; const recovery = state.recovery; const prepared = recovery.prepared;
  const plan = scope ? { ...originalPlan, server: scope === 'promote-server' && originalPlan.server,
    native: scope.startsWith('submit-') ? [scope.slice(7)] : scope === 'ota' ? originalPlan.native : [],
    submissions: scope.startsWith('submit-') ? [scope.slice(7)] : [], ota: scope === 'ota' ? originalPlan.ota : [] } : originalPlan;
  const originalOperations = recovery.operations.filter(value => !scope || value.key === 'server' && plan.server
    || value.key.startsWith('build-') && plan.native.includes(value.key.slice(6))
    || value.key.startsWith('submit-') && plan.submissions.includes(value.key.slice(7)) || value.key.startsWith('ota-') && plan.ota.length);
  invariant(recovery.producer.status === 'completed' && recovery.jobs.every(job => job.status === 'completed'), 'The original release workflow is still active.');
  const operations = []; const remaining = []; const baselines = [...(plan.baselines || [])];
  const continuations = recovery.continuations || {};
  const jobs = [...new Map([...recovery.jobs].sort((a, b) => (a.run_attempt || 1) - (b.run_attempt || 1) || a.id - b.id).map(job => [job.name, job])).values()];
  const successful = name => jobs.some(job => job.name === name && job.conclusion === 'success');
  const base = { schemaVersion: 1, kind: 'little-say-provider-audit', planDigest: hashIdentity(originalPlan), preparedDigest: hashIdentity(prepared ?? null),
    ...(scope ? { scope } : {}),
    originalInventoryDigest: hashIdentity(recovery.originalInventory), operations, jobs: jobs.map(({ id, name, conclusion, run_attempt }) => ({ id, name, conclusion, ...(run_attempt ? { runAttempt: run_attempt } : {}) })) };
  if (!prepared) {
    invariant(recovery.operations.length === 0 && jobs.every(job => job.name === 'prepare' || job.conclusion === 'skipped'), 'Unprepared legacy release contains provider work.');
    return { ...base, complete: false, safeToAbandon: true, remaining: ['prepare'], candidate: recovery.documents['candidate.json'] ?? null };
  }
  const ancestry = await api(`/compare/${prepared.commit}...${config.defaultBranch}`);
  invariant(['ahead', 'identical'].includes(ancestry.status) && ancestry.merge_base_commit?.sha === prepared.commit, 'Historical prepared source is not on the default branch.');
  invariant(successful('prepare'), 'Historical prepared source lacks its successful validation workflow.');
  const [app, eas, policy] = await Promise.all(['apps/mobile/app.json', 'apps/mobile/eas.json', 'release-policy.json'].map(file => originalJson(api, prepared.commit, file)));
  if (plan.native.length || plan.ota.length || plan.submissions.length) {
    await transport.project({ projectId: plan.nativeRelease.expoProjectId, owner: plan.nativeRelease.expoOwner, slug: app.expo.slug });
    await environmentHash(transport, plan);
  }
  const known = new Map(originalOperations.map(operation => [operation.key, operation]));
  const handled = new Set(); const builds = new Map();
  let server;
  if (plan.server) {
    const operation = known.get('server'); handled.add('server');
    if (!operation) remaining.push('server');
    else {
      server = operation.result;
      invariant(operation.status === 'complete' && server && same(operation.providerIds, [prepared.commit])
        && server.commit === prepared.commit && server.version === plan.serverVersion && server.input === plan.inputs.server
        && server.image === `ghcr.io/${config.repository.toLowerCase()}`, 'Historical image operation needs its exact completed receipt.');
      const reader = registry || createGhcrTransport({ image: server.image, username: process.env.GITHUB_ACTOR, token: process.env.GITHUB_TOKEN });
      const [version, source] = await Promise.all([reader.inspect(`v${server.version}`, { includeLabels: true }), reader.inspect(`sha-${prepared.commit}`, { includeLabels: true })]);
      invariant(version?.digest === server.digest && source?.digest === server.digest && same(version.manifests, source.manifests), 'Historical image aliases differ.');
      invariant(same(version.manifests.map(value => value.platform).sort(), ['linux/amd64', 'linux/arm64']), 'Historical image platforms differ.');
      invariant(version.manifests.every(value => value.labels?.['org.opencontainers.image.revision'] === prepared.commit
        && value.labels?.['org.opencontainers.image.version'] === server.version
        && value.labels?.['org.opencontainers.image.source']?.toLowerCase() === `https://github.com/${config.repository.toLowerCase()}`), 'Historical image labels differ.');
      operations.push({ key: 'server', status: 'complete', providerIds: operation.providerIds, result: server,
        proof: { provider: 'ghcr', digest: server.digest, manifests: version.manifests } });
      const tag = await api(`/git/ref/tags/v${server.version}`);
      invariant(tag.object?.type === 'commit' && tag.object.sha === prepared.commit, 'Historical version tag differs.');
      const promoted = continuations['promote-server'];
      if (promoted?.status === 'complete') invariant(promoted.receipt?.digest === server.digest && promoted.receipt?.source === prepared.commit
        && promoted.receipt?.alias === 'latest', 'Historical promotion continuation differs.');
      if (!successful('promote-server') && promoted?.status !== 'complete') remaining.push('promote-server');
    }
  }
  for (const platform of plan.native) {
    const key = `build-${platform}`; const operation = known.get(key); handled.add(key);
    const baseline = operation?.result; const spec = buildSpec(plan, prepared, platform, app, eas, baseline);
    const found = await pages(offset => transport.cli(['build:list', '--platform', platform, '--build-profile', plan.profile,
      '--git-commit-hash', prepared.commit, '--offset', String(offset), '--limit', '50', '--json', '--non-interactive']), value => value.message === spec.marker, value => value.id);
    // Discover lost responses by their original exact marker; no request is repeated from an empty search.
    const ids = [...(operation?.providerIds || [])];
    for (const value of found) if (!ids.includes(value.id)) ids.push(value.id);
    invariant((operation?.providerIds || []).every(id => found.some(value => value.id === id)), 'Historical native provider inventory lost a recorded ID.');
    let current;
    for (const [index, id] of ids.entries()) {
      const raw = verifyEasBuild(await transport.getBuild(id), spec);
      invariant(raw.id === id && Array.isArray(raw.submissions), 'Historical build/submission association is missing.');
      invariant(originalPlan.submissions.includes(platform) || raw.submissions.length === 0, 'Historical build has unexpected store submissions.');
      if (index < ids.length - 1) invariant(terminalFailure(raw), 'An earlier native provider attempt is unresolved or already successful.');
      current = raw;
    }
    if (!current) { remaining.push(key); if (operation) operations.push({ key, status: 'unknown', providerIds: ids }); continue; }
    builds.set(platform, { raw: current, spec });
    let proof;
    if (current.status === 'FINISHED') {
      invariant(baseline && baseline.buildId === current.id && baseline.commit === prepared.commit && baseline.platform === platform
        && baseline.profile === plan.profile && same(baseline.release, plan.nativeRelease) && baseline.compatibility === plan.inputs.native[platform]
        && baseline.environmentHash === plan.inputs.environmentHash, 'Finished historical native build needs its original verified fingerprint/artifact receipt.');
      proof = await createEasBuildProvider(spec, transport).verify({ id: current.id });
      invariant(proof.artifact.sha256 === baseline.artifactSha256 && proof.fingerprint === baseline.fingerprint, 'Historical native bytes/fingerprint differ.');
      baselines.push(baseline);
    } else remaining.push(key);
    invariant(operation?.status !== 'complete' || current.status === 'FINISHED', 'Historical native success changed.');
    operations.push({ key, status: status(current), providerIds: ids, ...(proof ? { proof, result: baseline } : {}) });
  }
  for (const platform of plan.submissions) {
    const key = `submit-${platform}`; handled.add(key); const operation = known.get(key); const continuation = continuations[key]; const build = builds.get(platform);
    if (!build || build.raw.status !== 'FINISHED') { remaining.push(key); continue; }
    const ids = build.raw.submissions.map(value => value.id);
    const retainedIds = [...new Set([...(operation?.providerIds || []), ...(continuation?.history || []).map(value => value.operationId), continuation?.operationId].filter(Boolean))];
    invariant(new Set(ids).size === ids.length && retainedIds.every(id => ids.includes(id)), 'Historical submission IDs differ.');
    const ordered = [...retainedIds, ...ids.filter(id => !retainedIds.includes(id))];
    let current;
    for (const [index, id] of ordered.entries()) {
      current = verifyEasSubmission(await transport.getSubmission(id), { projectId: plan.nativeRelease.expoProjectId, platform,
        destination: eas.submit?.production?.[platform], artifact: { kind: 'eas-build', buildId: build.raw.id }, build: build.spec });
      invariant(current.id === id && (index === ordered.length - 1 || terminalFailure(current)), 'Historical prior submission has an unresolved or successful outcome.');
    }
    const outcome = current ? status(current) : operation || continuation ? 'unknown' : 'idle';
    invariant(operation?.status !== 'complete' || outcome === 'complete' && current.id === operation.result, 'Historical submission success changed.');
    if (outcome !== 'complete') remaining.push(key);
    if (current || operation || continuation) operations.push({ key, status: outcome, providerIds: ordered,
      ...(current ? { proof: { provider: 'eas', kind: 'submission', id: current.id, buildId: build.raw.id, destination: eas.submit.production[platform], status: outcome } } : {}) });
  }
  const recoveredOta = continuations.ota?.status === 'complete' ? continuations.ota.receipt : undefined;
  const ota = recovery.documents['ota.json'] || recoveredOta;
  if (plan.ota.length) {
    const { eligible, skipped } = eligibleBaselines(plan, baselines, policy);
    if (!ota) remaining.push('ota');
    {
      const partial = originalOperations.filter(operation => operation.key.startsWith('ota-'));
      const recorded = ota || { receipts: partial.filter(operation => operation.status === 'complete' && operation.result).map(operation => operation.result), skipped };
      invariant(Array.isArray(recorded.receipts) && same(recorded.skipped, skipped) && (!ota || recorded.receipts.length === eligible.size), 'Historical OTA coverage differs from the original runtime policy.');
      const branch = await transport.channel({ projectId: plan.nativeRelease.expoProjectId, channel: plan.profile });
      invariant(same(branch, plan.channelBranch), 'Historical OTA branch changed.');
      const seen = new Set();
      for (const receipt of recorded.receipts) {
        const key = `ota-${receipt.platform}-${receipt.runtimeVersion}`; handled.add(key);
        const baseline = eligible.get(`${receipt.platform}-${receipt.runtimeVersion}`); const operation = known.get(key);
        invariant(baseline && !seen.has(key) && receipt.input === plan.inputs.bundle[receipt.platform], 'Historical OTA runtime identity differs.'); seen.add(key);
        const ancestor = await api(`/compare/${baseline.commit}...${prepared.commit}`);
        invariant(['ahead', 'identical'].includes(ancestor.status) && ancestor.merge_base_commit?.sha === baseline.commit, 'Historical OTA native build is not an ancestor of the prepared source.');
        const reused = plan.mode === 'auto' && plan.previousOta.some(value => same(value, receipt));
        invariant(reused || operation?.status === 'complete' && operation.providerIds.at(-1) === receipt.group
          && same(operation.result, receipt) && receipt.commit === prepared.commit, 'Historical OTA needs its exact original payload receipt.');
        const updates = await transport.getUpdate(receipt.group);
        invariant(updates.length === 1 && updates[0].group === receipt.group, 'Historical OTA group differs.');
        const manifest = typeof updates[0].manifestFragment === 'string' ? JSON.parse(updates[0].manifestFragment) : updates[0].manifestFragment;
        const payload = { launch: manifest.launchAsset.fileSHA256, assets: [...new Set(manifest.assets.map(value => value.fileSHA256))].sort() };
        invariant(hashIdentity(payload) === receipt.payloadHash, 'Historical OTA payload hash differs.');
        const spec = { projectId: plan.nativeRelease.expoProjectId, serverUrl: plan.nativeRelease.serverUrl,
          platform: receipt.platform, runtime: receipt.runtimeVersion, channel: plan.profile, environment: baseline.environment,
          source: receipt.commit, branch, payload, marker: reused ? updates[0].message : `little-say:${plan.runId}:ota:${receipt.platform}-${receipt.runtimeVersion}:${receipt.payloadHash}` };
        const matching = await pages(offset => transport.listUpdates(spec, offset), group => group.some(value => value.message === spec.marker), group => group[0]?.group);
        invariant(same(matching.map(group => group[0].group).sort(), [receipt.group]) && matching[0].length === 1, 'Historical OTA has missing or duplicate publications.');
        const proof = await createEasOtaProvider(spec, transport).verify({ id: receipt.group });
        operations.push({ key, status: 'complete', providerIds: operation?.providerIds || [receipt.group], result: receipt, proof, reused });
      }
      for (const operation of partial.filter(operation => !handled.has(operation.key))) {
        handled.add(operation.key);
        // Without the original exported payload receipt, provider metadata cannot recreate its validated bytes.
        operations.push({ key: operation.key, status: 'unknown', providerIds: operation.providerIds,
          reason: 'The original OTA payload receipt is missing; retain exact IDs and recover retained export evidence before continuation.' });
        remaining.push(operation.key);
      }
    }
  }
  invariant(originalOperations.every(operation => handled.has(operation.key)), 'Unrecognized historical provider operation requires reconciliation.');
  const deployment = continuations.deploy;
  if (deployment?.status === 'complete') invariant(deployment.receipt?.service === 'little-say' && deployment.receipt?.healthy === true
    && deployment.receipt?.evidence === 'webhook-health-response', 'Historical deployment continuation lacks health evidence.');
  if (!scope && (plan.server || plan.ota.length) && !successful('deploy / deploy') && deployment?.status !== 'complete') remaining.push('deploy');
  for (const stage of ['promote-server', 'deploy', 'ota']) if (continuations[stage] && (!scope || scope === stage)) {
    const operation = continuations[stage];
    operations.push({ key: stage, status: operation.status, providerIds: operation.operationId ? [operation.operationId] : [],
      ...(operation.receipt ? { result: operation.receipt } : {}) });
  }
  if (plan.native.length || plan.ota.length || plan.submissions.length) await environmentHash(transport, plan);
  const complete = !scope && remaining.length === 0 && operations.every(operation => operation.status === 'complete');
  const safeToAbandon = !scope && operations.every(operation => ['complete', 'failed'].includes(operation.status))
    && (!plan.server || Boolean(server))
    && jobs.filter(job => ['deploy / deploy', 'ota', 'submit', 'promote-server'].includes(job.name)).every(job => ['success', 'skipped'].includes(job.conclusion)
      || (job.name === 'deploy / deploy' ? deployment?.status : job.name === 'promote-server' ? continuations['promote-server']?.status : undefined) === 'complete')
    && jobs.every(job => ['prepare', 'server', 'promote-server', 'deploy / deploy', 'native (android)', 'native (ios)', 'ota', 'submit', 'finalize'].includes(job.name) || job.conclusion === 'skipped');
  const receipt = complete ? { schema: 1, runId: plan.runId, profile: plan.profile, commit: prepared.commit, plan, prepared,
    ...(server ? { server } : {}), baselines, ota: [...(plan.previousOta || []).filter(old => !ota?.receipts.some(value => value.platform === old.platform && value.runtimeVersion === old.runtimeVersion)), ...(ota?.receipts || [])] } : undefined;
  const inventory = plan.ota.length ? eligibleBaselines(plan, baselines, policy) : null;
  return { ...base, complete, safeToAbandon, remaining, ...(receipt ? { receipt } : {}),
    ...(plan.ota.length ? { otaInventory: { receipts: operations.filter(value => value.key.startsWith('ota-') && value.status === 'complete').map(value => value.result),
      requiredKeys: [...inventory.eligible.keys()].sort(), skipped: inventory.skipped } } : {}) };
}

/** Create the shared legacy adapter; its recovery records are new-producer evidence, never replacements for the old journal. */
export function createLittleSayRecoveryAdapter(options = {}) {
  return {
    /** Verify current provider evidence, then append an audited action and return only the original remaining work. */
    async recover({ ledger, state, request }) {
      invariant(request.absence === undefined && request.operationId === undefined, 'Legacy absence or replacement IDs need original retained evidence; they cannot be supplied as an override.');
      const evidence = await observeLittleSayRelease({ ...options, config: ledger.config, api: ledger.api, state });
      if (request.action === 'complete') invariant(evidence.complete, `Original release remains incomplete: ${evidence.remaining.join(', ')}.`);
      if (request.action === 'abandon') invariant(evidence.safeToAbandon && request.reason?.trim().length >= 20, 'Reconcile original provider outcomes and provide a specific abandonment reason.');
      if (request.action === 'retry') {
        const operation = evidence.operations.find(value => value.key === request.stage);
        invariant(operation?.status === 'failed', 'Legacy retry requires the exact freshly observed failed operation.');
      }
      const verified = await appendLittleSayRecovery({ ledger, state, action: request.action, evidence, reason: request.reason });
      return { schemaVersion: 1, kind: 'expo-release-recovery', legacy: true, releaseId: String(state.release.id), action: request.action,
        plan: state.legacyPlan, prepared: state.recovery.prepared, originalOrigin: state.origin, stages: evidence.remaining,
        operations: evidence.operations, resolved: verified.resolved, evidenceDigest: verified.recovery.events.at(-1).digest,
        retry: request.action === 'retry', ...(request.stage ? { stage: request.stage } : {}) };
    },
  };
}
