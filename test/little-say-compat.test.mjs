/** @file Verifies original Little Say workflow ownership, immutable asset journals, partial-success preservation, reservations and fail-closed legacy recovery inputs. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { hashIdentity } from '../packages/release-engine/index.mjs';
import { readLittleSayRelease, littleSayLegacyReader } from '../src/compat/little-say.mjs';
import { createLittleSayRecoveryAdapter, observeLittleSayRelease } from '../src/compat/little-say-recovery.mjs';
import { continueLittleSayRelease, routeLittleSayRecovery } from '../src/compat/little-say-continuation.mjs';

const sha = char => char.repeat(40);
const digest = char => char.repeat(64);
const uuid = index => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;

function fixture() {
  const config = { schemaVersion: 1, repository: 'fixture/app', defaultBranch: 'master', defaultProfile: 'internal',
    profiles: { internal: { channel: 'internal', environment: 'preview' }, production: { channel: 'production', environment: 'production' } },
    legacy: { format: 'little-say', workflow: '.github/workflows/cut-release.yml' },
    components: [{ id: 'server', kind: 'server' }, ...['android', 'ios'].flatMap(platform => [
      { id: platform, kind: 'native', platform, builder: 'eas' }, { id: `${platform}.ota`, kind: 'ota', platform, nativeTarget: platform }])] };
  const plan = { schema: 1, runId: '123', source: sha('a'), profile: 'internal', mode: 'auto', bump: 'patch', server: true,
    native: ['android', 'ios'], submissions: [], ota: ['android', 'ios'], serverVersion: '0.3.2',
    nativeRelease: { version: '0.1.3', androidVersionCode: 4, iosBuildNumber: '4', expoOwner: 'fixture', expoProjectId: uuid(1), serverUrl: 'https://fixture.invalid' },
    inputs: { server: digest('b'), native: { android: digest('c'), ios: digest('d') }, bundle: { android: digest('e'), ios: digest('f') }, environmentHash: digest('a') },
    baselines: [], previousOta: [] };
  const prepared = { commit: sha('b'), candidate: sha('c'), tree: sha('d') };
  const server = { commit: prepared.commit, version: plan.serverVersion, image: 'ghcr.io/fixture/app', digest: `sha256:${digest('c')}`, input: plan.inputs.server };
  const baselines = ['android', 'ios'].map((platform, i) => ({ schema: 2, commit: prepared.commit, platform, profile: 'internal', channel: 'internal', environment: 'preview',
    release: plan.nativeRelease, runtimeVersion: plan.nativeRelease.version, fingerprint: sha('e'), compatibility: plan.inputs.native[platform], environmentHash: plan.inputs.environmentHash,
    buildId: uuid(i + 2), artifactUrl: `https://fixture.invalid/${platform}`, artifactSha256: digest('b') }));
  const ota = baselines.map((baseline, i) => ({ commit: prepared.commit, platform: baseline.platform, runtimeVersion: baseline.runtimeVersion,
    group: uuid(i + 5), input: plan.inputs.bundle[baseline.platform], payloadHash: digest('d') }));
  const release = { id: 42, tag_name: 'candidate/123', draft: true, author: { login: 'github-actions[bot]' }, body: 'Recoverable release journal.' };
  const run = { id: 123, run_attempt: 1, head_sha: plan.source, head_branch: 'master', path: '.github/workflows/cut-release.yml', event: 'workflow_dispatch',
    repository: { full_name: config.repository }, status: 'completed', conclusion: 'failure' };
  const jobs = ['prepare', 'server', 'promote-server', 'deploy / deploy', 'native (android)', 'native (ios)', 'ota', 'submit', 'finalize']
    .map((name, i) => ({ id: i + 1, name, run_attempt: 1, status: 'completed', conclusion: name === 'submit' ? 'skipped' : name === 'finalize' ? 'failure' : 'success' }));
  const assets = []; const contents = new Map();
  const put = (name, content) => {
    const bytes = Buffer.isBuffer(content) ? content : Buffer.from(JSON.stringify(content));
    const asset = { id: assets.length + 100, name, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, size: bytes.length, uploader: { login: 'github-actions[bot]' } };
    assets.push(asset); contents.set(asset.id, bytes); return asset;
  };
  put('plan.json', plan); put('candidate.json', { candidate: prepared.candidate, tree: prepared.tree }); put('prepared.json', prepared);
  for (const [key, id, result] of [['server', prepared.commit, server], ...baselines.map(value => [`build-${value.platform}`, value.buildId, value]),
    ...ota.map(value => [`ota-${value.platform}-${value.runtimeVersion}`, value.group, value])]) {
    for (const [index, status] of ['intent', 'running', 'complete'].entries()) put(`op.${key}.${String(index + 1).padStart(6, '0')}.json`,
      { schema: 1, key, sequence: index + 1, status, ids: index ? [id] : [], ...(status === 'complete' ? { result } : {}) });
  }
  put('ota.json', { receipts: ota, skipped: [] });
  const api = async (route, options = {}) => {
    assert.equal(options.method, undefined, 'Compatibility inspection must never mutate providers or the ledger.');
    if (route.startsWith('/releases/assets/')) return contents.get(Number(route.split('/').at(-1)));
    if (route === '/actions/runs/123') return run;
    if (route === '/actions/runs/123/jobs?filter=all&per_page=100&page=1') return { jobs, total_count: jobs.length };
    if (route === `/git/commits/${prepared.commit}`) return { sha: prepared.commit, tree: { sha: prepared.tree } };
    if (route === `/compare/${plan.source}...${prepared.commit}`) return { status: 'ahead', merge_base_commit: { sha: plan.source } };
    throw Error(`Unexpected read: ${route}`);
  };
  const read = () => readLittleSayRelease({ release, record: null, assets, api, config });
  return { plan, prepared, server, baselines, ota, release, run, jobs, assets, contents, put, read, config, api };
}

test('partial finalization retains original plan, successful independent stages and original workflow evidence', async () => {
  const f = fixture(); const state = await f.read();
  assert.equal(state.plan, null); assert.deepEqual(state.legacyPlan, f.plan); assert.equal(state.resolved, false);
  assert.equal(state.recovery.operations.length, 5); assert(state.recovery.operations.every(operation => operation.status === 'complete'));
  assert.deepEqual(state.recovery.jobs, f.jobs); assert.equal(state.recovery.requiresProviderVerification, true);
  assert.equal(state.origin.workflowCommit, f.plan.source); assert.equal(state.origin.workflow, '.github/workflows/cut-release.yml');
  assert.equal(state.baseline.reservations.native.codes.ios, 4); assert.deepEqual(state.baseline.components, {});
  assert.equal(littleSayLegacyReader.matches(null, f.release, f.config), true);
});

test('completed receipt preserves independent platform/runtime baselines without claiming new provenance', async () => {
  const f = fixture(); f.run.conclusion = 'success'; f.release.tag_name = 'release/internal/123'; f.release.draft = false;
  f.put('receipt.json', { schema: 1, runId: f.plan.runId, profile: f.plan.profile, commit: f.prepared.commit,
    plan: f.plan, prepared: f.prepared, server: f.server, baselines: f.baselines, ota: f.ota });
  const state = await f.read(); assert.equal(state.resolved, true);
  assert.equal(Object.keys(state.baseline.components).length, 5); assert.equal(Object.keys(state.baseline.runtimes).length, 4);
  assert(state.baseline.components['server||||']);
  assert.equal(state.baseline.components['android|internal|android|internal|preview'].legacy.buildId, uuid(2));
});

test('retirement remains a draft but resolves only after exact retained evidence readback', async () => {
  const f = fixture(); f.release.tag_name = 'abandoned/123';
  const retirement = { schema: 1, runId: '123', releaseId: 42, source: f.plan.source, reason: 'Synthetic fixture retirement',
    assets: f.assets.map(asset => ({ id: asset.id, name: asset.name, digest: asset.digest, hash: hashIdentity(JSON.parse(f.contents.get(asset.id))) })) };
  f.put('retirement.json', retirement); f.put('retirement-complete.json', { retirementHash: hashIdentity(retirement) });
  const state = await f.read(); assert.equal(state.resolved, true); assert.equal(state.recovery.retired, true);
  assert.deepEqual(state.baseline.components, {}); assert.equal(state.baseline.reservations.native.version, '0.1.3');
  f.put('export.android-0.1.3.bin', Buffer.from('unexpected')); await assert.rejects(f.read(), /Unexpected asset/);
});

test('historical reader rejects wrong producer, altered bytes, missing sequence and unknown assets', async () => {
  for (const change of [
    f => { f.run.head_sha = sha('f'); }, f => { f.run.path = '.github/workflows/release-handler.yml'; },
    f => { f.run.repository.full_name = 'other/app'; }, f => { f.assets[0].uploader.login = 'human'; },
    f => { f.contents.set(f.assets[0].id, Buffer.from('{}')); },
    f => { f.assets.splice(f.assets.findIndex(asset => asset.name === 'op.build-android.000002.json'), 1); },
    f => { f.put('unexpected.json', {}); },
  ]) { const f = fixture(); change(f); await assert.rejects(f.read()); }
});

test('archival preserves original JSON and refuses missing retained binary artifacts', async () => {
  const f = fixture(); const original = f.assets.map(asset => ({ id: asset.id, name: asset.name, digest: asset.digest, content: JSON.parse(f.contents.get(asset.id)) }));
  f.put('journal.json', { schema: 1, runId: '123', releaseId: 42, assets: original });
  assert.deepEqual((await f.read()).legacyPlan, f.plan);
  const archive = f.assets.at(-1); const malformed = { schema: 1, runId: '123', releaseId: 42,
    assets: [{ name: 'export.android-0.1.3.bin', digest: `sha256:${digest('e')}`, retainedAsset: 'export.android-0.1.3.bin' }] };
  f.assets.pop(); f.contents.delete(archive.id); f.put('journal.json', malformed);
  await assert.rejects(f.read(), /binary/);
});

function recoveryFixture() {
  const f = fixture(); f.config.github = { handlerWorkflow: 'release-handler.yml' };
  f.plan.inputs.environmentHash = createHash('sha256').update('[]').digest('hex');
  f.plan.channelBranch = { id: uuid(30), name: 'internal' };
  const payload = { launch: Buffer.from(digest('c'), 'hex').toString('base64url'), assets: [] };
  for (const baseline of f.baselines) baseline.environmentHash = f.plan.inputs.environmentHash;
  for (const receipt of f.ota) receipt.payloadHash = hashIdentity(payload);
  const originals = { 'plan.json': f.plan, 'ota.json': { receipts: f.ota, skipped: [] } };
  for (const baseline of f.baselines) originals[`op.build-${baseline.platform}.000003.json`] = { schema: 1, key: `build-${baseline.platform}`, sequence: 3, status: 'complete', ids: [baseline.buildId], result: baseline };
  for (const receipt of f.ota) originals[`op.ota-${receipt.platform}-${receipt.runtimeVersion}.000003.json`] = {
    schema: 1, key: `ota-${receipt.platform}-${receipt.runtimeVersion}`, sequence: 3, status: 'complete', ids: [receipt.group], result: receipt };
  const replace = (name, value) => {
    const asset = f.assets.find(asset => asset.name === name); const bytes = Buffer.from(JSON.stringify(value));
    asset.size = bytes.length; asset.digest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`; f.contents.set(asset.id, bytes);
  };
  for (const [name, value] of Object.entries(originals)) replace(name, value);
  const files = { 'apps/mobile/app.json': { expo: { slug: 'little-say', android: { package: 'fixture.app' }, ios: { bundleIdentifier: 'fixture.app' } } },
    'apps/mobile/eas.json': { build: { internal: { channel: 'internal', environment: 'preview', distribution: 'internal', autoIncrement: false } } },
    'release-policy.json': { schema: 1, retiredRuntimes: [] } };
  const newRun = { id: 701, repository: { full_name: f.config.repository }, head_branch: 'master', head_sha: sha('f'),
    event: 'workflow_run', path: '.github/workflows/release-handler.yml', run_attempt: 1 };
  const api = async (route, options) => {
    if (route === '/actions/runs/701') return newRun;
    if (route === `/compare/${f.prepared.commit}...master`) return { status: 'ahead', merge_base_commit: { sha: f.prepared.commit } };
    if (route === `/compare/${f.prepared.commit}...${f.prepared.commit}`) return { status: 'identical', merge_base_commit: { sha: f.prepared.commit } };
    if (route === `/git/ref/tags/v${f.server.version}`) return { object: { type: 'commit', sha: f.prepared.commit } };
    if (route.startsWith('/contents/')) {
      const [name, query] = route.slice(10).split('?'); assert.equal(query, `ref=${f.prepared.commit}`);
      const content = Buffer.from(JSON.stringify(files[name])); return { type: 'file', encoding: 'base64', size: content.length, content: content.toString('base64') };
    }
    return f.api(route, options);
  };
  const builds = f.baselines.map(baseline => ({ id: baseline.buildId, status: 'FINISHED', platform: baseline.platform.toUpperCase(),
    app: { id: f.plan.nativeRelease.expoProjectId }, appIdentifier: 'fixture.app', gitCommitHash: f.prepared.commit, buildProfile: 'internal',
    appVersion: f.plan.nativeRelease.version, appBuildVersion: 4, runtime: { version: f.plan.nativeRelease.version }, updateChannel: { name: 'internal' },
    distribution: 'INTERNAL', message: `little-say:123:build:${baseline.platform}`, fingerprint: { hash: baseline.fingerprint },
    artifacts: { applicationArchiveUrl: baseline.artifactUrl }, submissions: [] }));
  const updates = f.ota.map((receipt, index) => ({ id: uuid(60 + index), group: receipt.group, platform: receipt.platform,
    runtime: { version: receipt.runtimeVersion }, gitCommitHash: receipt.commit, isGitWorkingTreeDirty: false, branch: f.plan.channelBranch,
    message: `little-say:123:ota:${receipt.platform}-${receipt.runtimeVersion}:${receipt.payloadHash}`, environment: 'PREVIEW',
    manifestFragment: { launchAsset: { fileSHA256: payload.launch, storageKey: `bundle-${index}` }, assets: [],
      extra: { expoClient: { extra: { eas: { projectId: f.plan.nativeRelease.expoProjectId }, serverUrl: f.plan.nativeRelease.serverUrl } } } } }));
  const transport = {
    project: async spec => assert.equal(spec.projectId, f.plan.nativeRelease.expoProjectId), environment: async () => [],
    cli: async args => { assert.equal(args[0], 'build:list', 'Recovery must not enqueue a build.'); return builds.filter(build => build.platform.toLowerCase() === args[args.indexOf('--platform') + 1]); },
    getBuild: async id => structuredClone(builds.find(build => build.id === id)),
    hashArtifact: async url => url.includes('/asset/') ? digest('c') : digest('b'),
    channel: async () => f.plan.channelBranch,
    getUpdate: async id => structuredClone(updates.filter(update => update.group === id)),
    listUpdates: async spec => updates.filter(update => update.platform === spec.platform && update.runtime.version === spec.runtime).map(update => [update]),
    assetUrls: async (_id, keys) => keys.map(storageKey => ({ storageKey, url: `https://fixture.invalid/asset/${storageKey}` })),
  };
  const image = { digest: f.server.digest, manifests: ['amd64', 'arm64'].map(architecture => ({ platform: `linux/${architecture}`,
    digest: `sha256:${digest('d')}`, labels: { 'org.opencontainers.image.revision': f.prepared.commit, 'org.opencontainers.image.version': f.server.version,
      'org.opencontainers.image.source': 'https://github.com/fixture/app' } })) };
  const registry = { inspect: async reference => { assert([`v${f.server.version}`, `sha-${f.prepared.commit}`].includes(reference)); return structuredClone(image); } };
  const read = () => readLittleSayRelease({ release: f.release, record: null, assets: f.assets, api, config: f.config });
  const ledger = { config: f.config, api, origin: { kind: 'github', runId: '701', runAttempt: 1 }, workflowCommit: sha('f'), read,
    upload: async (_id, name, bytes) => f.put(name, bytes) };
  const audit = async () => observeLittleSayRelease({ state: await read(), config: f.config, api, transport, registry });
  return { ...f, read, api, ledger, transport, registry, builds, updates, image, replace, audit, newRun, files,
    adapter: createLittleSayRecoveryAdapter({ transport, registry }) };
}

test('concrete historical completion rechecks image aliases, native artifacts, OTA bytes and deployment before separately authenticated append', async () => {
  const f = recoveryFixture(); const original = f.assets.map(asset => ({ ...asset }));
  const state = await f.read(); const evidence = await f.audit(); assert.equal(evidence.complete, true);
  const result = await f.adapter.recover({ ledger: f.ledger, state, request: { action: 'complete' } });
  assert.equal(result.resolved, true); assert.deepEqual(f.assets.slice(0, original.length), original);
  assert.equal(f.release.tag_name, 'candidate/123'); assert.equal(f.release.draft, true);
  const saved = await f.read(); assert.equal(saved.origin.runId, '123'); assert.equal(saved.recovery.events[0].origin.runId, '701');
  assert.equal(saved.recovery.recoveredCompletion, true); assert.equal(Object.keys(saved.baseline.components).length, 5);
  assert.equal(saved.recovery.events[0].evidence.receipt.plan.source, f.plan.source);
});

test('historical recovery does not trust completion booleans or old success when exact provider evidence changed', async () => {
  for (const change of [
    f => { f.builds[0].gitCommitHash = sha('f'); }, f => { f.builds[0].fingerprint.hash = sha('f'); },
    f => { f.builds[0].submissions = [{ id: uuid(80) }]; }, f => { f.image.manifests[0].labels['org.opencontainers.image.version'] = '9.9.9'; },
    f => { f.updates[0].manifestFragment.launchAsset.fileSHA256 = Buffer.from(digest('a'), 'hex').toString('base64url'); },
    f => { f.transport.hashArtifact = async () => digest('f'); }, f => { f.transport.environment = async () => [{ name: 'CHANGED', type: 'STRING', visibility: 'PUBLIC', value: 'value' }]; },
    f => { f.transport.channel = async () => ({ id: uuid(81), name: 'other' }); },
  ]) { const f = recoveryFixture(); change(f); await assert.rejects(f.audit()); }
});

test('missing historical deployment leaves completion pending without replaying successful publication', async () => {
  const f = recoveryFixture(); f.jobs.find(job => job.name === 'deploy / deploy').conclusion = 'failure';
  const evidence = await f.audit(); assert.equal(evidence.complete, false); assert.deepEqual(evidence.remaining, ['deploy']);
  assert(evidence.operations.every(operation => operation.status === 'complete'));
  const result = await f.adapter.recover({ ledger: f.ledger, state: await f.read(), request: { action: 'resume' } });
  assert.deepEqual(result.stages, ['deploy']); assert.deepEqual(result.plan, f.plan); assert.equal(result.resolved, false);
  await assert.rejects(f.adapter.recover({ ledger: f.ledger, state: await f.read(), request: { action: 'complete' } }), /incomplete/);
});

test('recovery append verifies the new handler separately and detects changed old bytes and a forked chain', async () => {
  const f = recoveryFixture(); await f.adapter.recover({ ledger: f.ledger, state: await f.read(), request: { action: 'resume' } });
  const recovery = f.assets.find(asset => asset.name.startsWith('recovery-')); const event = JSON.parse(f.contents.get(recovery.id));
  assert.equal(event.workflowCommit, sha('f')); assert.equal(event.evidence.planDigest, hashIdentity(f.plan));
  f.newRun.path = '.github/workflows/other.yml'; await assert.rejects(f.read(), /authorized producer/); f.newRun.path = '.github/workflows/release-handler.yml';
  f.put(`recovery-${uuid(99)}.json`, event); await assert.rejects(f.read(), /chain/);
});

test('historical audit refuses active original jobs and duplicate successful native requests', async () => {
  const active = recoveryFixture(); active.jobs[0].status = 'in_progress'; await assert.rejects(active.audit(), /still active/);
  const duplicate = recoveryFixture(); duplicate.builds.push({ ...duplicate.builds[0], id: uuid(90) });
  await assert.rejects(duplicate.audit(), /already successful/);
});

test('missing final OTA document preserves independently verified runtime receipts without claiming completion', async () => {
  const f = recoveryFixture(); f.assets.splice(f.assets.findIndex(asset => asset.name === 'ota.json'), 1);
  const evidence = await f.audit(); assert.equal(evidence.complete, false); assert.deepEqual(evidence.remaining, ['ota']);
  assert.equal(evidence.operations.filter(operation => operation.key.startsWith('ota-') && operation.status === 'complete').length, 2);
});

test('a partial OTA lacking its original payload receipt remains ambiguous and blocks abandonment', async () => {
  const f = recoveryFixture(); f.assets.splice(f.assets.findIndex(asset => asset.name === 'ota.json'), 1);
  const key = `ota-android-${f.plan.nativeRelease.version}`;
  f.replace(`op.${key}.000003.json`, { schema: 1, key, sequence: 3, status: 'running', ids: [f.ota[0].group] });
  const evidence = await f.audit(); assert.equal(evidence.safeToAbandon, false);
  assert.equal(evidence.operations.find(operation => operation.key === key).status, 'unknown');
  assert.equal(evidence.operations.find(operation => operation.key === key).providerIds[0], f.ota[0].group);
  await assert.rejects(f.adapter.recover({ ledger: f.ledger, state: await f.read(), request: { action: 'abandon', reason: 'Stop this original release after observing every provider.' } }), /Reconcile/);
});

test('a terminal native failure can retire an original partial cut while preserving the successful image and native IDs', async () => {
  const f = recoveryFixture();
  f.assets.splice(0, f.assets.length, ...f.assets.filter(asset => asset.name !== 'ota.json' && !asset.name.startsWith('op.ota-')));
  f.builds[1].status = 'ERRORED';
  f.replace('op.build-ios.000003.json', { schema: 1, key: 'build-ios', sequence: 3, status: 'failed', ids: [f.baselines[1].buildId] });
  for (const job of f.jobs) {
    if (['promote-server', 'deploy / deploy', 'ota', 'submit'].includes(job.name)) job.conclusion = 'skipped';
    if (job.name === 'native (ios)') job.conclusion = 'failure';
  }
  const evidence = await f.audit(); assert.equal(evidence.safeToAbandon, true); assert.equal(evidence.complete, false);
  const result = await f.adapter.recover({ ledger: f.ledger, state: await f.read(), request: { action: 'abandon', reason: 'Retire the failed native cut after exact provider readback.' } });
  assert.equal(result.resolved, true); assert.equal(result.operations.find(value => value.key === 'build-ios').status, 'failed');
  const retained = await f.read(); assert.deepEqual(retained.baseline.components, {}); assert.equal(retained.baseline.reservations.native.codes.ios, 4);
  assert.equal(retained.recovery.operations.find(value => value.key === 'build-android').providerIds[0], f.baselines[0].buildId);
});

function configureDeployment(f) {
  f.config.deployment = { type: 'wireguard-webhook', service: 'little-say', path: '/deploy/little-say', environment: 'self-hosted-testing' };
  f.jobs.find(job => job.name === 'deploy / deploy').conclusion = 'skipped';
}

const noExpo = new Proxy({}, { get: () => () => { throw new Error('This recovery stage must not call Expo.'); } });
const noRegistry = { inspect: () => { throw new Error('This recovery stage must not read the registry.'); } };

test('explicit legacy routing preserves approval boundaries and rejects implicit or unsupported stages', async () => {
  const f = recoveryFixture(); configureDeployment(f); const state = await f.read();
  assert.deepEqual(routeLittleSayRecovery(state, { action: 'resume', stage: 'deploy' }, f.config),
    { stage: 'deploy', provider: 'deploy', approval: 'self-hosted-testing' });
  assert.deepEqual(routeLittleSayRecovery(state, { action: 'resume', stage: 'ota' }, f.config), { stage: 'ota', provider: 'expo', approval: '' });
  for (const request of [{ action: 'resume' }, { action: 'resume', stage: 'build-ios' }, { action: 'resume', stage: 'submit-ios' }]) {
    assert.throws(() => routeLittleSayRecovery(state, request, f.config));
  }
});

test('legacy deployment continuation records intent before one POST and resumes without replaying completed stages', async () => {
  const f = recoveryFixture(); configureDeployment(f); const originals = f.assets.map(asset => ({ ...asset })); let calls = 0;
  const deploy = () => { calls++; const event = JSON.parse(f.contents.get(f.assets.at(-1).id));
    assert.equal(event.evidence.continuation.operation.status, 'intent');
    return { service: 'little-say', healthy: true, evidence: 'webhook-health-response' }; };
  const input = { ledger: f.ledger, releaseId: 42, stage: 'deploy', transport: noExpo, registry: noRegistry, deploy };
  assert.equal((await continueLittleSayRelease(input)).complete, true);
  assert.equal((await continueLittleSayRelease(input)).complete, true); assert.equal(calls, 1);
  assert.deepEqual(f.assets.slice(0, originals.length), originals);
  assert.equal((await f.audit()).complete, true);
  const state = await f.read(); assert.equal(state.recovery.continuations.deploy.status, 'complete');
  assert.equal(state.origin.runId, '123'); assert(state.recovery.events.every(event => event.origin.runId === '701'));
  assert.equal((await f.adapter.recover({ ledger: f.ledger, state, request: { action: 'complete' } })).resolved, true);
});

test('a lost deployment response or failed original deploy never authorizes another POST', async () => {
  const f = recoveryFixture(); configureDeployment(f); let calls = 0;
  const input = { ledger: f.ledger, releaseId: 42, stage: 'deploy', transport: f.transport, registry: f.registry,
    deploy: () => { calls++; throw new Error('lost health response'); } };
  await assert.rejects(continueLittleSayRelease(input), /lost health/);
  assert.equal((await f.read()).recovery.continuations.deploy.status, 'unknown');
  await assert.rejects(continueLittleSayRelease(input), /No unique provider result/); assert.equal(calls, 1);
  assert.equal((await f.audit()).safeToAbandon, false);
  const original = recoveryFixture(); configureDeployment(original); original.jobs.find(job => job.name === 'deploy / deploy').conclusion = 'failure';
  await assert.rejects(continueLittleSayRelease({ ...input, ledger: original.ledger, transport: original.transport, registry: original.registry }), /reconcile its outcome/);
  assert.equal(calls, 1);
});

test('legacy final OTA inventory reuses every original verified receipt without a new publication', async () => {
  const f = recoveryFixture(); f.assets.splice(f.assets.findIndex(asset => asset.name === 'ota.json'), 1);
  const input = { ledger: f.ledger, releaseId: 42, stage: 'ota', transport: f.transport, registry: noRegistry };
  assert.equal((await continueLittleSayRelease(input)).complete, true);
  assert.equal((await f.audit()).complete, true); assert.equal((await continueLittleSayRelease(input)).complete, true);
  const retained = (await f.read()).recovery.continuations.ota.receipt;
  assert.deepEqual(retained.receipts, f.ota); assert.deepEqual(retained.skipped, []);
  const partial = recoveryFixture(); partial.assets.splice(partial.assets.findIndex(asset => asset.name === 'ota.json'), 1);
  const key = `ota-android-${partial.plan.nativeRelease.version}`;
  partial.replace(`op.${key}.000003.json`, { schema: 1, key, sequence: 3, status: 'running', ids: [partial.ota[0].group] });
  await assert.rejects(continueLittleSayRelease({ ...input, ledger: partial.ledger, transport: partial.transport, registry: partial.registry }), /Missing original OTA payload/);
});

test('legacy image promotion uses the original digest and refuses a newer protected version', async () => {
  const f = recoveryFixture(); f.jobs.find(job => job.name === 'promote-server').conclusion = 'failure';
  let latest = null; let publications = 0; let version = f.server.version;
  const registry = { inspect: async (reference, options) => reference === 'latest' ? latest : f.registry.inspect(reference, options),
    promote: async (digest, alias) => { publications++; assert.equal(digest, f.server.digest); assert.equal(alias, 'latest'); latest = f.image; } };
  const originalApi = f.ledger.api;
  f.ledger.api = async (route, options) => {
    if (route === '/branches/master') return { protected: true, commit: { sha: f.prepared.commit } };
    if (route === `/contents/release.json?ref=${f.prepared.commit}`) { const bytes = Buffer.from(JSON.stringify({ version })); return { type: 'file', encoding: 'base64', size: bytes.length, content: bytes.toString('base64') }; }
    return originalApi(route, options);
  };
  const input = { ledger: f.ledger, releaseId: 42, stage: 'promote-server', transport: noExpo, registry };
  version = '9.0.0'; await assert.rejects(continueLittleSayRelease(input), /newer server version/); assert.equal(publications, 0);
  version = f.server.version; assert.equal((await continueLittleSayRelease(input)).complete, true); assert.equal(publications, 1);
  assert.equal((await continueLittleSayRelease(input)).complete, true); assert.equal(publications, 1);
  assert.equal((await f.audit()).complete, true);
});

function productionSubmissionFixture() {
  const f = recoveryFixture(); f.plan.profile = 'production'; f.plan.submissions = ['android']; f.plan.channelBranch.name = 'production';
  f.files['apps/mobile/eas.json'] = { build: { production: { channel: 'production', environment: 'production', distribution: 'store', autoIncrement: false } },
    submit: { production: { android: { track: 'internal', releaseStatus: 'draft' } } } };
  for (const baseline of f.baselines) {
    baseline.profile = 'production'; baseline.channel = 'production'; baseline.environment = 'production';
    f.replace(`op.build-${baseline.platform}.000003.json`, { schema: 1, key: `build-${baseline.platform}`, sequence: 3, status: 'complete', ids: [baseline.buildId], result: baseline });
  }
  for (const build of f.builds) { build.buildProfile = 'production'; build.updateChannel.name = 'production'; build.distribution = 'STORE'; }
  for (const update of f.updates) update.environment = 'PRODUCTION';
  f.replace('plan.json', f.plan);
  const submissions = []; let requests = 0;
  const create = () => {
    const value = { id: uuid(85 + requests), status: 'IN_PROGRESS', platform: 'ANDROID', app: { id: f.plan.nativeRelease.expoProjectId },
      submittedBuild: structuredClone(f.builds[0]), androidConfig: { track: 'internal', releaseStatus: 'DRAFT' }, canRetry: false };
    submissions.push(value); f.builds[0].submissions.push({ id: value.id }); return value;
  };
  f.transport.getSubmission = async id => structuredClone(submissions.find(value => value.id === id));
  const publisher = { ...f.transport, cli: async args => { assert.equal(args[0], 'submit'); requests++; create(); return ''; } };
  const publisherWorkspace = spec => { assert.equal(spec.artifact.buildId, f.baselines[0].buildId); assert.equal(spec.destination.track, 'internal'); return { transport: publisher, dispose() {} }; };
  return { ...f, submissions, publisher, publisherWorkspace, create, requests: () => requests };
}

test('legacy submission retains exact acceptance before observation and resumes the original ID without reupload', async () => {
  const f = productionSubmissionFixture(); const input = { ledger: f.ledger, releaseId: 42, stage: 'submit-android', transport: f.transport,
    registry: noRegistry, publisherWorkspace: f.publisherWorkspace };
  const accepted = await continueLittleSayRelease(input); assert.equal(accepted.complete, false); assert.equal(f.requests(), 1);
  assert.equal((await f.read()).recovery.continuations['submit-android'].operationId, f.submissions[0].id);
  f.submissions[0].status = 'FINISHED'; assert.equal((await continueLittleSayRelease(input)).complete, true); assert.equal(f.requests(), 1);
  assert.equal((await f.audit()).complete, true); assert.equal((await continueLittleSayRelease(input)).complete, true);
  assert.equal(f.requests(), 1);
});

test('a lost legacy submission enqueue response reconciles the exact build association without another request', async () => {
  const f = productionSubmissionFixture(); let calls = 0;
  f.publisher.cli = async () => { calls++; f.create().status = 'FINISHED'; throw Error('lost enqueue response'); };
  const input = { ledger: f.ledger, releaseId: 42, stage: 'submit-android', transport: f.transport, registry: f.registry, publisherWorkspace: f.publisherWorkspace };
  await assert.rejects(continueLittleSayRelease(input), /lost enqueue/); assert.equal(calls, 1);
  assert.equal((await continueLittleSayRelease(input)).complete, true); assert.equal(calls, 1);
  assert.equal((await f.read()).recovery.continuations['submit-android'].status, 'complete');
});

test('legacy continuation rejects a rewritten reducer state even with a recomputed outer digest', async () => {
  const f = recoveryFixture(); configureDeployment(f);
  await continueLittleSayRelease({ ledger: f.ledger, releaseId: 42, stage: 'deploy', transport: f.transport, registry: f.registry,
    deploy: () => ({ service: 'little-say', healthy: true, evidence: 'webhook-health-response' }) });
  const last = f.assets.at(-1); const event = JSON.parse(f.contents.get(last.id));
  event.evidence.continuation.operation.operationId = 'changed-id'; delete event.digest; event.digest = hashIdentity(event);
  f.replace(last.name, event); await assert.rejects(f.read(), /transition was rewritten/);
});

test('legacy submission retry preserves the failed ID and requires fresh provider eligibility and destination proof', async () => {
  const f = productionSubmissionFixture(); const failed = f.create(); failed.status = 'ERRORED'; failed.canRetry = true;
  for (const [index, status] of ['intent', 'running', 'failed'].entries()) f.put(`op.submit-android.${String(index + 1).padStart(6, '0')}.json`,
    { schema: 1, key: 'submit-android', sequence: index + 1, status, ids: index ? [failed.id] : [] });
  f.jobs.find(job => job.name === 'submit').conclusion = 'failure'; let retries = 0;
  f.publisher.cli = async args => {
    assert.deepEqual(args, ['submit:retry', failed.id, '--non-interactive', '--json']); retries++;
    const next = { ...structuredClone(failed), id: uuid(86), status: 'IN_PROGRESS', canRetry: false };
    f.submissions.push(next); f.builds[0].submissions.push({ id: next.id }); return { id: next.id };
  };
  const input = { ledger: f.ledger, releaseId: 42, stage: 'submit-android', transport: f.transport, registry: f.registry, publisherWorkspace: f.publisherWorkspace };
  await assert.rejects(continueLittleSayRelease(input), /explicit retry/); assert.equal(retries, 0);
  failed.androidConfig.track = 'production'; await assert.rejects(continueLittleSayRelease({ ...input, retry: true }), /destination/); assert.equal(retries, 0);
  failed.androidConfig.track = 'internal'; failed.canRetry = false;
  await assert.rejects(continueLittleSayRelease({ ...input, retry: true }), /does not authorize/); assert.equal(retries, 0);
  failed.canRetry = true; const accepted = await continueLittleSayRelease({ ...input, retry: true }); assert.equal(accepted.complete, false); assert.equal(retries, 1);
  const state = await f.read(); const operation = state.recovery.continuations['submit-android'];
  assert.equal(operation.history[0].operationId, failed.id); assert.equal(operation.operationId, uuid(86));
  f.submissions[1].status = 'FINISHED'; assert.equal((await continueLittleSayRelease(input)).complete, true); assert.equal(retries, 1);
});
