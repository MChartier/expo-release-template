/** @file Continues one explicitly selected historical Little Say stage from retained evidence, using shared provider operations and separately authenticated recovery records. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { hashIdentity, invariant, reduceOperation } from '../../packages/release-engine/index.mjs';
import { configuredComponents } from '../planner.mjs';
import { executeOperation } from '../operations.mjs';
import { createEasSubmissionProvider } from '../providers/eas.mjs';
import { createEasPublisherWorkspace } from '../providers/eas-workspace.mjs';
import { createGhcrTransport } from '../providers/ghcr.mjs';
import { createDeploymentProvider } from '../providers/deploy.mjs';
import { appendLittleSayRecovery } from './little-say.mjs';
import { observeLittleSayRelease } from './little-say-recovery.mjs';

const same = (left, right) => hashIdentity(left) === hashIdentity(right);

async function json(api, file, source) {
  const value = await api(`/contents/${file}?ref=${source}`);
  invariant(value.type === 'file' && value.encoding === 'base64' && value.size < 1024 * 1024, 'Original release metadata is unavailable.');
  return JSON.parse(Buffer.from(value.content, 'base64').toString('utf8'));
}

function lastJob(state, name) {
  return [...state.recovery.jobs].filter(value => value.name === name)
    .sort((a, b) => (a.run_attempt || 1) - (b.run_attempt || 1) || a.id - b.id).at(-1);
}

/** Select one fixed credential boundary without provider calls, source execution, or an implicit all-stage resume. */
export function routeLittleSayRecovery(state, request, config) {
  invariant(state.legacy && state.recovery.format === 'little-say' && state.recovery.prepared && !state.resolved,
    'Continuation requires an unresolved, prepared historical Little Say release.');
  invariant(['resume', 'retry'].includes(request.action) && typeof request.stage === 'string', 'Choose one explicit historical stage to continue.');
  const stage = request.stage; const plan = state.legacyPlan;
  if (stage.startsWith('submit-')) {
    const platform = stage.slice(7);
    invariant(plan.submissions.includes(platform), 'Submission was not selected by the original plan.');
    const target = configuredComponents(config, plan.profile).find(value => value.kind === 'native' && value.platform === platform);
    invariant(target, 'The original submission target is no longer configured.');
    return { stage, provider: 'expo', approval: target.approvalEnvironment || '' };
  }
  if (stage === 'promote-server') {
    invariant(plan.server, 'The original plan has no server promotion.');
    const target = configuredComponents(config, plan.profile).find(value => value.kind === 'server');
    invariant(target, 'The original server target is no longer configured.');
    return { stage, provider: 'image', approval: target.approvalEnvironment || '' };
  }
  if (stage === 'deploy') {
    invariant((plan.server || plan.ota.length) && config.deployment?.type === 'wireguard-webhook'
      && config.deployment.service === 'little-say' && config.deployment.path === '/deploy/little-say', 'Historical deployment target differs.');
    return { stage, provider: 'deploy', approval: config.deployment.environment || '' };
  }
  invariant(stage === 'ota' && plan.ota.length, 'This historical stage needs original retained build/export evidence before continuation.');
  const approvals = [...new Set(configuredComponents(config, plan.profile).filter(value => value.kind === 'ota'
    && plan.ota.includes(value.platform)).map(value => value.approvalEnvironment || ''))];
  invariant(approvals.length <= 1, 'Historical OTA inventory spans different approval boundaries.');
  return { stage, provider: 'expo', approval: approvals[0] || '' };
}

async function deploymentAudit(state, api, config) {
  const plan = state.legacyPlan; const prepared = state.recovery.prepared; const recovered = state.recovery.continuations || {};
  invariant(state.recovery.producer.status === 'completed' && state.recovery.jobs.every(value => value.status === 'completed')
    && lastJob(state, 'prepare')?.conclusion === 'success', 'Original deployment prerequisites still have an active or unvalidated producer.');
  const ancestry = await api(`/compare/${prepared.commit}...${config.defaultBranch}`);
  invariant(['ahead', 'identical'].includes(ancestry.status) && ancestry.merge_base_commit?.sha === prepared.commit, 'Original deployment source is outside protected history.');
  const operations = [];
  const original = key => state.recovery.operations.find(value => value.key === key);
  if (plan.server) {
    const server = original('server');
    invariant(server?.status === 'complete' && lastJob(state, 'server')?.conclusion === 'success'
      && server.result?.commit === prepared.commit && server.result.version === plan.serverVersion,
    'Deployment needs the original verified server publication.');
    invariant(lastJob(state, 'promote-server')?.conclusion === 'success' || recovered['promote-server']?.status === 'complete'
      && recovered['promote-server'].receipt.digest === server.result.digest, 'Deployment needs authenticated image promotion.');
    operations.push({ key: 'server', status: 'complete', providerIds: server.providerIds, result: server.result });
  }
  for (const platform of plan.native) {
    const build = original(`build-${platform}`); const receipt = build?.result;
    invariant(build?.status === 'complete' && lastJob(state, `native (${platform})`)?.conclusion === 'success'
      && receipt?.commit === prepared.commit && receipt.platform === platform && receipt.profile === plan.profile
      && same(receipt.release, plan.nativeRelease) && /^[a-f0-9]{40,64}$/.test(receipt.fingerprint)
      && /^[a-f0-9]{64}$/.test(receipt.artifactSha256), 'Deployment needs original verified native completion.');
    operations.push({ key: `build-${platform}`, status: 'complete', providerIds: build.providerIds, result: receipt });
  }
  for (const platform of plan.submissions) {
    const key = `submit-${platform}`; const submitted = original(key); const continuation = recovered[key];
    const build = original(`build-${platform}`)?.result;
    invariant(submitted?.status === 'complete' && lastJob(state, 'submit')?.conclusion === 'success'
      || continuation?.status === 'complete' && continuation.receipt?.artifact?.buildId === build?.buildId
      && continuation.receipt.artifact.sha256 === build?.artifactSha256, 'Deployment needs authenticated submission completion.');
    operations.push({ key, status: 'complete', providerIds: continuation?.operationId ? [continuation.operationId] : submitted.providerIds });
  }
  if (plan.ota.length) {
    invariant(lastJob(state, 'ota')?.conclusion === 'success' && state.recovery.documents['ota.json']
      || recovered.ota?.status === 'complete', 'Deployment needs authenticated original OTA inventory completion.');
  }
  if (recovered.deploy) operations.push({ key: 'deploy', status: recovered.deploy.status, providerIds: recovered.deploy.operationId ? [recovered.deploy.operationId] : [], result: recovered.deploy.receipt });
  return { schemaVersion: 1, kind: 'little-say-provider-audit', scope: 'deploy', planDigest: hashIdentity(plan), preparedDigest: hashIdentity(prepared),
    originalInventoryDigest: hashIdentity(state.recovery.originalInventory), operations, complete: false, safeToAbandon: false,
    remaining: lastJob(state, 'deploy / deploy')?.conclusion === 'success' || recovered.deploy?.status === 'complete' ? [] : ['deploy'] };
}

function copyImage(image, digest, environment, run) {
  invariant(/^ghcr\.io\/[a-z0-9._-]+\/[a-z0-9._/-]+$/.test(image) && /^sha256:[a-f0-9]{64}$/.test(digest), 'Invalid original image identity.');
  invariant(environment.GITHUB_ACTOR && environment.GHCR_TOKEN, 'Historical promotion needs registry credentials.');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-image-promotion-'));
  try {
    const auth = path.join(directory, 'auth.json');
    fs.writeFileSync(auth, JSON.stringify({ auths: { 'ghcr.io': { auth: Buffer.from(`${environment.GITHUB_ACTOR}:${environment.GHCR_TOKEN}`).toString('base64') } } }), { mode: 0o600 });
    run('skopeo', ['copy', '--all', '--preserve-digests', '--authfile', auth, `docker://${image}@${digest}`, `docker://${image}:latest`],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 1200000 });
  } catch { throw new Error('Historical image promotion outcome needs exact alias readback before continuation.'); }
  finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

function promotionProvider(state, api, config, reader, environment, run) {
  const server = state.recovery.operations.find(value => value.key === 'server')?.result;
  invariant(server, 'Promotion needs the original completed image receipt.');
  const verify = value => invariant(value?.digest === server.digest && value.manifests?.length === 2
    && value.manifests.every(item => item.labels?.['org.opencontainers.image.revision'] === server.commit
      && item.labels?.['org.opencontainers.image.version'] === server.version
      && item.labels?.['org.opencontainers.image.source']?.toLowerCase() === `https://github.com/${config.repository.toLowerCase()}`), 'Historical image readback differs.');
  const current = async () => {
    const branch = await api(`/branches/${encodeURIComponent(config.defaultBranch)}`);
    invariant(branch.protected === true && /^[a-f0-9]{40}$/.test(branch.commit?.sha), 'Historical promotion needs protected branch authority.');
    const ancestry = await api(`/compare/${server.commit}...${branch.commit.sha}`);
    invariant(['ahead', 'identical'].includes(ancestry.status) && ancestry.merge_base_commit?.sha === server.commit, 'Historical image source is outside protected history.');
    invariant((await json(api, 'release.json', branch.commit.sha)).version === server.version, 'A newer server version exists; historical latest promotion is blocked.');
    return branch.commit.sha;
  };
  const observe = async () => {
    const value = await reader.inspect('latest', { includeLabels: true });
    if (value?.digest === server.digest) { verify(value); return { id: server.digest, status: 'complete', value }; }
    return { id: server.digest, status: 'unknown', previousDigest: value?.digest ?? null };
  };
  const publish = async () => {
    const source = await current();
    for (const alias of [`v${server.version}`, `sha-${server.commit}`]) verify(await reader.inspect(alias, { includeLabels: true }));
    invariant((await api(`/branches/${encodeURIComponent(config.defaultBranch)}`)).commit.sha === source, 'Protected source advanced before historical promotion.');
    if ((await observe()).status !== 'complete') {
      if (reader.promote) await reader.promote(server.digest, 'latest'); else copyImage(server.image, server.digest, environment, run);
    }
    const result = await observe(); invariant(result.status === 'complete', 'Historical latest alias did not confirm publication.'); return result;
  };
  return {
    /** Reconcile the exact immutable digest, never infer absence from a missing moving alias. */
    find: observe,
    /** Read only the moving alias assigned to the original image. */
    status: observe,
    /** Keep health/deployment and source identity separate from image publication. */
    async verify(value) { if (value.status === 'complete') verify(value.value); return { source: server.commit, digest: server.digest, alias: 'latest', status: value.status }; },
    /** Promote exact registry bytes after fresh protected version and source checks. */
    start: publish,
    /** A partial moving-alias write is idempotent only while protected metadata still permits the original version. */
    resumeUnknown: publish,
  };
}

/** Execute one retained-evidence stage; this function never checks out source, rebuilds a native binary or synthesizes a missing OTA payload. */
export async function continueLittleSayRelease({ ledger, releaseId, stage, retry = false, environment = process.env,
  transport, registry, deploy, run = execFileSync, publisherWorkspace = createEasPublisherWorkspace }) {
  let state = await ledger.read(releaseId);
  const route = routeLittleSayRecovery(state, { action: retry ? 'retry' : 'resume', stage }, ledger.config);
  const audit = stage === 'deploy' ? await deploymentAudit(state, ledger.api, ledger.config)
    : await observeLittleSayRelease({ state, config: ledger.config, api: ledger.api, transport, registry, environment, scope: stage });
  const existing = state.recovery.continuations?.[stage];
  if (!audit.remaining.includes(stage) && (!existing || existing.status === 'complete')) {
    invariant(existing?.status === 'complete' || audit.operations.some(value => value.key === stage && value.status === 'complete'), 'The selected historical stage is not remaining.');
    return { route, complete: true, operation: existing ?? audit.operations.find(value => value.key === stage), remaining: audit.remaining };
  }
  const plan = state.legacyPlan; const source = state.recovery.prepared.commit;
  const context = { planDigest: hashIdentity(plan), source, stage, originalInventoryDigest: hashIdentity(state.recovery.originalInventory) };
  const persist = async (transition, operation) => {
    state = await appendLittleSayRecovery({ ledger, state: await ledger.read(releaseId), action: retry ? 'retry' : 'resume',
      evidence: { ...audit, continuation: { stage, transition, operation } } });
  };
  const bridge = {
    /** Expose only separately verified continuation states to the shared operation executor. */
    async read() { state = await ledger.read(releaseId); const operation = state.recovery.continuations?.[stage]; return { events: operation ? [{ stage, operation }] : [] }; },
    /** Persist each reducer event under the original inventory and the new recovery producer. */
    async append(_id, event) {
      if (event.transition) { await persist(event.transition, event.operation); return; }
      invariant(event.continuation?.requested && stage === 'promote-server' && event.operation?.status === 'unknown', 'Continuation requires a reducer transition.');
      state = await appendLittleSayRecovery({ ledger, state: await ledger.read(releaseId), action: retry ? 'retry' : 'resume',
        evidence: { ...audit, idempotentPromotion: { stage, request: context, proof: event.continuation.proof } } });
    },
  };
  let provider; let workspace;
  try {
    if (stage.startsWith('submit-')) {
      const platform = stage.slice(7); const original = state.recovery.operations.find(value => value.key === stage);
      const observed = audit.operations.find(value => value.key === stage);
      const built = state.recovery.operations.find(value => value.key === `build-${platform}`)?.result;
      invariant(built && audit.operations.some(value => value.key === `build-${platform}` && value.status === 'complete'), 'Submission requires its original verified native receipt.');
      const [app, eas] = await Promise.all(['apps/mobile/app.json', 'apps/mobile/eas.json'].map(file => json(ledger.api, file, source)));
      const spec = { projectId: plan.nativeRelease.expoProjectId, owner: plan.nativeRelease.expoOwner, slug: app.expo.slug,
        applicationId: platform === 'android' ? app.expo.android.package : app.expo.ios.bundleIdentifier,
        platform, source, profile: 'production', channel: plan.profile, environment: 'production', distribution: 'store',
        version: plan.nativeRelease.version, versionCode: Number(platform === 'android' ? plan.nativeRelease.androidVersionCode : plan.nativeRelease.iosBuildNumber),
        runtime: built.runtimeVersion, fingerprint: built.fingerprint, marker: `little-say:${plan.runId}:build:${platform}`,
        destination: eas.submit?.production?.[platform], artifact: { kind: 'eas-build', buildId: built.buildId, sha256: built.artifactSha256 } };
      invariant(plan.profile === 'production' && spec.destination, 'Historical submission needs its original store profile/destination.');
      spec.build = { ...spec }; delete spec.build.artifact; delete spec.build.destination;
      workspace = publisherWorkspace(spec, { env: environment });
      provider = createEasSubmissionProvider(spec, workspace.transport);
      const find = provider.find.bind(provider);
      provider.find = request => find({ ...request, previousIds: [...new Set([...(request?.previousIds || []), ...(original?.providerIds || [])])] });
      if (!existing) {
        const id = observed?.providerIds.at(-1);
        invariant(id || !original && lastJob(state, 'submit')?.conclusion === 'skipped', 'An original submission may have started; reconcile its exact ID before enqueue.');
        if (id) {
          let operation = null;
          const initial = { type: 'intent', operationKey: stage, request: context }; operation = reduceOperation(operation, initial); await persist(initial, operation);
          const accepted = { type: 'accepted', operationId: id }; operation = reduceOperation(operation, accepted); await persist(accepted, operation);
          if (observed.status === 'failed') {
            const failure = { type: 'failed', definitive: true, reason: 'Original submission has a freshly verified terminal outcome.', proof: observed.proof };
            operation = reduceOperation(operation, failure); await persist(failure, operation);
          }
        }
      }
    } else if (stage === 'promote-server') {
      const image = state.recovery.operations.find(value => value.key === 'server')?.result?.image;
      const reader = registry || createGhcrTransport({ image, username: environment.GITHUB_ACTOR, token: environment.GHCR_TOKEN });
      provider = promotionProvider(state, ledger.api, ledger.config, reader, environment, run);
    } else if (stage === 'deploy') {
      invariant(audit.remaining.every(value => value === 'deploy'), 'Finish original publications and promotion before deployment.');
      invariant(existing || lastJob(state, 'deploy / deploy')?.conclusion === 'skipped', 'Original deployment may still have changed the host; reconcile its outcome before another POST.');
      provider = createDeploymentProvider(ledger.config.deployment, { environment, ...(deploy ? { transport: deploy } : {}) });
    } else {
      const inventory = audit.otaInventory;
      invariant(inventory && same(inventory.receipts.map(value => `${value.platform}-${value.runtimeVersion}`).sort(), inventory.requiredKeys),
        'Missing original OTA payload receipts; final inventory cannot be synthesized.');
      const receipt = { receipts: inventory.receipts, skipped: inventory.skipped };
      const observation = { id: hashIdentity(receipt), status: 'complete', receipt };
      provider = {
        /** A final inventory contains only already verified independent original runtime receipts. */
        async start() { return observation; },
        /** The deterministic inventory is recoverable after a lost record append. */
        async find() { return observation; },
        /** Read the same sealed inventory without publishing another update. */
        async status() { return observation; },
        /** Preserve the original receipt bytes and skipped-runtime policy. */
        async verify() { return receipt; },
      };
    }
    const operation = await executeOperation({ ledger: bridge, releaseId, stage, provider, context, retry: retry || stage === 'promote-server' });
    return { route, complete: operation.status === 'complete', operation, remaining: audit.remaining.filter(value => value !== stage || operation.status !== 'complete') };
  } finally { workspace?.dispose(); }
}
