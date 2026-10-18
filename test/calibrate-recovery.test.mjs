/** @file The held release is a read-only fixture; injected transports exercise recovery without contacting Play, EAS or GitHub. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { calibrateReader } from '../src/compat/calibrate.mjs';
import { continueCalibrateRelease, routeCalibrateRecovery } from '../src/compat/calibrate-recovery.mjs';
import { verifyHistoricalArtifact, isVerifiedSourceProof } from '../src/artifacts.mjs';
import { prepareCalibrateOta, calibrateOtaLedger, exportCalibrateOta } from '../src/compat/calibrate-ota.mjs';
import { publishOta, verifyOtaExports } from '../src/ota.mjs';
import { completeStage } from '../src/stages.mjs';
import { hashIdentity } from '../packages/release-engine/index.mjs';

const fixtures = new URL('./fixtures/calibrate-held/', import.meta.url);
const json = name => JSON.parse(fs.readFileSync(new URL(name, fixtures), 'utf8').replace(/^\uFEFF/, ''));

function fixture() {
  const release = json('release.json'); const record = JSON.parse(release.body); const originalRun = json('run.json');
  const originalBody = release.body; const assets = [...release.assets]; const bytes = new Map();
  const workflow = 'a'.repeat(40);
  const config = { schemaVersion: 1, repository: record.repository, defaultBranch: 'master', defaultProfile: 'production',
    profiles: { production: { channel: 'production', environment: 'production' } },
    github: { handlerWorkflow: 'release-handler.yml' }, expo: { projectId: 'fda8f8c5-e646-47ac-82fb-35003c9cbec7', owner: 'calibrate-health', slug: 'calibrate-health-app' },
    components: [...['phone', 'wear'].map(id => ({ id, kind: 'native', platform: 'android', builder: 'command', runtimePolicy: 'fingerprint', runtimeCompatibility: 'fingerprint',
      applicationId: 'net.darkmachines.healthtracker', submission: { track: id === 'phone' ? 'internal' : 'wear:internal', releaseStatus: 'completed' } })),
    ...['internal', 'production'].map(channel => ({ id: `ota-${channel}`, kind: 'ota', platform: 'android', nativeTarget: 'phone', appDirectory: 'mobile', channel,
      environment: channel === 'internal' ? 'preview' : 'production', runtimeBinding: channel === 'internal' ? 'source' : 'native', approvalEnvironment: channel === 'production' ? 'production' : '' }))],
    legacy: { format: 'calibrate-v1', defaultBranch: 'master', handlerWorkflow: '.github/workflows/cut-release-handler.yml', recoveryWorkflow: '.github/workflows/publish-release-handler.yml' } };
  const app = { expo: { ...config.expo, extra: { eas: { projectId: config.expo.projectId } }, android: { package: 'net.darkmachines.healthtracker' } } };
  const api = async (route, options = {}) => {
    assert.equal(options.method, undefined, 'Fixture cannot mutate release state.');
    if (route === `/actions/runs/${record.run_id}`) return originalRun;
    if (route === '/actions/runs/999') return { repository: { full_name: record.repository }, head_branch: 'master', head_sha: workflow,
      path: '.github/workflows/release-handler.yml', event: 'workflow_run', run_attempt: 1 };
    if (route.startsWith('/contents/mobile/app.json?ref=')) return { type: 'file', encoding: 'base64', size: 500, content: Buffer.from(JSON.stringify(app)).toString('base64') };
    const asset = assets.find(value => route === `/releases/assets/${value.id}`);
    assert.ok(asset, `Unexpected read ${route}`);
    return bytes.get(asset.id) ?? fs.readFileSync(new URL(asset.name, fixtures));
  };
  const ledger = { config, api, origin: { kind: 'github', runId: '999', runAttempt: 1 }, workflowCommit: workflow,
    read: async () => calibrateReader.read({ release, record, assets, api, config }),
    async upload(_id, name, data) {
      const asset = { id: Math.max(...assets.map(value => value.id)) + 1, name, size: data.length, uploader: { login: 'github-actions[bot]' } };
      assets.push(asset); bytes.set(asset.id, data); return asset;
    } };
  const digest = createHash('sha256').update('inert signed fixture').digest('hex');
  const restore = async ({ state, target, directory }) => {
    const files = path.join(directory, 'files'); fs.mkdirSync(files); const file = path.join(files, 'app.aab'); fs.writeFileSync(file, 'inert signed fixture');
    const origin = { kind: 'github', runId: record.run_id, runAttempt: 1 };
    const sourceProof = await verifyHistoricalArtifact({ repository: record.repository, source: state.origin.sourceCommit, target, origin,
      original: state.nativeMetadata, directory: files, verifyOriginal: async () => [{ path: 'app.aab', sha256: digest }] });
    assert.ok(isVerifiedSourceProof(sourceProof)); assert.equal(isVerifiedSourceProof(structuredClone(sourceProof)), false);
    return { file, sha256: digest, sourceProof, origin, metadata: state.nativeMetadata, component: config.components.find(value => value.id === target) };
  };
  const originalId = '602c0864-a253-4133-ac26-6f8a2f4de11e';
  const nextId = '00000000-0000-4000-8000-000000000001';
  const original = { id: originalId, status: 'ERRORED', platform: 'ANDROID', app: { id: config.expo.projectId },
    androidConfig: { track: 'qa', releaseStatus: 'COMPLETED' }, archiveUrl: 'https://fixture.invalid/original' };
  const accepted = { ...original, id: nextId, status: 'IN_QUEUE', androidConfig: { track: 'internal', releaseStatus: 'COMPLETED' } };
  const calls = []; const transport = {
    async getSubmission(id) { assert.ok([originalId, nextId].includes(id)); return id === originalId ? original : accepted; },
    async hashArtifact() { return digest; }, async hashFile() { return digest; },
    async cli(args) { calls.push(args); return `https://expo.dev/accounts/${config.expo.owner}/projects/${config.expo.slug}/submissions/${nextId}`; }
  };
  const correction = { confirmed: true, stage: 'phone-submit', destination: { confirmed: true, reason: 'Operator verified the rejected track never committed this bundle.',
    operationId: originalId, artifactSha256: digest, from: 'qa', to: 'internal' } };
  return { ledger, restore, transport, original, accepted, calls, correction, assets, bytes, record, release, originalBody, config };
}

test('corrected held submission preserves original ID, 17/18 reservation and independent server success', async () => {
  const value = fixture(); const args = { ledger: value.ledger, releaseId: value.release.id, restore: value.restore, transport: value.transport, environment: {} };
  await assert.rejects(continueCalibrateRelease({ ...args, request: { action: 'resume', stage: 'wear-submit' } }), /dependencies/);
  const reconciled = await continueCalibrateRelease({ ...args, request: { action: 'reconcile', reconciliation: value.correction } });
  assert.equal(reconciled.nextAction, 'retry'); assert.equal(value.calls.length, 0);
  const queued = await continueCalibrateRelease({ ...args, request: { action: 'retry', stage: 'phone-submit' } });
  assert.equal(queued.operation.status, 'accepted'); assert.equal(value.calls.length, 1);
  assert.equal(queued.operation.history[0].operationId, value.original.id);
  assert.equal(value.calls[0][0], 'submit'); assert.ok(value.calls[0].includes('--path'));
  let state = await value.ledger.read();
  assert.deepEqual(state.summary.completedComponents, ['server']); assert.ok(!state.summary.remaining.includes('phone-handoff'));
  assert.equal(state.baseline.reservations.native.codes.phone, 17); assert.equal(state.baseline.reservations.native.codes.wear, 18);
  assert.equal(state.nativeMetadata.source_commit, '3dfb97c064c55cb55b514415618220f03dce91f1');
  value.accepted.status = 'FINISHED';
  const completed = await continueCalibrateRelease({ ...args, request: { action: 'resume', stage: 'phone-submit' } });
  assert.equal(completed.operation.status, 'complete'); assert.equal(value.calls.length, 1);
  state = await value.ledger.read(); assert.ok(!state.summary.remaining.includes('phone-submit'));
  assert.deepEqual(state.record, value.record); assert.equal(value.release.body, value.originalBody);
});

test('changed bytes or destination cannot authorize a correction; recovered transitions cannot replace the original ID', async () => {
  const value = fixture(); const args = { ledger: value.ledger, releaseId: value.release.id, restore: value.restore, transport: value.transport, environment: {} };
  value.transport.hashArtifact = async () => 'f'.repeat(64);
  await assert.rejects(continueCalibrateRelease({ ...args, request: { action: 'reconcile', reconciliation: value.correction } }), /exact retained bytes/);
  assert.equal(value.calls.length, 0); assert.equal(value.bytes.size, 0);
  value.transport.hashArtifact = async () => value.correction.destination.artifactSha256;
  await continueCalibrateRelease({ ...args, request: { action: 'reconcile', reconciliation: value.correction } });
  const asset = value.assets.at(-1); const event = JSON.parse(value.bytes.get(asset.id));
  event.event.operation.operationId = '00000000-0000-4000-8000-000000000099';
  value.bytes.set(asset.id, Buffer.from(JSON.stringify(event)));
  await assert.rejects(value.ledger.read(), /transition differs/);
});

test('historical routing is explicit and cannot silently complete missing original export evidence', async () => {
  const value = fixture(); const state = await value.ledger.read();
  assert.throws(() => routeCalibrateRecovery(state, { action: 'resume' }, value.config), /explicit/);
  assert.equal(routeCalibrateRecovery(state, { action: 'resume', stage: 'ota-production' }, value.config).approval, 'production');
  await assert.rejects(prepareCalibrateOta({ ledger: value.ledger, state, target: 'ota-production', toolkitCommit: 'b'.repeat(40) }), /dependencies/);
});

test('held OTA uses original application/native runtime and appends independent publication evidence in the same ledger', async t => {
  const value = fixture(); const root = fs.mkdtempSync(path.join(os.tmpdir(), 'held-ota-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const args = { ledger: value.ledger, releaseId: value.release.id, restore: value.restore, transport: value.transport, environment: {} };
  await continueCalibrateRelease({ ...args, request: { action: 'reconcile', reconciliation: value.correction } });
  await continueCalibrateRelease({ ...args, request: { action: 'retry', stage: 'phone-submit' } });
  let verified = 0;
  const prepare = async target => prepareCalibrateOta({ ledger: value.ledger, state: await value.ledger.read(), target, toolkitCommit: 'b'.repeat(40),
    verifyNative: async ({ state }) => { verified++; return state.nativeMetadata; } });
  const plan = await prepare('ota-internal');
  assert.equal((await prepare('ota-internal')).digest, plan.digest); assert.equal(verified, 1);
  assert.equal(plan.source.commit, '3dfb97c064c55cb55b514415618220f03dce91f1');
  assert.equal(plan.source.workflowCommit, 'a'.repeat(40));
  assert.equal(plan.components.find(value => value.id === 'phone').observation.runtime, '8b61a231da5765e424ce6cb65087944ddbd80d04');
  const inspect = runtime => () => ({ runtime, expoConfig: { android: { package: 'net.darkmachines.healthtracker' }, extra: { eas: { projectId: value.config.expo.projectId } } },
    resolution: { fingerprintSources: [{ id: 'expoAutolinkingConfig:android', contents: JSON.stringify({ modules: [{ packageName: 'expo-updates' }, { packageName: '@calibrate/wear-pairing' }] }) },
      { id: 'rncoreAutolinkingConfig:android', contents: JSON.stringify({ 'react-native-health-connect': {} }) }] } });
  const exportSource = ({ outputDirectory }) => {
    fs.writeFileSync(path.join(outputDirectory, 'main.js'), 'fixture bundle');
    fs.writeFileSync(path.join(outputDirectory, 'metadata.json'), JSON.stringify({ fileMetadata: { android: { bundle: 'main.js', assets: [] } } }));
  };
  const inputs = { expo: value.config.expo, hash: 'e'.repeat(64), environment: {}, branch: { id: 'branch', name: 'internal' } };
  const component = plan.components.find(value => value.id === 'ota-internal');
  const common = calibrateOtaLedger(value.ledger, component.id);
  const built = await exportCalibrateOta({ plan, component, root, inputs, directory: root, inspect: inspect('c'.repeat(40)), exportSource,
    git: (_root, argv) => argv[0] === 'rev-parse' ? plan.source.commit : '' });
  assert.equal(built.bindings[0].origin, 'source-validated'); assert.equal(built.bindings[0].runtime, 'c'.repeat(40));
  await verifyOtaExports({ plan, component, directory: root, metadata: built });
  await completeStage({ ledger: common, releaseId: value.release.id, target: component.id, action: 'export', receipt: { artifact: 'fixture' } });
  let starts = 0;
  const publication = { ledger: common, releaseId: value.release.id, plan, component, artifact: { directory: root, receipt: { metadata: built, manifest: { digest: hashIdentity('fixture') } } },
    stageFactory: async () => ({ provider: { start: async () => { starts++; return { id: 'fixture-group' }; },
      status: async id => ({ id, status: 'complete' }), verify: async value => ({ group: value.id, runtime: built.bindings[0].runtime }) } }) };
  await publishOta(publication); await publishOta(publication); assert.equal(starts, 1);
  const current = await value.ledger.read(); assert(current.summary.completedComponents.includes('ota-internal'));
  assert(current.summary.completedComponents.includes('server')); assert(current.summary.remaining.includes('wear-submit'));
  assert.equal(current.baseline.reservations.native.codes.phone, 17); assert.equal(value.release.body, value.originalBody);
  const production = await prepare('ota-production');
  await assert.rejects(exportCalibrateOta({ plan: production, component: production.components.find(value => value.id === 'ota-production'), root, inputs,
    directory: root, inspect: inspect('c'.repeat(40)), exportSource, git: (_root, argv) => argv[0] === 'rev-parse' ? plan.source.commit : '' }), /fingerprint\/environment differs/);
  const exact = await exportCalibrateOta({ plan: production, component: production.components.find(value => value.id === 'ota-production'), root, inputs,
    directory: root, inspect: inspect('8b61a231da5765e424ce6cb65087944ddbd80d04'), exportSource,
    git: (_root, argv) => argv[0] === 'rev-parse' ? plan.source.commit : '' });
  assert.equal(exact.bindings[0].origin, 'retained-native');
  const original = value.assets.at(-1); value.assets.splice(value.assets.length - 2, 1);
  await assert.rejects(value.ledger.read(), /evidence chain/); assert(original);
});
