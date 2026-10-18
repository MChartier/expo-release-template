/** @file Reads Little Say's original asset-based release journals without rewriting plans, source evidence, provider IDs, or successful independent operations. */
import { createHash, randomUUID } from 'node:crypto';
import { hashIdentity, invariant, verifyPlan, reduceOperation } from '../../packages/release-engine/index.mjs';
import { baselineKey, configuredComponents, runtimeBaselineKey } from '../planner.mjs';
import { verifyProducer } from '../github.mjs';

const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const VERSION = /^\d+\.\d+\.\d+$/;
const PLATFORMS = ['android', 'ios'];
const bytesHash = bytes => createHash('sha256').update(bytes).digest('hex');
const identity = (input, environment = null) => hashIdentity({ identity: input, environment });
const recoveryAsset = /^recovery-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/;
const knownAsset = /^(plan|candidate|prepared|ota|receipt|journal|retirement|retirement-complete|reconciliation|completion-recovery)\.json$|^op\.(server|build-(android|ios)|submit-(android|ios)|ota-(android|ios)-[a-z0-9.-]+)\.\d{6}\.json$|^export\.[a-z0-9.-]+\.(json|bin)$|^recovery-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/;

function planIdentity(plan, runId) {
  invariant([1, 2].includes(plan?.schema) && plan.runId === runId && SHA.test(plan.source)
    && ['internal', 'production'].includes(plan.profile), 'Historical plan identity differs.');
  invariant(typeof plan.server === 'boolean' && VERSION.test(plan.serverVersion) && VERSION.test(plan.nativeRelease?.version)
    && Number.isSafeInteger(plan.nativeRelease.androidVersionCode) && plan.nativeRelease.androidVersionCode > 0
    && /^[1-9]\d*$/.test(plan.nativeRelease.iosBuildNumber), 'Historical version reservation is invalid.');
  for (const key of ['native', 'ota', 'submissions']) invariant(Array.isArray(plan[key])
    && new Set(plan[key]).size === plan[key].length && plan[key].every(value => PLATFORMS.includes(value)), 'Historical target selection is invalid.');
  invariant(DIGEST.test(plan.inputs?.environmentHash) && typeof plan.inputs.server === 'string'
    && PLATFORMS.every(platform => typeof plan.inputs.native?.[platform] === 'string' && typeof plan.inputs.bundle?.[platform] === 'string'), 'Historical source inputs are incomplete.');
  if (plan.schema === 2) {
    invariant(plan.policy?.runtime === 'fingerprint' && plan.policy.deployment === 'changed-server'
      && plan.policy.submission === 'enqueue-before-ota' && plan.policy.inputVersion === 1, 'Unsupported historical policy.');
    verifyPlan(plan.engine);
    const { engine, ...original } = plan;
    invariant(engine.source.commit === plan.source && engine.decisionsDigest === hashIdentity(original), 'Historical engine envelope differs.');
  }
}

function cloudBaseline(value) {
  invariant([2, 3].includes(value?.schema) && SHA.test(value.commit) && PLATFORMS.includes(value.platform)
    && ['internal', 'production'].includes(value.profile), 'Invalid historical native baseline.');
  invariant(value.channel === value.profile && value.environment === (value.profile === 'internal' ? 'preview' : 'production'), 'Historical native destination differs.');
  invariant(value.schema === 2 ? value.runtimeVersion === value.release?.version
    : value.runtimePolicy === 'fingerprint' && /^[a-f0-9]{40,64}$/.test(value.runtimeVersion), 'Historical runtime policy differs.');
  invariant(/^[a-f0-9]{40,64}$/.test(value.fingerprint) && /^[a-f0-9]{40,64}$/.test(value.compatibility)
    && DIGEST.test(value.environmentHash) && DIGEST.test(value.artifactSha256) && UUID.test(value.buildId), 'Historical native evidence is incomplete.');
  invariant(typeof value.artifactUrl === 'string' && new URL(value.artifactUrl).protocol === 'https:', 'Historical native artifact URL is invalid.');
  return value;
}

function operations(documents) {
  const histories = new Map();
  for (const [name, original] of [...documents].filter(([name]) => name.startsWith('op.')).sort(([a], [b]) => a.localeCompare(b))) {
    const match = /^op\.(.+)\.(\d{6})\.json$/.exec(name);
    const history = histories.get(match?.[1]) || [];
    invariant(match && original?.schema === 1 && original.key === match[1] && original.sequence === history.length + 1
      && original.sequence === Number(match[2]) && ['intent', 'running', 'failed', 'complete'].includes(original.status)
      && Array.isArray(original.ids) && original.ids.every(id => typeof id === 'string' && id.length)
      && new Set(original.ids).size === original.ids.length, 'Historical operation sequence is invalid.');
    const previous = history.at(-1);
    invariant(!previous || previous.status !== 'complete' && previous.ids.every((id, index) => original.ids[index] === id), 'Historical operation IDs or success were rewritten.');
    if (original.status === 'complete') invariant(original.ids.length && original.result, 'Historical completed operation lacks its result.');
    history.push(original); histories.set(original.key, history);
  }
  return [...histories].map(([key, history]) => ({ key, history, original: history.at(-1),
    status: { intent: 'unknown', running: 'accepted', failed: 'failed', complete: 'complete' }[history.at(-1).status],
    providerIds: [...history.at(-1).ids], result: history.at(-1).result }));
}

async function producingRun(api, config, plan, prepared) {
  const run = await api(`/actions/runs/${plan.runId}`);
  invariant(String(run.id) === plan.runId && run.head_sha === plan.source && run.head_branch === config.defaultBranch
    && run.event === 'workflow_dispatch' && run.path === (config.legacy?.workflow || '.github/workflows/cut-release.yml')
    && run.repository?.full_name?.toLowerCase() === config.repository.toLowerCase(), 'Historical producing workflow/source differs.');
  const jobs = []; let total;
  for (let page = 1; ; page++) {
    const response = await api(`/actions/runs/${plan.runId}/jobs?filter=all&per_page=100&page=${page}`);
    invariant(Array.isArray(response.jobs) && Number.isSafeInteger(response.total_count), 'Incomplete historical job evidence.');
    total ??= response.total_count; invariant(response.total_count === total, 'Historical job inventory changed.');
    jobs.push(...response.jobs); if (response.jobs.length < 100) break;
  }
  invariant(jobs.length === total && new Set(jobs.map(job => job.id)).size === jobs.length, 'Historical job inventory is incomplete or repeated.');
  if (prepared) {
    invariant([prepared.commit, prepared.candidate, prepared.tree].every(value => SHA.test(value)), 'Historical prepared source is invalid.');
    const commit = await api(`/git/commits/${prepared.commit}`);
    invariant(commit.sha === prepared.commit && commit.tree?.sha === prepared.tree, 'Historical prepared tree differs.');
    const comparison = await api(`/compare/${plan.source}...${prepared.commit}`);
    invariant(['ahead', 'identical'].includes(comparison.status) && comparison.merge_base_commit?.sha === plan.source, 'Historical prepared source does not descend from its request.');
  }
  return { run, jobs, origin: { kind: 'github', runId: plan.runId, runAttempt: run.run_attempt, legacy: true,
    workflow: run.path, workflowCommit: plan.source } };
}

function normalizedBaseline(plan, receipt, config, origin) {
  const baseline = { components: {}, runtimes: {}, reservations: {
    server: { version: plan.serverVersion, codes: {} },
    native: { version: plan.nativeRelease.version, codes: { android: plan.nativeRelease.androidVersionCode, ios: Number(plan.nativeRelease.iosBuildNumber) } },
  } };
  const components = configuredComponents(config, plan.profile);
  const store = (component, value, profile = plan.profile) => {
    if (!component) return;
    baseline.components[baselineKey(component, profile)] = value;
    if (value.runtime) baseline.runtimes[runtimeBaselineKey(component, profile, value.runtime)] = value;
  };
  const server = receipt?.server || plan.previousServer;
  if (server) {
    invariant(SHA.test(server.commit) && VERSION.test(server.version) && /^sha256:[a-f0-9]{64}$/.test(server.digest)
      && typeof server.input === 'string', 'Historical server baseline is invalid.');
    store(components.find(item => item.kind === 'server'), { identity: identity(server.input), source: server.commit, version: server.version, origin, legacy: server });
  }
  for (const raw of receipt?.baselines || plan.baselines || []) {
    const value = cloudBaseline(raw);
    const component = configuredComponents(config, value.profile).find(item => item.kind === 'native' && item.platform === value.platform);
    store(component, { identity: identity(value.compatibility, value.environmentHash), compatibilityIdentity: value.compatibility,
      environmentHash: value.environmentHash, fingerprint: value.fingerprint, runtime: value.runtimeVersion,
      version: value.release.version, versionCode: Number(value.platform === 'android' ? value.release.androidVersionCode : value.release.iosBuildNumber),
      source: value.commit, origin, releaseMetadata: value.release, legacy: value }, value.profile);
  }
  for (const value of receipt?.ota || plan.previousOta || []) {
    invariant(SHA.test(value.commit) && PLATFORMS.includes(value.platform) && UUID.test(value.group) && typeof value.input === 'string'
      && DIGEST.test(value.payloadHash) && (VERSION.test(value.runtimeVersion) || /^[a-f0-9]{40,64}$/.test(value.runtimeVersion)), 'Historical OTA receipt is invalid.');
    const component = components.find(item => item.kind === 'ota' && item.platform === value.platform);
    const native = (receipt?.baselines || plan.baselines || []).find(item => item.platform === value.platform && item.runtimeVersion === value.runtimeVersion);
    // Keep old-runtime receipts even if their native build has since been explicitly retired.
    store(component, { identity: identity(value.input, component?.compareEnvironment === false ? null : native?.environmentHash || plan.inputs.environmentHash),
      runtime: value.runtimeVersion, source: value.commit, environmentHash: native?.environmentHash || plan.inputs.environmentHash, origin, legacy: value });
  }
  return baseline;
}

/** Read a legacy candidate/completion/retirement while preserving immutable evidence and its original workflow contract. */
export async function readLittleSayRelease({ release, record, assets, api, config }) {
  const tag = /^(candidate|abandoned)\/([1-9]\d*)$|^release\/(internal|production)\/([1-9]\d*)$/.exec(release.tag_name);
  invariant(tag && release.author?.login === 'github-actions[bot]', 'Historical release tag/owner differs.');
  const runId = tag[2] || tag[4]; const completed = Boolean(tag[3]) && !release.draft;
  invariant(new Set(assets.map(asset => asset.name)).size === assets.length && assets.every(asset => knownAsset.test(asset.name)), 'Unknown or duplicate historical assets.');
  const documents = new Map(); const inventory = [];
  for (const asset of assets) {
    invariant(asset.uploader?.login === 'github-actions[bot]' && /^sha256:[a-f0-9]{64}$/.test(asset.digest)
      && Number.isSafeInteger(asset.size) && asset.size > 0 && (asset.name.endsWith('.bin') || asset.size <= 16 * 1024 * 1024), 'Historical asset ownership/digest/size is invalid.');
    const bytes = Buffer.from(await api(`/releases/assets/${asset.id}`, { raw: true }));
    invariant(bytes.length === asset.size && `sha256:${bytesHash(bytes)}` === asset.digest, 'Historical retained bytes changed.');
    if (!asset.name.endsWith('.bin')) documents.set(asset.name, JSON.parse(bytes.toString('utf8')));
    inventory.push({ id: asset.id, name: asset.name, digest: asset.digest, size: asset.size });
  }
  const receipt = documents.get('receipt.json');
  const archive = documents.get('journal.json');
  if (archive) {
    invariant(archive.schema === 1 && archive.runId === runId && Array.isArray(archive.assets)
      && new Set(archive.assets.map(asset => asset.name)).size === archive.assets.length, 'Historical journal archive differs.');
    for (const asset of archive.assets) {
      invariant(knownAsset.test(asset.name) && !recoveryAsset.test(asset.name) && /^sha256:[a-f0-9]{64}$/.test(asset.digest), 'Unknown historical archived asset.');
      if (asset.retainedAsset) invariant(asset.retainedAsset === asset.name && inventory.some(item => item.name === asset.name && item.digest === asset.digest), 'Archived binary is missing or changed.');
      else {
        invariant(asset.content && (!documents.has(asset.name) || hashIdentity(documents.get(asset.name)) === hashIdentity(asset.content)), 'Archived document conflicts with retained evidence.');
        documents.set(asset.name, asset.content);
      }
    }
  }
  const plan = documents.get('plan.json') || receipt?.plan; planIdentity(plan, runId);
  if (receipt) invariant(receipt.schema === 1 && receipt.runId === runId && receipt.profile === plan.profile
    && hashIdentity(receipt.plan) === hashIdentity(plan) && receipt.commit === receipt.prepared?.commit, 'Historical completion identity differs.');
  if (tag[3]) invariant(tag[3] === plan.profile && receipt, 'Historical completion tag differs.');
  const prepared = documents.get('prepared.json') || receipt?.prepared;
  const candidate = documents.get('candidate.json');
  if (candidate && prepared) invariant(candidate.candidate === prepared.candidate && candidate.tree === prepared.tree, 'Historical prepared metadata conflicts.');
  const producer = await producingRun(api, config, plan, prepared);
  const states = operations(documents);
  let retired = false;
  if (tag[1] === 'abandoned') {
    const retirement = documents.get('retirement.json');
    invariant(release.draft && retirement?.schema === 1 && retirement.runId === runId && retirement.releaseId === release.id
      && retirement.source === plan.source && Array.isArray(retirement.assets), 'Historical retirement identity differs.');
    for (const item of retirement.assets) {
      invariant(inventory.some(asset => asset.id === item.id && asset.name === item.name && asset.digest === item.digest)
        && item.hash === (item.name.endsWith('.bin') ? item.digest.slice(7) : hashIdentity(documents.get(item.name))), 'Historical retired evidence differs.');
    }
    invariant(inventory.every(asset => ['retirement.json', 'retirement-complete.json'].includes(asset.name)
      || retirement.assets.some(item => item.id === asset.id && item.name === asset.name)), 'Unexpected asset after historical retirement.');
    invariant(documents.get('retirement-complete.json')?.retirementHash === hashIdentity(retirement), 'Historical retirement readback is incomplete.');
    if (retirement.kind === 'reconciled-partial') invariant(retirement.evidenceHash === hashIdentity(documents.get('reconciliation.json')), 'Historical reconciliation evidence differs.');
    retired = true;
  }
  if (completed) invariant(producer.run.status === 'completed' && (producer.run.conclusion === 'success'
    || documents.get('completion-recovery.json')?.kind === 'verified-publication-completion'), 'Historical completion lacks its successful original workflow or audited recovery.');
  const originalInventory = inventory.filter(item => !recoveryAsset.test(item.name)).sort((a, b) => a.name.localeCompare(b.name));
  const recoveryEvents = inventory.filter(item => recoveryAsset.test(item.name)).sort((a, b) => a.id - b.id).map(item => documents.get(item.name));
  const continuations = {};
  let previous = null;
  for (const [index, event] of recoveryEvents.entries()) {
    invariant(!completed && !retired && !['abandon', 'complete'].includes(previous?.action), 'Historical resolved release cannot acquire recovery actions.');
    const { digest: recordedDigest, ...unsigned } = event;
    invariant(event.schemaVersion === 1 && event.kind === 'little-say-recovery' && event.releaseId === String(release.id)
      && event.runId === runId && event.sequence === index + 1 && event.previousDigest === (previous?.digest ?? null)
      && event.originalInventoryDigest === hashIdentity(originalInventory) && event.planDigest === hashIdentity(plan)
      && event.digest === hashIdentity(unsigned) && ['resume', 'retry', 'reconcile', 'abandon', 'complete'].includes(event.action), 'Historical recovery chain or original evidence differs.');
    await verifyProducer(api, config, event.origin, event.workflowCommit);
    invariant(event.evidence?.kind === 'little-say-provider-audit' && event.evidence.planDigest === hashIdentity(plan)
      && event.evidence.preparedDigest === hashIdentity(prepared ?? null) && Array.isArray(event.evidence.operations), 'Historical recovery lacks a provider audit.');
    if (event.evidence.continuation) {
      const { stage, transition, operation } = event.evidence.continuation;
      invariant(['resume', 'retry'].includes(event.action) && /^(submit-(android|ios)|promote-server|deploy|ota)$/.test(stage)
        && operation?.operationKey === stage && operation.request?.planDigest === hashIdentity(plan)
        && operation.request?.source === prepared?.commit && operation.request?.stage === stage
        && operation.request?.originalInventoryDigest === hashIdentity(originalInventory),
      'Historical continuation does not identify its original stage and source.');
      const reduced = reduceOperation(continuations[stage] ?? null, transition);
      invariant(hashIdentity(reduced) === hashIdentity(operation), 'Historical continuation operation transition was rewritten.');
      continuations[stage] = operation;
    }
    if (event.action === 'abandon') invariant(!event.evidence.scope && event.evidence.safeToAbandon === true && event.reason?.trim().length >= 20, 'Historical abandonment lacks terminal proof/reason.');
    if (event.action === 'complete') {
      const saved = event.evidence.receipt;
      invariant(!event.evidence.scope && event.evidence.complete === true && saved?.schema === 1 && saved.runId === runId && saved.profile === plan.profile
        && hashIdentity(saved.plan) === hashIdentity(plan) && hashIdentity(saved.prepared) === hashIdentity(prepared)
        && saved.commit === prepared.commit, 'Historical recovery completion differs from its original contract.');
    }
    previous = event;
  }
  const recoveredCompletion = previous?.action === 'complete';
  const recoveredRetirement = previous?.action === 'abandon';
  const baseline = normalizedBaseline(plan, recoveredCompletion ? previous.evidence.receipt : completed ? receipt : undefined, config, producer.origin);
  return { release, record, plan: null, legacyPlan: plan, origin: producer.origin, legacy: true, assets, inventory,
    events: states.map(state => ({ stage: state.key, status: state.status, legacy: state.original })),
    baseline, resolved: completed || retired || recoveredCompletion || recoveredRetirement, recovery: { format: 'little-say', runId, prepared, producer: producer.run,
      jobs: producer.jobs, operations: states, documents: Object.fromEntries(documents), completed, retired,
      requiresProviderVerification: true, originalWorkflow: producer.run.path, originalInventory, events: recoveryEvents,
      recoveredCompletion, recoveredRetirement, continuations } };
}

/** Append an authenticated audit without modifying original plans, assets, provider IDs or original producer provenance. */
export async function appendLittleSayRecovery({ ledger, state, action, evidence, reason }) {
  const current = await ledger.read(state.release.id);
  invariant(current.legacy && current.recovery.format === 'little-say' && current.release.draft && !current.resolved, 'Only unresolved original Little Say drafts accept recovery.');
  invariant(hashIdentity(current.inventory) === hashIdentity(state.inventory), 'Historical journal changed during provider verification.');
  invariant(current.recovery.producer.status === 'completed' && current.recovery.producer.run_attempt === state.recovery.producer.run_attempt
    && current.recovery.jobs.every(job => job.status === 'completed') && hashIdentity(current.recovery.jobs) === hashIdentity(state.recovery.jobs), 'Original workflow changed during provider verification.');
  await verifyProducer(ledger.api, ledger.config, ledger.origin, ledger.workflowCommit);
  const previous = current.recovery.events.at(-1);
  const record = { schemaVersion: 1, kind: 'little-say-recovery', releaseId: String(current.release.id), runId: current.legacyPlan.runId,
    sequence: current.recovery.events.length + 1, previousDigest: previous?.digest ?? null,
    originalInventoryDigest: hashIdentity(current.recovery.originalInventory), planDigest: hashIdentity(current.legacyPlan),
    origin: ledger.origin, workflowCommit: ledger.workflowCommit, action, ...(reason ? { reason } : {}), evidence };
  record.digest = hashIdentity(record);
  await ledger.upload(current.release.id, `recovery-${randomUUID()}.json`, Buffer.from(`${JSON.stringify(record)}\n`));
  const verified = await ledger.read(current.release.id);
  invariant(verified.recovery.events.at(-1)?.digest === record.digest, 'Historical recovery append readback differs.');
  return verified;
}

/** Recognize only configured original Little Say tags; Markdown release bodies remain unchanged. */
export const littleSayLegacyReader = {
  /** Match historical asset-ledger records without interpreting an untrusted body as a new plan. */
  matches(_record, release, config) { return config.legacy?.format === 'little-say' && /^(candidate|abandoned)\/\d+$|^release\/(internal|production)\/\d+$/.test(release.tag_name); },
  /** Preserve original records and return verified compatibility data for inspection/recovery. */
  read: readLittleSayRelease,
};
