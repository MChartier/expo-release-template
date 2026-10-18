/** @file Exercises split EAS enqueue/observation across lost responses, interrupted retention, forged IDs and retry attempts without creating remote builds. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createPlan, summarizeRelease } from '../packages/release-engine/index.mjs';
import { reduceOperation } from '../packages/release-engine/index.mjs';
import { planRelease } from '../src/planner.mjs';
import { beginCloudBuild, enqueueCloudBuild, monitorCloudBuild } from '../src/cloud-build.mjs';
import { latestOperation } from '../src/operations.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const projectId = '22222222-2222-4222-8222-222222222222';
const bytes = Buffer.from('exact signed native build fixture');
const sha256 = createHash('sha256').update(bytes).digest('hex');
function fixture(t, { distribution = 'store', pending = false } = {}) {
  const directory = fs.mkdtempSync(path.join(tmpdir(), 'cloud-release-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'source'); fs.mkdirSync(root);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  git(['init', '--quiet']); fs.writeFileSync(path.join(root, 'app.json'), '{}'); git(['add', 'app.json']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  const source = { repository: 'fixture/app', commit: git(['rev-parse', 'HEAD']), workflowCommit: 'b'.repeat(40), toolkitCommit: 'c'.repeat(40) };
  const origin = { kind: 'github', runId: '123', runAttempt: 1 };
  const expo = { projectId, owner: 'fixture', slug: 'app' };
  const config = { schemaVersion: 1, repository: source.repository, defaultBranch: 'main', defaultProfile: 'production', expo,
    profiles: { production: { channel: 'production', environment: 'production', easProfile: 'production', distribution, submit: false } },
    components: [{ id: 'android', kind: 'native', builder: 'eas', platform: 'android', appDirectory: '.', applicationId: 'app.fixture' }] };
  const observation = { id: 'android', identity: 'native', runtime: '1.2.3', version: '1.2.3', versionCode: 7,
    fingerprint: 'd'.repeat(40), environmentHash: 'e'.repeat(64), expoConfig: { name: 'Fixture', extra: { eas: { projectId } } } };
  const { schemaVersion, kind, digest, ...payload } = planRelease({ config, source, origin, observations: [observation] });
  const plan = createPlan({ ...payload, prepared: true, providerConfiguration: { expo, destinations: { android: {} } } });
  const events = []; const ledger = {
    async read() { return { plan, release: { id: 1, draft: true }, events }; },
    async append(releaseId, event) { events.push(structuredClone(event)); },
  };
  const raw = { id, app: { id: projectId }, appIdentifier: 'app.fixture', platform: 'ANDROID', gitCommitHash: source.commit,
    buildProfile: 'production', appVersion: observation.version, appBuildVersion: '7', runtime: { version: observation.runtime },
    updateChannel: { name: 'production' }, distribution: distribution.toUpperCase(), isForIosSimulator: false,
    message: 'expo-release:123:build:android', fingerprint: { hash: observation.fingerprint }, status: pending ? 'IN_PROGRESS' : 'FINISHED',
    artifacts: { applicationArchiveUrl: 'https://provider.invalid/archive?temporary=secret' } };
  const calls = { enqueue: 0, read: 0, search: 0, download: 0 };
  const transport = {
    async signingCredentials() { return { androidAppCredentials: [{ androidAppBuildCredentialsList: [{ isDefault: true, androidKeystore: { id: 'key' } }] }] }; },
    async cli(args) { if (args[0] === 'build') { calls.enqueue++; return [{ id }]; } assert.equal(args[0], 'build:list'); calls.search++; return [raw]; },
    async getBuild(requested) { calls.read++; assert.equal(requested, id); return raw; },
    async hashArtifact() { return sha256; },
  };
  const inputs = { expo, environment: {}, hash: observation.environmentHash };
  const args = { ledger, releaseId: 1, target: 'android', plan, root, inputs, origin, transport,
    outputRoot: path.join(directory, 'artifacts'), handoffFile: path.join(directory, 'accepted.json'),
    workflowCommit: source.workflowCommit, toolkitCommit: source.toolkitCommit,
    fetch: async () => { calls.download++; return { ok: true, body: [bytes] }; } };
  return { args, calls, events, raw, directory };
}

test('fresh intent grants one lease and enqueue persists raw ID without readback', async t => {
  const { args, calls, events } = fixture(t);
  const begun = await beginCloudBuild(args); assert.equal(begun.mode, 'enqueue');
  assert.equal(events[0].stage, 'android:build-provider'); assert.equal(events[0].status, 'intent');
  assert.equal((await beginCloudBuild(args)).mode, 'observe');
  const accepted = await enqueueCloudBuild({ ...args, lease: begun.lease });
  assert.equal(accepted.id, id); assert.equal(calls.enqueue, 1); assert.equal(calls.read, 0);
  assert.deepEqual(JSON.parse(fs.readFileSync(args.handoffFile)), accepted);
  await assert.rejects(enqueueCloudBuild({ ...args, lease: begun.lease }), /EEXIST/); assert.equal(calls.enqueue, 1);
});

test('explicit failed-build replacement preserves prior IDs and uses a new producing lease', async t => {
  const { args, raw, events, calls } = fixture(t);
  await beginCloudBuild(args);
  let operation = latestOperation(events, 'android:build-provider');
  operation = reduceOperation(operation, { type: 'accepted', operationId: id });
  operation = reduceOperation(operation, { type: 'failed', definitive: true, reason: 'Provider failure', proof: { provider: 'eas' } });
  events.push({ stage: 'android:build-provider', status: 'failed', operation });
  raw.status = 'ERRORED'; raw.artifacts = {};
  assert.equal((await beginCloudBuild(args)).mode, 'observe');
  const origin = { ...args.origin, runId: '456', runAttempt: 1 };
  const fresh = await beginCloudBuild({ ...args, origin, retry: true });
  assert.equal(fresh.mode, 'enqueue'); assert.deepEqual(fresh.lease.origin, origin);
  const next = latestOperation(events, 'android:build-provider');
  assert.equal(next.attempt, 2); assert.equal(next.history[0].operationId, id); assert.deepEqual(next.request, fresh.lease);
  assert.equal(calls.enqueue, 0);
  await assert.rejects(beginCloudBuild({ ...args, origin, retry: true }), /definitively failed/);
});

test('replacement refuses a formerly failed build that now has application output', async t => {
  const { args, raw, events } = fixture(t);
  await beginCloudBuild(args);
  let operation = reduceOperation(latestOperation(events, 'android:build-provider'), { type: 'accepted', operationId: id });
  operation = reduceOperation(operation, { type: 'failed', definitive: true, reason: 'Old failure', proof: { provider: 'eas' } });
  events.push({ stage: 'android:build-provider', status: 'failed', operation });
  raw.status = 'ERRORED';
  await assert.rejects(beginCloudBuild({ ...args, retry: true }), /without a produced application artifact/);
  assert.equal(latestOperation(events, 'android:build-provider').attempt, 1);
});

test('enqueue rejects another source or producing attempt before any provider mutation', async t => {
  const { args, calls } = fixture(t); const { lease } = await beginCloudBuild(args);
  await assert.rejects(enqueueCloudBuild({ ...args, lease, origin: { ...args.origin, runAttempt: 2 } }), /lease differs/);
  fs.writeFileSync(path.join(args.root, 'app.json'), '{"changed":true}');
  await assert.rejects(enqueueCloudBuild({ ...args, lease }), /tracked changes/); assert.equal(calls.enqueue, 0);
});

test('source-free monitoring seals exact bytes while canonical build remains pending retention', async t => {
  const { args, calls, events, directory } = fixture(t); const { lease } = await beginCloudBuild(args);
  const accepted = await enqueueCloudBuild({ ...args, lease }); fs.rmSync(args.root, { recursive: true });
  const result = await monitorCloudBuild({ ...args, accepted });
  assert.equal(calls.enqueue, 1); assert.equal(result.operation.status, 'complete');
  assert.equal(result.artifacts[0].receipt.metadata.native.artifact.sha256, sha256);
  assert.equal(result.artifacts[0].receipt.manifest.files[0].path, 'app.aab');
  assert.equal(fs.readFileSync(path.join(directory, 'artifacts/android/files/app.aab'), 'utf8'), bytes.toString());
  assert.ok(summarizeRelease(args.plan.graph, events.filter(event => args.plan.stages[event.stage])).remaining.includes('android:build'));
  assert.ok(!JSON.stringify(events).includes('temporary=secret')); assert.ok(!JSON.stringify(result).includes('temporary=secret'));
});

test('lost enqueue response reconciles one matching marker and never enqueues again', async t => {
  const { args, calls } = fixture(t); const { lease } = await beginCloudBuild(args);
  const cli = args.transport.cli; args.transport.cli = async argv => { const result = await cli(argv); if (argv[0] === 'build') throw new Error('lost response'); return result; };
  await assert.rejects(enqueueCloudBuild({ ...args, lease }), /lost response/);
  assert.equal((await beginCloudBuild(args)).mode, 'observe');
  const result = await monitorCloudBuild(args);
  assert.equal(result.operation.operationId, id); assert.equal(calls.enqueue, 1); assert.equal(calls.search, 1);
});

test('empty reconciliation and missing intent cannot authorize observer enqueue', async t => {
  const { args, calls } = fixture(t);
  await assert.rejects(monitorCloudBuild(args), /durable enqueue intent/);
  await beginCloudBuild(args); args.transport.cli = async () => [];
  await assert.rejects(monitorCloudBuild(args), /No unique provider result/); assert.equal(calls.enqueue, 0);
});

test('timeout preserves accepted ID and resumes observation without a second build', async t => {
  const { args, calls, raw, events } = fixture(t, { pending: true }); const { lease } = await beginCloudBuild(args);
  const accepted = await enqueueCloudBuild({ ...args, lease });
  await assert.rejects(monitorCloudBuild({ ...args, accepted, timeoutMs: 0 }), /remains pending/);
  assert.equal(latestOperation(events, 'android:build-provider').operationId, id);
  raw.status = 'FINISHED'; await monitorCloudBuild(args); assert.equal(calls.enqueue, 1);
});

test('failed retention retries exact completed bytes; altered bytes never become a receipt', async t => {
  const { args, calls, events } = fixture(t, { distribution: 'internal' }); const { lease } = await beginCloudBuild(args);
  const accepted = await enqueueCloudBuild({ ...args, lease });
  await assert.rejects(monitorCloudBuild({ ...args, accepted, fetch: async () => ({ ok: true, body: [Buffer.from('changed')] }) }), /bytes differ/);
  assert.equal(latestOperation(events, 'android:build-provider').status, 'complete');
  assert.ok(!fs.existsSync(path.join(args.outputRoot, 'android/receipt.json')));
  const result = await monitorCloudBuild(args); assert.equal(result.artifacts[0].receipt.manifest.files[0].path, 'app.apk');
  assert.equal(calls.enqueue, 1);
});

test('failed builds and conflicting accepted IDs block replacement work', async t => {
  const { args, raw, calls } = fixture(t); const { lease } = await beginCloudBuild(args);
  const accepted = await enqueueCloudBuild({ ...args, lease }); raw.status = 'ERRORED';
  await assert.rejects(monitorCloudBuild({ ...args, accepted }), /failed/);
  assert.equal((await beginCloudBuild(args)).mode, 'observe');
  await assert.rejects(monitorCloudBuild(args), /explicit retry/);
  await assert.rejects(monitorCloudBuild({ ...args, accepted: { ...accepted, id: projectId } }), /ID changed/);
  assert.equal(calls.enqueue, 1);
});
