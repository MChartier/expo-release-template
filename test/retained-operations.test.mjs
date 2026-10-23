/** @file Verifies standalone retained planning, original artifact provenance, atomic Play cohorts, protected routing and lost-response recovery without live providers. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { buildReleaseGraph, createPlan, hashIdentity } from '../packages/release-engine/index.mjs';
import { createArtifactReceipt, verifyRetainedArtifact } from '../src/artifacts.mjs';
import { completedBaseline } from '../src/planner.mjs';
import { validateConfig } from '../src/config.mjs';
import { createPlayCohortPromotionProvider } from '../src/providers/play-cohort.mjs';
import { retainedOperationRequest, prepareRetainedOperation, routeRetainedOperation, executeRetainedOperation, retainedOperationProvider, restoreRetainedOperationArtifact, resolvePromotionToken } from '../src/retained-operations.mjs';
import { main } from '../src/cli.mjs';
import { validateRequest } from '../src/trusted.mjs';

const sha = value => value.repeat(40);
const digest = value => createHash('sha256').update(value).digest('hex');
const projectId = '00000000-0000-4000-8000-000000000001';

test('CLI retained planning is read-only and run dispatches only the exact sealed operation request', async t => {
  const f = await fixture(t); const root = path.join(f.directory, 'cli'); fs.mkdirSync(root);
  const write = (name, value) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  const config = { ...f.config, github: { requestWorkflow: 'release-request.yml', handlerWorkflow: 'release-handler.yml', recoveryWorkflow: 'recover-release.yml' } };
  write('release.config.json', config);
  const dependency = `git+https://github.com/MChartier/expo-release-template.git#${sha('c')}`;
  write('package.json', { devDependencies: { '@mchartier/expo-release': dependency } });
  write('package-lock.json', { packages: { 'node_modules/@mchartier/expo-release': { resolved: dependency } } });
  write('.github/workflows/release-handler.yml', `# Fixture shared handler.\njobs:\n  release:\n    uses: MChartier/expo-release-template/.github/workflows/release-handler.yml@${sha('c')}\n`);
  const mutations = []; const output = [];
  const api = async (route, options = {}) => {
    if (options.method) { assert.equal(route, '/actions/workflows/release-request.yml/dispatches'); mutations.push(options); return {}; }
    assert.equal(route, '/releases/41'); return { ...f.original.release, body: '{}' };
  };
  api.pages = async route => { assert.equal(route, '/releases/41/assets'); return f.original.assets; };
  const options = { root, api, environment: {}, ledger: { read: async () => f.original }, output: value => output.push(value) };
  await main(['plan', '--operation', 'promote', '--release-id', '41', '--promotion', 'closed'], options);
  const request = output[0].plan;
  assert.equal(request.kind, 'expo-release-operation'); assert.equal(request.promotion, 'closed');
  assert.equal(mutations.length, 0); assert.equal(f.restores(), 0); assert.equal(f.play.commits(), 0);
  await main(['run'], options);
  assert.equal(mutations.length, 1); assert.equal(mutations[0].method, 'POST'); assert.equal(mutations[0].body.ref, 'main');
  const dispatched = JSON.parse(mutations[0].body.inputs.request);
  assert.deepEqual(validateRequest(dispatched), { schemaVersion: 1, action: 'operation', retained: request });
  assert.deepEqual(prepareRetainedOperation({ state: f.original, request: dispatched.retained, config,
    source: { repository: config.repository, commit: sha('e'), workflowCommit: sha('e'), toolkitCommit: sha('c') },
    origin: { kind: 'github', runId: '20', runAttempt: 1 } }).retainedOperation, request);
  write('.release/plan.json', { ...request, targets: ['phone'] });
  await assert.rejects(main(['run'], options), /full configured promotion cohort/);
  assert.equal(mutations.length, 1); assert.equal(f.play.commits(), 0);
});

async function fixture(t, { submitted = true, separateApps = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'retained-operation-test-'));
  t.after(() => { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); fs.rmSync(directory, { recursive: true, force: true }); });
  const config = { schemaVersion: 1, repository: 'fixture/app', defaultBranch: 'main', defaultProfile: 'production',
    profiles: { production: { distribution: 'store', channel: 'production', environment: 'production' } },
    components: ['phone', 'wear'].map((id, index) => ({ id, kind: 'native', platform: 'android', builder: 'command', profile: 'production',
      applicationId: separateApps ? `fixture.${id}` : 'fixture.app', runtimePolicy: 'fingerprint',
      approvalEnvironment: 'native-submit', ...(index ? { after: ['phone'] } : {}) })),
    promotions: { closed: { targets: ['phone', 'wear'], tracks: { phone: { source: 'internal', destination: 'closed' }, wear: { source: 'wear:internal', destination: 'wear:closed' } },
      approvalEnvironment: 'play-internal', credentials: { accessToken: 'GOOGLE_PLAY_INTERNAL_ACCESS_TOKEN', serviceAccountBase64: 'GOOGLE_PLAY_INTERNAL_SERVICE_ACCOUNT_JSON_BASE64' } } } };
  validateConfig(config);
  const source = { repository: config.repository, commit: sha('a'), workflowCommit: sha('b'), toolkitCommit: sha('c') };
  const origin = { kind: 'github', runId: '10', runAttempt: 1 };
  const components = config.components.map((value, index) => ({ ...config.profiles.production, ...value, selected: true, key: `${value.id}|production`,
    identity: `${value.id}-input`, observation: { id: value.id, version: '2.0.0', versionCode: 17 + index, runtime: sha('d'), fingerprint: sha('d'), environmentHash: hashIdentity([]) } }));
  const specs = {}; const stages = [];
  for (const component of components) {
    specs[`${component.id}:build`] = { target: component.id, action: 'build' };
    stages.push({ id: `${component.id}:build`, component: component.id, needs: [] });
    if (submitted) { specs[`${component.id}:submit`] = { target: component.id, action: 'submit' };
      stages.push({ id: `${component.id}:submit`, component: component.id, needs: [`${component.id}:build`] }); }
  }
  const expo = { projectId, owner: 'fixture', slug: 'fixture-app' };
  const destinations = { phone: { track: 'internal', releaseStatus: 'completed' }, wear: { track: 'wear:internal', releaseStatus: 'completed' } };
  const plan = createPlan({ runId: '10', source, origin, config, components, prepared: true, profile: 'production', operation: submitted ? 'release' : 'build',
    graph: buildReleaseGraph(stages), stages: specs, selection: { selected: ['phone', 'wear'], noop: false },
    reservations: {}, baseline: { components: {}, runtimes: {}, reservations: {} }, providerConfiguration: { expo, destinations } });
  const original = { release: { id: 41, draft: false }, plan, events: stages.map(value => ({ stage: value.id, status: 'complete', receipt: { original: true } })), assets: [] };
  original.events.push({ type: 'completion', completion: { status: 'complete' } });
  const artifacts = new Map(); let restores = 0;
  for (const component of components) {
    const folder = path.join(directory, component.id); fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'application.aab'), `${component.id} exact retained bytes`);
    const receipt = await createArtifactReceipt({ plan, target: component.id, directory: folder, metadata: { kind: 'native', expo,
      expoConfig: { name: 'Fixture', slug: expo.slug, owner: expo.owner }, destination: destinations[component.id],
      runtime: component.observation.runtime, version: component.observation.version, versionCode: component.observation.versionCode,
      environmentHash: component.observation.environmentHash } });
    const file = receipt.manifest.files[0]; const id = original.assets.length + 1;
    const files = [{ ...file, name: `blob-${file.sha256}`, assetId: id }];
    const event = { type: 'artifact', target: component.id, receipt, files, receiptAsset: { id: id + 100, name: `${component.id}.json`, sha256: digest(JSON.stringify(receipt)) } };
    original.events.push(event); original.assets.push({ id, name: files[0].name, size: file.size });
    artifacts.set(component.id, { directory: folder, receipt });
  }
  const request = (operation = 'promote', options = {}) => retainedOperationRequest({ state: original, config, operation,
    ...(operation === 'promote' ? { promotion: 'closed' } : {}), ...options });
  const prepare = value => prepareRetainedOperation({ state: original, request: value, config,
    source: { repository: config.repository, commit: sha('f'), workflowCommit: sha('e'), toolkitCommit: sha('f') },
    origin: { kind: 'github', runId: '20', runAttempt: 1 } });
  const states = new Map([[41, original]]);
  const ledger = { config, api: () => { throw new Error('Unexpected source/provider API call.'); },
    read: async id => { assert(states.has(Number(id))); return states.get(Number(id)); },
    append: async (id, event) => { states.get(Number(id)).events.push(structuredClone(event)); } };
  const install = plan => { states.set(42, { release: { id: 42, draft: true }, plan, events: [], assets: [] }); return states.get(42); };
  const restore = async ({ state, target }) => {
    restores++; assert.equal(state.plan.digest, original.plan.digest);
    const artifact = artifacts.get(target); const sourceProof = await verifyRetainedArtifact({ ...artifact, plan: original.plan, target,
      verifyProducer: async receipt => receipt.origin.runId === '10', verifyAttestation: async () => true });
    return { ...artifact, sourceProof };
  };
  const play = makePlay(components, artifacts);
  const execute = (options = {}) => executeRetainedOperation({ ledger, releaseId: 42, stage: 'phone:promote', directory: path.join(directory, 'restored'),
    environment: { GOOGLE_PLAY_INTERNAL_ACCESS_TOKEN: 'fixture-stage-token' }, restore,
    publisherFactory: ({ applicationId, accessToken }) => { assert.equal(applicationId, components[0].applicationId); assert.equal(accessToken, 'fixture-stage-token'); return play.publisher; },
    ...options });
  return { directory, original, config, components, request, prepare, ledger, install, states, artifacts, restore, execute, play, restores: () => restores };
}

function makePlay(components, artifacts) {
  const remote = new Map(); const edits = new Map(); let counter = 0; let commits = 0; let updates = 0; let mode = '';
  const bundles = { bundles: components.map(value => ({ versionCode: value.observation.versionCode, sha256: artifacts.get(value.id).receipt.manifest.files[0].sha256 })) };
  for (const component of components) remote.set(component.id === 'phone' ? 'internal' : 'wear:internal', { releases: [{ name: 'EAS provider release name',
    versionCodes: [String(component.observation.versionCode)], status: 'completed' }] });
  const publisher = {
    async createEdit() { const id = String(++counter); edits.set(id, structuredClone(remote)); return id; },
    async deleteEdit(id) { edits.delete(id); },
    async getTrack(id, track) { return structuredClone(edits.get(id).get(track) || { releases: [] }); },
    async listBundles() { return structuredClone(bundles); },
    async updateTrack(id, track, release) { updates++; if (mode === 'second-update' && updates === 2) throw Error('second target failed'); edits.get(id).set(track, { releases: [release] }); },
    async commitEdit(id) { commits++; for (const [track, value] of edits.get(id)) remote.set(track, value); edits.delete(id); if (mode === 'lost-response') throw Error('lost commit response'); },
  };
  return { publisher, remote, bundles, edits, mode: value => { mode = value; }, commits: () => commits, updates: () => updates };
}

test('retained planning is read-only and creates fresh hosted authority while preserving original artifacts/source', async t => {
  const f = await fixture(t); const before = structuredClone(f.original); const request = f.request(); const plan = f.prepare(request);
  assert.deepEqual(f.original, before); assert.equal(f.restores(), 0); assert.equal(plan.source.commit, f.original.plan.source.commit);
  assert.equal(plan.source.workflowCommit, sha('e')); assert.equal(plan.origin.runId, '20'); assert.equal(plan.retainedOperation.original.origin.runId, '10');
  assert.equal(plan.retainedOperation.planDigest, f.original.plan.digest); assert.deepEqual(plan.reservations, {});
  assert.deepEqual(plan.graph.stages.map(value => value.id), ['phone:promote']);
  assert.deepEqual(plan.stages['phone:promote'].targets, ['phone', 'wear']);
  assert.deepEqual(routeRetainedOperation(plan, 'phone:promote'), { stage: 'phone:promote', provider: 'play', approval: 'play-internal', credentials: f.config.promotions.closed.credentials });
  assert.deepEqual(completedBaseline(plan, [{ stage: 'phone:promote', status: 'complete' }]), { components: {}, runtimes: {}, reservations: {} });
});

test('planning rejects partial cohorts, unfinished/local history, missing submissions and changed retained evidence', async t => {
  const f = await fixture(t); assert.throws(() => f.request('promote', { targets: ['phone'] }), /full configured/);
  f.original.release.draft = true; assert.throws(() => f.request(), /Resolve/); f.original.release.draft = false;
  f.original.local = true; assert.throws(() => f.request(), /Local evidence/); delete f.original.local;
  const submission = f.original.events.find(value => value.stage === 'wear:submit'); submission.status = 'accepted';
  assert.throws(() => f.request(), /submissions must complete/); submission.status = 'complete';
  const request = f.request(); f.original.events.find(value => value.type === 'artifact').files[0].sha256 = 'f'.repeat(64);
  assert.throws(() => f.prepare(request), /changed since planning/);
});

test('one same-app promotion commits both tracks atomically and completed resume does not issue another edit', async t => {
  const f = await fixture(t); const state = f.install(f.prepare(f.request()));
  assert.equal((await f.execute()).complete, true); assert.equal(f.play.commits(), 1); assert.equal(f.play.updates(), 2);
  assert.equal(state.events[0].operation.status, 'intent'); assert.equal(state.events.at(-1).operation.status, 'complete');
  const count = f.restores(); await f.execute(); assert.equal(f.restores(), count); assert.equal(f.play.commits(), 1);
  assert.equal(f.play.remote.get('closed').releases[0].versionCodes[0], '17');
  assert.equal(f.play.remote.get('wear:closed').releases[0].versionCodes[0], '18');
  assert.deepEqual(state.events.at(-1).operation.receipt.targets.map(value => value.originalOrigin.runId), ['10', '10']);
});

test('a lost successful Play commit response reconciles both exact destinations without reupload or recommit', async t => {
  const f = await fixture(t); const state = f.install(f.prepare(f.request())); f.play.mode('lost-response');
  await assert.rejects(f.execute(), /lost commit/); assert.equal(f.play.commits(), 1); assert.equal(state.events.at(-1).operation.status, 'unknown');
  assert.equal((await f.execute()).complete, true); assert.equal(f.play.commits(), 1); assert.equal(f.play.updates(), 2);
});

test('a failed staged pair leaves live tracks unchanged and an empty search never authorizes a new promotion', async t => {
  const f = await fixture(t); f.install(f.prepare(f.request())); f.play.mode('second-update');
  await assert.rejects(f.execute(), /second target/); assert.equal(f.play.commits(), 0); assert.equal(f.play.remote.has('closed'), false);
  await assert.rejects(f.execute(), /ambiguous outcome/); assert.equal(f.play.commits(), 0); assert.equal(f.play.updates(), 2);
});

test('changed bytes, pending Console changes and newer destination versions fail before promotion', async t => {
  const f = await fixture(t); f.install(f.prepare(f.request()));
  fs.appendFileSync(path.join(f.artifacts.get('phone').directory, 'application.aab'), 'tamper');
  await assert.rejects(f.execute(), /Artifact/); assert.equal(f.play.commits(), 0);
  for (const release of [{ name: 'pending', status: 'draft', versionCodes: ['1'] }, { name: 'newer', status: 'completed', versionCodes: ['90'] }]) {
    const other = await fixture(t); other.install(other.prepare(other.request())); other.play.remote.set('closed', { releases: [release] });
    await assert.rejects(other.execute(), /pending Console|downgrade/); assert.equal(other.play.commits(), 0); assert.equal(other.play.updates(), 0);
  }
});

test('independent applications route separate transactions and invalid cohort declarations fail validation', async t => {
  const f = await fixture(t, { separateApps: true }); const plan = f.prepare(f.request());
  assert.deepEqual(plan.graph.stages.map(value => value.id), ['phone:promote', 'wear:promote']);
  assert.notEqual(plan.stages['phone:promote'].applicationId, plan.stages['wear:promote'].applicationId);
  for (const mutation of [config => { config.promotions.closed.targets.push('phone'); }, config => { config.promotions.closed.credentials.accessToken = 'EXPO_TOKEN'; },
    config => { config.promotions.closed.tracks.phone.destination = 'internal'; }, config => { config.components[0].platform = 'ios'; }]) {
    const config = structuredClone(f.config); mutation(config); assert.throws(() => validateConfig(config));
  }
});

test('stage credentials never fall back to unrelated environment secrets and temporary service-account files are removed', async () => {
  const credentials = { accessToken: 'GOOGLE_PLAY_INTERNAL_ACCESS_TOKEN', serviceAccountBase64: 'GOOGLE_PLAY_INTERNAL_SERVICE_ACCOUNT_JSON_BASE64' };
  await assert.rejects(resolvePromotionToken(credentials, { GOOGLE_PLAY_ACCESS_TOKEN: 'wrong', GOOGLE_PLAY_PRODUCTION_ACCESS_TOKEN: 'other-stage' }), /no credentials/);
  assert.equal(await resolvePromotionToken(credentials, { GOOGLE_PLAY_INTERNAL_ACCESS_TOKEN: 'right' }), 'right');
  let file;
  const result = await resolvePromotionToken(credentials, { GOOGLE_PLAY_INTERNAL_SERVICE_ACCOUNT_JSON_BASE64: Buffer.from(JSON.stringify({ client_email: 'fixture@example.invalid' })).toString('base64') }, async options => {
    file = options.serviceAccountFile; assert.deepEqual(options.environment, {}); assert.equal(JSON.parse(fs.readFileSync(file)).client_email, 'fixture@example.invalid'); return 'scoped';
  });
  assert.equal(result, 'scoped'); assert.equal(fs.existsSync(file), false);
});

test('standalone submission restores the original producer proof and records the new operation independently', async t => {
  const f = await fixture(t, { submitted: false }); const state = f.install(f.prepare(f.request('submit', { targets: ['phone'] })));
  assert.equal(routeRetainedOperation(state.plan, 'phone:submit').approval, 'native-submit');
  const id = '00000000-0000-4000-8000-000000000080'; const fileHash = f.artifacts.get('phone').receipt.manifest.files[0].sha256; let submissions = 0;
  const easTransport = { cli: async args => { assert.equal(args[0], 'submit'); assert(args.includes('--path')); submissions++;
      return `https://expo.dev/accounts/fixture/projects/fixture-app/submissions/${id}`; },
    getSubmission: async () => ({ id, app: { id: projectId }, platform: 'ANDROID', status: 'FINISHED', archiveUrl: 'https://fixture.invalid/archive',
      androidConfig: { track: 'internal', releaseStatus: 'COMPLETED' } }), hashFile: async file => digest(fs.readFileSync(file)), hashArtifact: async () => fileHash };
  assert.equal((await f.execute({ stage: 'phone:submit', easTransport })).complete, true); assert.equal(submissions, 1);
  assert.equal(state.events[0].operation.request.planDigest, state.plan.digest);
  assert.equal(state.events.at(-1).operation.receipt.artifact.origin.runId, '10');
  assert.equal(f.original.events.some(value => value.stage === 'phone:submit'), false);
});

test('a deserialized artifact proof cannot authorize Play promotion', async t => {
  const f = await fixture(t); const artifact = await f.restore({ state: f.original, target: 'phone' });
  assert.throws(() => createPlayCohortPromotionProvider({ applicationId: 'fixture.app', source: f.original.plan.source.commit, repository: f.config.repository,
    targets: [{ target: 'phone', applicationId: 'fixture.app', sourceTrack: 'internal', destination: 'closed', versionCode: 17,
      sha256: artifact.receipt.manifest.files[0].sha256, sourceProof: JSON.parse(JSON.stringify(artifact.sourceProof)), marker: 'fixture' }] }, f.play.publisher), /independently verified/);
});

async function serverFixture(t) {
  const f = await fixture(t); delete f.config.promotions;
  const server = { id: 'server', kind: 'server', image: 'ghcr.io/fixture/app', version: { file: 'release.json', pointer: '/version' },
    publication: { gitTagPrefix: 'v', movingTag: 'latest' }, approvalEnvironment: 'server-publish' };
  f.config.components = [server];
  f.config.deployment = { type: 'wireguard-webhook', service: 'fixture', path: '/deploy/fixture', environment: 'homelab' };
  const { source, origin } = f.original.plan;
  const component = { ...server, selected: true, key: 'server||||', identity: 'server-input', observation: { id: 'server', version: '2.0.0' } };
  const stages = Object.fromEntries(['build', 'publish', 'finalize', 'deploy'].map(action => [`server:${action}`, { target: 'server', action }]));
  f.original.plan = createPlan({ runId: '10', source, origin, config: f.config, prepared: true, operation: 'release', profile: 'production', components: [component],
    stages, graph: buildReleaseGraph(Object.keys(stages).map(id => ({ id, component: 'server', needs: [] }))), selection: { selected: ['server'], noop: false },
    reservations: {}, baseline: { components: {}, runtimes: {}, reservations: {} }, providerConfiguration: {} });
  const folder = path.join(f.directory, 'server'); fs.mkdirSync(folder); fs.writeFileSync(path.join(folder, 'image.oci.tar'), 'original OCI archive');
  const oci = { digest: `sha256:${'a'.repeat(64)}`, manifests: [{ platform: 'linux/amd64', digest: `sha256:${'b'.repeat(64)}` }, { platform: 'linux/arm64', digest: `sha256:${'c'.repeat(64)}` }] };
  const receipt = await createArtifactReceipt({ plan: f.original.plan, target: 'server', directory: folder, metadata: { kind: 'server', oci, version: '2.0.0' } });
  const file = receipt.manifest.files[0]; const files = [{ ...file, name: `blob-${file.sha256}`, assetId: 1 }];
  f.original.events = [...Object.keys(stages).map(stage => ({ stage, status: 'complete', receipt: { original: true } })),
    { type: 'completion', completion: { status: 'complete' } }, { type: 'artifact', target: 'server', receipt, files,
      receiptAsset: { id: 101, name: 'server.json', sha256: digest(JSON.stringify(receipt)) } }];
  f.original.assets = [{ id: 1, name: files[0].name, size: file.size }]; f.artifacts.set('server', { receipt, directory: folder });
  let version = '2.0.0'; let latest = null; let publications = 0;
  f.ledger.api = async route => {
    if (route === '/branches/main') return { protected: true, commit: { sha: sha('e') } };
    if (route === `/compare/${source.commit}...${sha('e')}`) return { status: 'ahead', merge_base_commit: { sha: source.commit } };
    if (route === '/git/ref/tags/v2.0.0') return { object: { type: 'commit', sha: source.commit } };
    if (route === `/contents/release.json?ref=${sha('e')}`) { const bytes = Buffer.from(JSON.stringify({ version })); return { type: 'file', encoding: 'base64', size: bytes.length, content: bytes.toString('base64') }; }
    throw Error(`Unexpected protected metadata read: ${route}`);
  };
  const registry = { inspect: async reference => reference === 'latest' ? latest : structuredClone(oci),
    publish: async (file, aliases) => { assert.equal(fs.readFileSync(file, 'utf8'), 'original OCI archive'); assert.deepEqual(aliases, ['latest']); latest = structuredClone(oci); publications++; } };
  return { ...f, registry, publications: () => publications, version: value => { version = value; } };
}

test('standalone image promotion restores original bytes and keeps a newer protected version from moving latest backwards', async t => {
  const f = await serverFixture(t); const request = f.request('promote', { promotion: undefined, targets: ['server'] });
  const plan = f.prepare(request); f.install(plan);
  assert.equal(routeRetainedOperation(plan, 'server:finalize').approval, 'server-publish');
  assert.equal((await f.execute({ stage: 'server:finalize', registry: f.registry })).complete, true); assert.equal(f.publications(), 1);
  const other = await serverFixture(t); other.install(other.prepare(other.request('promote', { promotion: undefined, targets: ['server'] })));
  other.version('9.0.0'); assert.equal((await other.execute({ stage: 'server:finalize', registry: other.registry })).complete, true); assert.equal(other.publications(), 0);
  assert.equal(other.states.get(42).events.at(-1).receipt.moving.status, 'superseded');
});

test('standalone deployment uses only deployment transport, preserves health-only evidence and blocks replay after timeout', async t => {
  const f = await serverFixture(t); const plan = f.prepare(f.request('deploy', { targets: ['server'] })); f.install(plan);
  assert.equal(routeRetainedOperation(plan, 'server:deploy').approval, 'homelab'); let calls = 0;
  const deploy = () => { calls++; return { service: 'fixture', healthy: true, evidence: 'webhook-health-response' }; };
  assert.equal((await f.execute({ stage: 'server:deploy', deploy })).complete, true); assert.equal(calls, 1); assert.equal(f.restores(), 0);
  await f.execute({ stage: 'server:deploy', deploy }); assert.equal(calls, 1);
  const other = await serverFixture(t); other.install(other.prepare(other.request('deploy', { targets: ['server'] })));
  const fail = () => { calls++; throw Error('lost webhook response'); };
  await assert.rejects(other.execute({ stage: 'server:deploy', deploy: fail }), /lost webhook/);
  await assert.rejects(other.execute({ stage: 'server:deploy', deploy: fail }), /No unique provider result/); assert.equal(calls, 2);
});

test('retained reconciliation composes only an observer and reads original artifacts instead of a new producer inventory', async t => {
  const f = await fixture(t); const state = f.install(f.prepare(f.request()));
  const composed = await retainedOperationProvider({ ledger: f.ledger, state, stage: 'phone:promote', directory: f.directory, restore: f.restore,
    environment: { GOOGLE_PLAY_INTERNAL_ACCESS_TOKEN: 'fixture-stage-token' }, publisherFactory: () => f.play.publisher });
  try { assert.equal(f.play.commits(), 0); const observed = await composed.provider.find(); assert.equal(observed.status, 'unknown');
    assert.equal((await composed.provider.verify(observed)).status, 'unknown'); assert.equal(f.play.updates(), 0); assert.equal(state.events.length, 0); }
  finally { composed.dispose(); }
});
