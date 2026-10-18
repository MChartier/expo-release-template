/** @file Exercises original retained OTA absence/retry and terminal journal validation through offline held-release-derived fixtures. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReleaseGraph, createPlan, hashIdentity, reduceOperation } from '../packages/release-engine/index.mjs';
import { appendCalibrateRecovery, calibrateReader } from '../src/compat/calibrate.mjs';
import { continueOriginalOta } from '../src/compat/calibrate-retained-ota.mjs';
import { continueCalibrateRelease } from '../src/compat/calibrate-recovery.mjs';
import { verifyHistoricalArtifact } from '../src/artifacts.mjs';

const fixtures = new URL('./fixtures/calibrate-held/', import.meta.url);
const json = name => JSON.parse(fs.readFileSync(new URL(name, fixtures), 'utf8').replace(/^\uFEFF/, ''));
const target = 'ota-internal'; const source = '3dfb97c064c55cb55b514415618220f03dce91f1';
const runtime = 'f'.repeat(40); const bundle = 'original retained fixture bundle';
const sha256 = createHash('sha256').update(bundle).digest('hex');
const payload = { launch: Buffer.from(sha256, 'hex').toString('base64url'), assets: [] };
const branch = { id: 'original-branch', name: 'internal' }; const bundleIntegrity = 'b'.repeat(64);
const group = '00000000-0000-4000-8000-000000000001';
const reason = 'Operator verified the original outcomes and explicitly retired only the remaining unstarted stages.';

function fixture({ ota = true, deployment = true, knownId = false } = {}) {
  const release = json('release.json'); const record = JSON.parse(release.body); const originalRun = json('run.json');
  record.plan = { ...record.plan, native: false, reserve_native: false, native_codes: null, ota_internal: ota, ota_production: false };
  release.body = JSON.stringify(record); const originalBody = release.body;
  const assets = release.assets.filter(value => /^checkpoint-(prepared|image|deploy)-/.test(value.name)
    && (deployment || !value.name.startsWith('checkpoint-deploy-')));
  const data = new Map(); const recovery = []; const workflow = 'a'.repeat(40);
  const config = { schemaVersion: 1, repository: record.repository, defaultBranch: 'master', defaultProfile: 'production',
    profiles: { production: {} }, github: { handlerWorkflow: 'release-handler.yml' },
    expo: { projectId: 'fda8f8c5-e646-47ac-82fb-35003c9cbec7', owner: 'calibrate-health', slug: 'calibrate-health-app' },
    components: [{ id: 'server', kind: 'server' }, { id: target, kind: 'ota', platform: 'android', nativeTarget: 'phone', channel: 'internal', environment: 'preview' }],
    legacy: { format: 'calibrate-v1', handlerWorkflow: '.github/workflows/cut-release-handler.yml', recoveryWorkflow: '.github/workflows/publish-release-handler.yml' } };
  const add = (name, bytes) => { const asset = { id: Math.max(...assets.map(value => value.id)) + 1, name, size: bytes.length, uploader: { login: 'github-actions[bot]' } };
    assets.push(asset); data.set(asset.id, bytes); return asset; };
  const api = async (route, options = {}) => {
    assert.equal(options.method, undefined, 'The fixture never mutates remote release/provider state.');
    if (route === `/actions/runs/${record.run_id}`) return originalRun;
    if (route === '/actions/runs/999') return { repository: { full_name: record.repository }, head_branch: 'master', head_sha: workflow,
      path: '.github/workflows/release-handler.yml', event: 'workflow_run', run_attempt: 1 };
    const asset = assets.find(value => route === `/releases/assets/${value.id}`); assert.ok(asset, `Unexpected ${route}`);
    return data.get(asset.id) ?? fs.readFileSync(new URL(asset.name, fixtures));
  };
  const ledger = { config, api, workflowCommit: workflow, origin: { kind: 'github', runId: '999', runAttempt: 1 },
    read: async () => calibrateReader.read({ release, record, assets, api, config }),
    async upload(_id, name, bytes) { recovery.push(JSON.parse(bytes)); return add(name, bytes); } };
  const rawEvent = event => { const value = { schemaVersion: 1, kind: 'expo-legacy-recovery', recordDigest: hashIdentity(record), originalSource: source,
    origin: ledger.origin, workflowCommit: workflow, sequence: recovery.length + 1, previousDigest: recovery.length ? hashIdentity(recovery.at(-1)) : null, event };
    recovery.push(value); return add(`recovery-injected-${recovery.length}.json`, Buffer.from(JSON.stringify(value))); };
  const append = async event => appendCalibrateRecovery({ ledger, state: await ledger.read(), event });
  const provenance = { project: { androidPackage: 'net.darkmachines.healthtracker' }, runtimeVersion: runtime, appVersion: '0.2.8',
    channel: 'internal', environment: 'preview', serverUrl: 'https://calibratehealth.darkmachines.net', bundleIntegrity };
  const restore = async ({ directory }) => {
    const output = path.join(directory, 'files'); fs.mkdirSync(output); fs.writeFileSync(path.join(output, 'main.js'), bundle);
    fs.writeFileSync(path.join(output, 'metadata.json'), JSON.stringify({ fileMetadata: { android: { bundle: 'main.js', assets: [] } } }));
    const inventory = fs.readdirSync(output).map(name => ({ path: name, sha256: createHash('sha256').update(fs.readFileSync(path.join(output, name))).digest('hex') }));
    const sourceProof = await verifyHistoricalArtifact({ repository: config.repository, source, target, origin: { kind: 'github', runId: record.run_id, runAttempt: 1 },
      original: provenance, directory: output, verifyOriginal: async () => inventory });
    return { provenance, directory: output, sourceProof };
  };
  const raw = { id: '00000000-0000-4000-8000-000000000002', group, platform: 'android', runtime: { version: runtime }, branch,
    message: `Release ${release.id}`, environment: 'PREVIEW', manifestFragment: JSON.stringify({ launchAsset: { fileSHA256: payload.launch, storageKey: 'bundle' }, assets: [],
      extra: { expoClient: { extra: { eas: { projectId: config.expo.projectId }, serverUrl: provenance.serverUrl } } } }) };
  let starts = 0;
  const transport = { channel: async () => branch, listUpdates: async () => starts < 2 ? [] : [[raw]],
    getUpdate: async () => { if (knownId) throw new Error('Readback unavailable'); return [raw]; },
    cli: async () => { starts++; if (starts === 1 && !knownId) throw new Error('Lost original response'); return [raw]; },
    exportPayload: async () => payload, assetUrls: async () => [{ storageKey: 'bundle', url: 'https://fixture.invalid/bundle' }], hashArtifact: async () => sha256 };
  const execute = async request => continueOriginalOta({ ledger, state: await ledger.read(), request, target, restore, transport, environment: {} });
  const absence = { confirmed: true, outcome: 'not-published', noPublishedUpdate: true, noInFlightRequest: true,
    projectId: config.expo.projectId, target, applicationId: provenance.project.androidPackage, platform: 'android', runtime,
    channel: 'internal', environment: 'preview', branch, source, marker: raw.message, payload, bundleIntegrity,
    planDigest: hashIdentity(record.plan), operationKey: target, attempt: 1, observedAt: '2026-10-18T01:00:00.000Z',
    evidence: 'Operator audited provider history and request logs; no update was published and no request remains in flight.' };
  return { ledger, record, release, originalBody, assets, recovery, rawEvent, append, add, execute, absence, starts: () => starts };
}

test('original retained OTA retries only after exact audited absence and preserves prior server success', async () => {
  const f = fixture(); const before = await f.ledger.read(); const server = before.events.filter(value => ['image', 'deploy'].includes(value.stage));
  await assert.rejects(f.execute({ action: 'resume' }), /Lost original response/);
  await assert.rejects(f.execute({ action: 'retry' }), /absence from a search/); assert.equal(f.starts(), 1);
  for (const change of [{ confirmed: false }, { noInFlightRequest: false }, { attempt: 2 }, { bundleIntegrity: 'c'.repeat(64) }, { marker: 'other' }]) {
    await assert.rejects(f.execute({ action: 'reconcile', reconciliation: { absence: { ...f.absence, ...change } } }), /explicit provider audit/);
  }
  const reconciled = await f.execute({ action: 'reconcile', reconciliation: { absence: f.absence } });
  assert.equal(reconciled.status, 'failed'); assert.equal(f.starts(), 1);
  await assert.rejects(f.execute({ action: 'resume' }), /explicit retry/);
  const completed = await f.execute({ action: 'retry' });
  assert.equal(completed.status, 'complete'); assert.equal(completed.attempt, 2); assert.equal(f.starts(), 2);
  assert.equal(completed.history[0].retryProof.bundleIntegrity, bundleIntegrity);
  await f.execute({ action: 'retry' }); assert.equal(f.starts(), 2);
  const after = await f.ledger.read(); assert.deepEqual(after.events.filter(value => ['image', 'deploy'].includes(value.stage)), server);
  assert.deepEqual(after.baseline.reservations, before.baseline.reservations); assert.equal(f.release.body, f.originalBody);
});

test('original retained OTA with a known accepted ID cannot be reconciled as absent', async () => {
  const f = fixture({ knownId: true }); await assert.rejects(f.execute({ action: 'resume' }), /Readback unavailable/);
  assert.equal((await f.ledger.read()).events.findLast(value => value.stage === target).operation.operationId, group);
  await assert.rejects(f.execute({ action: 'reconcile', reconciliation: { absence: f.absence } }), /without a provider ID/);
  assert.equal(f.starts(), 1);
});

test('terminal events require explicit abandonment reasons and reject unresolved work before upload and on read', async () => {
  for (const event of [{ type: 'completion', status: 'abandoned' }, { type: 'completion', status: 'abandoned', reason: 'short' },
    { type: 'completion', status: 'complete' }]) {
    const f = fixture(); await assert.rejects(f.append(event), /explicit reason|incomplete stages/); assert.equal(f.recovery.length, 0);
    f.rawEvent(event); await assert.rejects(f.ledger.read(), /explicit reason|incomplete stages/);
  }
  const active = fixture(); const transition = { type: 'intent', operationKey: target };
  await active.append({ stage: target, status: 'intent', operation: reduceOperation(null, transition), transition });
  const event = { type: 'completion', status: 'abandoned', reason };
  await assert.rejects(active.append(event), /Reconcile every/); assert.equal(active.recovery.length, 1);
  active.rawEvent(event); await assert.rejects(active.ledger.read(), /Reconcile every/);
  const server = fixture({ deployment: false });
  await assert.rejects(server.append(event), /preserves the completed original server/); assert.equal(server.recovery.length, 0);
  server.rawEvent(event); await assert.rejects(server.ledger.read(), /preserves the completed original server/);
});

test('valid completion or abandonment is terminal even while final draft publication is pending', async () => {
  for (const complete of [true, false]) {
    const f = fixture({ ota: !complete }); const before = await f.ledger.read();
    const event = { type: 'completion', status: complete ? 'complete' : 'abandoned', ...(complete ? {} : { reason }) };
    await f.append(event); const after = await f.ledger.read();
    assert.deepEqual(after.baseline.reservations, before.baseline.reservations); assert.equal(f.release.body, f.originalBody);
    await assert.rejects(f.append(event), /after historical completion/); assert.equal(f.recovery.length, 1);
    f.release.draft = false; assert.equal((await f.ledger.read()).resolved, true); f.release.draft = true;
    f.rawEvent(event); await assert.rejects(f.ledger.read(), /after historical completion/);
  }
  const checkpoint = fixture({ ota: false }); await checkpoint.append({ type: 'completion', status: 'complete' });
  const original = checkpoint.assets.find(value => value.name.startsWith('checkpoint-prepared-'));
  checkpoint.add('checkpoint-prepared-after-completion.json', fs.readFileSync(new URL(original.name, fixtures)));
  await assert.rejects(checkpoint.ledger.read(), /checkpoints after historical completion/);
});

test('a completed compatibility graph cannot conceal an outstanding runtime provider suboperation', async () => {
  const f = fixture(); const config = f.ledger.config;
  const stages = { [`${target}:export`]: { target, action: 'export' }, [`${target}:publish`]: { target, action: 'publish' } };
  const plan = createPlan({ source: { repository: config.repository, commit: source, workflowCommit: f.ledger.workflowCommit, toolkitCommit: 'd'.repeat(40) },
    config, origin: f.ledger.origin, prepared: true, selection: { selected: [target] }, stages,
    graph: buildReleaseGraph([{ id: `${target}:export`, component: target }, { id: `${target}:publish`, component: target, needs: [`${target}:export`] }]),
    compatibility: { format: 'calibrate-v1-ota', recordDigest: hashIdentity(f.record), releaseId: String(f.release.id), target } });
  await f.append({ type: 'compatibility-plan', target, plan });
  const append = data => f.append({ type: 'compatibility-phase', target, planDigest: plan.digest, data });
  await append({ stage: `${target}:export`, status: 'complete', receipt: { artifact: 'fixture' } });
  const stage = `${target}:publish:runtime-${'c'.repeat(64)}`; const transition = { type: 'intent', operationKey: stage };
  await append({ stage, status: 'intent', operation: reduceOperation(null, transition), transition });
  await append({ stage: `${target}:publish`, status: 'complete', receipt: { outcome: 'published', publications: [{ runtime, operationId: group }] } });
  assert.equal((await f.ledger.read()).summary.status, 'complete');
  const event = { type: 'completion', status: 'complete' };
  await assert.rejects(f.append(event), /Reconcile every/); f.rawEvent(event);
  await assert.rejects(f.ledger.read(), /Reconcile every/);
});

test('failed final Release PATCH retries only the unchanged terminal decision without another journal entry', async () => {
  for (const action of ['complete', 'abandon']) {
    const f = fixture({ ota: action === 'abandon' }); const readOnly = f.ledger.api; let patches = 0;
    f.ledger.api = async (route, options = {}) => {
      if (options.method !== 'PATCH') return readOnly(route, options);
      assert.equal(route, `/releases/${f.release.id}`); assert.deepEqual(options.body, { draft: false, make_latest: 'false' });
      patches++; if (patches === 1) throw new Error('Lost final publication response');
      f.release.draft = false; return f.release;
    };
    const request = { action, ...(action === 'abandon' ? { reason } : {}) };
    const execute = value => continueCalibrateRelease({ ledger: f.ledger, releaseId: f.release.id, request: value });
    await assert.rejects(execute(request), /Lost final publication response/); assert.equal(f.recovery.length, 1);
    const saved = structuredClone(f.recovery[0]);
    await assert.rejects(execute({ action: 'resume', stage: target }), /unchanged completion decision/);
    if (action === 'abandon') await assert.rejects(execute({ ...request, reason: 'A changed abandonment explanation must not replace the original decision.' }), /unchanged completion decision/);
    const result = await execute(request); assert.equal(result[action === 'complete' ? 'complete' : 'abandoned'], true);
    assert.equal(patches, 2); assert.equal(f.recovery.length, 1); assert.deepEqual(f.recovery[0], saved);
    assert.equal((await f.ledger.read()).resolved, true); assert.equal(f.release.body, f.originalBody);
  }
});
