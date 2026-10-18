/** @file Checks read-only cloud import hydration and legacy image bootstrap against live-response fixtures, including false absence, identity drift and conflicting history. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { baselineKey, configuredComponents, runtimeBaselineKey } from '../src/planner.mjs';
import { hydrateBaselines, bootstrapServerBaseline } from '../src/compat/imports.mjs';
import { createGhcrTransport } from '../src/providers/ghcr.mjs';

const commit = 'a'.repeat(40); const source = { repository: 'fixture/app', commit: 'b'.repeat(40) };
const expo = { projectId: '11111111-1111-4111-8111-111111111111', owner: 'fixture', slug: 'app', serverUrl: 'https://fixture.invalid' };
const buildId = '22222222-2222-4222-8222-222222222222'; const hash = 'c'.repeat(64); const fingerprint = 'd'.repeat(40);
function fixture() {
  const config = { schemaVersion: 1, repository: source.repository, defaultBranch: 'main', defaultProfile: 'internal', expo,
    profiles: { internal: { easProfile: 'internal', channel: 'internal', environment: 'preview', distribution: 'internal', submit: false } },
    components: [{ id: 'android', kind: 'native', builder: 'eas', platform: 'android', appDirectory: '.', applicationId: 'app.fixture', runtimePolicy: 'appVersion' }],
    versionGroups: [{ id: 'native', targets: ['android'], codeAllocation: 'independent' }] };
  const original = { schema: 2, commit, profile: 'internal', platform: 'android', channel: 'internal', environment: 'preview',
    release: { version: '1.2.3', androidVersionCode: 7, iosBuildNumber: '6', expoProjectId: expo.projectId, expoOwner: expo.owner, serverUrl: expo.serverUrl },
    runtimeVersion: '1.2.3', fingerprint, compatibility: hash, environmentHash: hash, buildId, artifactUrl: 'https://expired.invalid/original', artifactSha256: hash };
  const build = { id: buildId, app: { id: expo.projectId }, appIdentifier: 'app.fixture', platform: 'ANDROID', gitCommitHash: commit,
    buildProfile: 'internal', appVersion: '1.2.3', appBuildVersion: '7', runtime: { version: '1.2.3' }, updateChannel: { name: 'internal' },
    distribution: 'INTERNAL', isForIosSimulator: false, status: 'FINISHED', fingerprint: { hash: fingerprint }, artifacts: { applicationArchiveUrl: 'https://fresh.invalid/temporary' } };
  const reads = [];
  const api = async route => { reads.push(route); assert.equal(route, `/compare/${commit}...${source.commit}`); return { status: 'ahead', merge_base_commit: { sha: commit } }; };
  api.pages = async () => [];
  const eas = { async getBuild(id) { reads.push(id); assert.equal(id, buildId); return build; },
    async hashArtifact(url) { reads.push(url); assert.equal(url, build.artifacts.applicationArchiveUrl); return hash; } };
  return { args: { config, source, api, policy: { schema: 1, importedBaselines: [original] }, providers: { expo, eas } }, original, build, reads };
}

test('imports verify original EAS identity and current bytes, preserve raw record, and reserve counters without writing history', async () => {
  const { args, original, reads } = fixture(); const result = await hydrateBaselines(args);
  const component = configuredComponents(args.config, 'internal')[0]; const imported = result.components[baselineKey(component, 'internal')];
  assert.equal(imported.origin.kind, 'imported'); assert.equal(imported.origin.buildId, buildId);
  assert.deepEqual(imported.importEvidence.original, original); assert.ok(!JSON.stringify(result).includes('fresh.invalid'));
  assert.equal(result.reservations.native.codes.android, 7); assert.equal(result.reservations.native.version, '1.2.3');
  assert.equal(result.runtimes[runtimeBaselineKey(component, 'internal', '1.2.3')].fingerprint, fingerprint); assert.equal(reads.length, 3);
});

test('cloud import rejects changed provider source, bytes, project, environment, incomplete work and unrelated ancestry', async () => {
  const { args, original, build } = fixture();
  build.gitCommitHash = source.commit; await assert.rejects(hydrateBaselines(args), /source\/platform\/profile/); build.gitCommitHash = commit;
  build.status = 'IN_PROGRESS'; await assert.rejects(hydrateBaselines(args), /finished/); build.status = 'FINISHED';
  await assert.rejects(hydrateBaselines({ ...args, providers: { ...args.providers, eas: { ...args.providers.eas, hashArtifact: async () => 'e'.repeat(64) } } }), /bytes changed/);
  for (const change of [{ environment: 'production' }, { release: { ...original.release, expoProjectId: buildId } }])
    await assert.rejects(hydrateBaselines({ ...args, policy: { schema: 1, importedBaselines: [{ ...original, ...change }] } }), /configured identity/);
  await assert.rejects(hydrateBaselines({ ...args, api: async () => ({ status: 'diverged', merge_base_commit: { sha: 'f'.repeat(40) } }) }), /not an ancestor/);
});

test('existing successful history wins and conflicting same-runtime native proof blocks import', async () => {
  const { args } = fixture(); const initial = await hydrateBaselines(args); const component = configuredComponents(args.config, 'internal')[0];
  const key = baselineKey(component, 'internal'); const newer = { ...initial.components[key], source: source.commit, runtime: '1.2.4', version: '1.2.4', versionCode: 8 };
  const baseline = { ...initial, components: { [key]: newer }, reservations: { native: { version: '1.2.4', codes: { android: 8 } } } };
  const result = await hydrateBaselines({ ...args, baseline }); assert.deepEqual(result.components[key], newer); assert.equal(result.reservations.native.codes.android, 8);
  const runtimeKey = runtimeBaselineKey(component, 'internal', '1.2.3');
  await assert.rejects(hydrateBaselines({ ...args, baseline: { runtimes: { [runtimeKey]: { ...initial.runtimes[runtimeKey], fingerprint: 'changed' } } } }), /conflicts/);
});

function serverFixture() {
  const component = { id: 'server', kind: 'server', image: 'ghcr.io/fixture/app', platforms: ['linux/amd64', 'linux/arm64'] };
  const labels = { 'org.opencontainers.image.source': 'https://github.com/fixture/app', 'org.opencontainers.image.revision': commit, 'org.opencontainers.image.version': '1.2.3' };
  const image = { digest: `sha256:${hash}`, manifests: component.platforms.map(platform => ({ digest: `sha256:${hash}`, platform, labels })) };
  const api = async () => ({ status: 'ahead', merge_base_commit: { sha: commit } });
  api.pages = async route => { assert.equal(route, '/tags'); return [{ name: 'v1.2.3', commit: { sha: commit } }]; };
  return { args: { config: { repository: source.repository }, component, source, api, transport: { inspect: async () => image } }, image, labels };
}

test('server bootstrap requires exact multiarch labels and consistent immutable aliases without inventing input identity', async () => {
  const { args, image, labels } = serverFixture();
  const result = await bootstrapServerBaseline(args); assert.equal(result.requiresSourceIdentity, true); assert.equal(result.identity, undefined);
  assert.equal(result.origin.kind, 'imported'); assert.equal(result.source, commit);
  const inspected = await bootstrapServerBaseline({ ...args, inputIdentity: async () => 'app-specific-source-inputs' }); assert.ok(inspected.identity); assert.equal(inspected.requiresSourceIdentity, undefined);
  labels['org.opencontainers.image.version'] = 'other'; await assert.rejects(bootstrapServerBaseline(args), /labels differ/); labels['org.opencontainers.image.version'] = '1.2.3';
  await assert.rejects(bootstrapServerBaseline({ ...args, transport: { inspect: async reference => ({ ...image, digest: reference.startsWith('sha-') ? `sha256:${'e'.repeat(64)}` : image.digest }) } }), /aliases conflict/);
  await assert.rejects(bootstrapServerBaseline({ ...args, transport: { inspect: async () => ({ ...image, manifests: image.manifests.slice(0, 1) }) } }), /platform inventory/);
});

test('no image or ancestor tag explicitly returns no bootstrap while network/auth failures remain failures', async () => {
  const { args } = serverFixture();
  assert.equal(await bootstrapServerBaseline({ ...args, transport: { inspect: async () => null } }), null);
  assert.equal(await bootstrapServerBaseline({ ...args, api: Object.assign(async () => ({ status: 'diverged' }), { pages: args.api.pages }), transport: { inspect: async () => { throw new Error('must not read'); } } }), null);
  await assert.rejects(bootstrapServerBaseline({ ...args, transport: { inspect: async () => { throw new Error('unauthorized'); } } }), /unauthorized/);
});

test('GHCR identity-only reads expose labels and skip only fully identified attestation manifests', async () => {
  const objects = new Map(); const sha = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const add = value => { const bytes = Buffer.from(JSON.stringify(value)); const digest = sha(bytes); objects.set(digest, bytes); return digest; };
  const config = add({ os: 'linux', architecture: 'amd64', config: { Labels: { source: 'fixture' } } });
  const image = add({ schemaVersion: 2, config: { digest: config }, layers: [] });
  const attestation = add({ schemaVersion: 2, config: { digest: config }, layers: [{ mediaType: 'application/vnd.in-toto+json' }] });
  const descriptor = { digest: attestation, mediaType: 'application/vnd.oci.image.manifest.v1+json', platform: { os: 'unknown', architecture: 'unknown' },
    annotations: { 'vnd.docker.reference.type': 'attestation-manifest', 'vnd.docker.reference.digest': image } };
  const index = { schemaVersion: 2, manifests: [{ digest: image, platform: { os: 'linux', architecture: 'amd64' } }, descriptor] };
  const transport = createGhcrTransport({ image: 'ghcr.io/fixture/app', request: async url => {
    if (String(url).startsWith('https://ghcr.io/token?')) return { ok: true, json: async () => ({ token: 'fixture' }) };
    const reference = String(url).split('/').at(-1); const bytes = reference === 'v1.0.0' ? Buffer.from(JSON.stringify(index)) : objects.get(reference);
    assert.ok(bytes); return { ok: true, status: 200, arrayBuffer: async () => bytes };
  } });
  const result = await transport.inspect('v1.0.0', { includeLabels: true }); assert.equal(result.manifests.length, 1); assert.deepEqual(result.manifests[0].labels, { source: 'fixture' });
  descriptor.annotations['vnd.docker.reference.digest'] = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(transport.inspect('v1.0.0', { includeLabels: true }), /attestation descriptor/);
});
