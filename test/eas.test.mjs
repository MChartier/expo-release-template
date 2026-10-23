/** @file Characterizes exact EAS build/submission recovery, provider-authorized retries, local provenance, and retained OTA byte verification without network access. */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { createEasBuildProvider, createEasSubmissionProvider, createEasOtaProvider, exportPayload,
  hashRemoteArtifact, preflightEasSigning, verifyProvisioningProfile, verifyEasBuild, verifyEasSubmission, verifyEasUpdate } from '../src/providers/eas.mjs';
import { createEasPublisherWorkspace } from '../src/providers/eas-workspace.mjs';
import { createArtifactReceipt, verifyRetainedArtifact } from '../src/artifacts.mjs';
import { planRelease } from '../src/planner.mjs';
import { executeOperation, latestOperation } from '../src/operations.mjs';
import { reduceOperation } from '../packages/release-engine/index.mjs';
import { createCorrectableEasSubmissionProvider } from '../src/providers/eas-correction.mjs';
import { recoverRelease } from '../src/recovery.mjs';

const buildId = '00000000-0000-4000-8000-000000000001';
const submissionId = '00000000-0000-4000-8000-000000000002';
const retryId = '00000000-0000-4000-8000-000000000003';
const groupId = '00000000-0000-4000-8000-000000000004';
const digest = 'b'.repeat(64);
const buildSpec = { projectId: '00000000-0000-4000-8000-000000000000', applicationId: 'app.fixture', source: 'a'.repeat(40),
  platform: 'android', profile: 'production', distribution: 'store', version: '1.2.3', versionCode: 7, runtime: '1.2.3',
  channel: 'production', environment: 'production', fingerprint: 'c'.repeat(40), marker: 'release:fixture:build:android' };
function fixture() {
  const build = { id: buildId, app: { id: buildSpec.projectId }, appIdentifier: buildSpec.applicationId,
    gitCommitHash: buildSpec.source, platform: 'ANDROID', buildProfile: buildSpec.profile, appVersion: buildSpec.version,
    appBuildVersion: '7', runtime: { version: buildSpec.runtime }, updateChannel: { name: buildSpec.channel },
    distribution: 'STORE', status: 'FINISHED', fingerprint: { hash: buildSpec.fingerprint }, message: buildSpec.marker,
    artifacts: { applicationArchiveUrl: 'https://fixture.invalid/native' }, submissions: [] };
  const submission = { id: submissionId, app: build.app, platform: 'ANDROID', status: 'IN_QUEUE', canRetry: false,
    archiveUrl: 'https://fixture.invalid/submitted',
    androidConfig: { track: 'internal', releaseStatus: 'DRAFT' }, submittedBuild: build };
  const submissions = new Map([[submissionId, submission]]);
  const calls = [];
  const transport = {
    async cli(args) {
      calls.push(args);
      if (args[0] === 'build:list') return [build];
      if (args[0] === 'build') return [build];
      if (args[0] === 'submit') { build.submissions.push({ id: submissionId }); return ''; }
      if (args[0] === 'submit:retry') {
        const value = { ...submission, id: retryId, status: 'IN_QUEUE', canRetry: false };
        submissions.set(retryId, value); build.submissions.push({ id: retryId }); return value;
      }
      throw Error(`Unexpected command ${args[0]}`);
    },
    async getBuild(id) { assert.equal(id, buildId); return build; },
    async getSubmission(id) { return submissions.get(id); },
    async hashArtifact() { return digest; },
    async hashFile() { return digest; },
  };
  const spec = { projectId: buildSpec.projectId, platform: 'android', profile: 'production', build: buildSpec,
    artifact: { kind: 'eas-build', buildId, sha256: digest }, destination: { track: 'internal', releaseStatus: 'draft' } };
  return { build, submission, submissions, transport, spec, calls };
}

test('build provider recovers the exact ID and verifies finished bytes', async () => {
  const { transport, calls } = fixture(); const provider = createEasBuildProvider(buildSpec, transport);
  const found = await provider.find(); assert.equal(found.id, buildId); assert.equal(found.status, 'complete');
  const artifact = (await provider.verify(found)).artifact;
  assert.equal(artifact.sha256, digest); assert.equal(artifact.url, undefined);
  assert.equal(calls.filter(args => args[0] === 'build').length, 0);
});

test('build provider rejects ambiguity, changed source and changed artifact bytes', async () => {
  const f = fixture(); const provider = createEasBuildProvider({ ...buildSpec, artifactSha256: digest }, f.transport);
  f.transport.cli = async () => [f.build, { ...f.build, id: retryId }];
  await assert.rejects(provider.find(), /Multiple/);
  f.build.gitCommitHash = 'd'.repeat(40); await assert.rejects(provider.status(buildId), /source/);
  f.build.gitCommitHash = buildSpec.source; f.transport.hashArtifact = async () => 'd'.repeat(64);
  await assert.rejects(provider.verify({ id: buildId }), /bytes/);
});

test('empty build search is null and failed builds cannot silently restart', async () => {
  const f = fixture(); f.transport.cli = async () => [];
  const provider = createEasBuildProvider(buildSpec, f.transport);
  assert.equal(await provider.find(), null);
  await assert.rejects(provider.start({ retry: { mode: 'new-request' } }), /reconciliation/);
  f.build.status = 'ERRORED'; assert.equal((await provider.status(buildId)).status, 'failed');
  f.build.status = 'UNRECOGNIZED'; assert.equal((await provider.status(buildId)).status, 'unknown');
});

test('build identity requires selected source, versions, channel, distribution and fingerprint', () => {
  const { build } = fixture();
  for (const mutation of [{ appIdentifier: 'other' }, { appBuildVersion: '8' }, { runtime: { version: 'other' } },
    { updateChannel: { name: 'other' } }, { distribution: 'INTERNAL' }, { fingerprint: { hash: 'other' } }]) {
    assert.throws(() => verifyEasBuild({ ...build, ...mutation }, buildSpec));
  }
});

test('submission acceptance does not imply completion and preserves exact build identity', async () => {
  const f = fixture(); const provider = createEasSubmissionProvider(f.spec, f.transport);
  const accepted = await provider.start(); assert.equal(accepted.status, 'accepted');
  assert.equal((await provider.verify(accepted, { requireComplete: false })).artifact.buildId, buildId);
  await assert.rejects(provider.verify(accepted), /required state/);
  f.submission.status = 'FINISHED'; assert.equal((await provider.verify(accepted)).status, 'complete');
  assert.deepEqual(f.calls[0], ['submit', '--platform', 'android', '--profile', 'production', '--id', buildId, '--non-interactive', '--no-wait', '--no-auto-testflight-setup']);
});

test('lost enqueue response is recovered by observation without a second request', async () => {
  const f = fixture(); const invoke = f.transport.cli;
  f.transport.cli = async args => { await invoke(args); throw Error('lost response'); };
  const provider = createEasSubmissionProvider(f.spec, f.transport);
  await assert.rejects(provider.start(), /lost response/);
  assert.equal((await provider.find()).id, submissionId);
  assert.equal(f.calls.length, 1);
});

test('submission retries refresh provider facts and use the exact failed ID', async () => {
  const f = fixture(); f.submission.status = 'ERRORED'; f.submission.canRetry = true;
  f.build.submissions.push({ id: submissionId });
  const provider = createEasSubmissionProvider(f.spec, f.transport);
  const retry = await provider.prepareRetry({ id: submissionId });
  const next = await provider.start({ retry, previousIds: [submissionId] });
  assert.equal(next.id, retryId); assert.equal(next.status, 'accepted');
  assert.deepEqual(f.calls, [['submit:retry', submissionId, '--non-interactive', '--json']]);
  assert.equal((await provider.find({ previousIds: [submissionId] })).id, retryId);
});

test('common destination reconciliation preserves the old request and requires a separate fresh verified correction retry', async () => {
  const f = fixture(); f.submission.status = 'ERRORED'; f.submission.androidConfig.track = 'invalid-track';
  f.build.submissions.push({ id: submissionId });
  const source = { repository: 'fixture/app', commit: 'a'.repeat(40), workflowCommit: 'a'.repeat(40), toolkitCommit: 'c'.repeat(40) };
  const config = { schemaVersion: 1, repository: source.repository, defaultBranch: 'main', components: [
    { id: 'android', kind: 'native', platform: 'android', builder: 'eas' }] };
  const plan = planRelease({ config, source, origin: { kind: 'github', runId: '123', runAttempt: 1 },
    observations: [{ id: 'android', identity: 'native', runtime: '1.2.3' }] });
  const stage = 'android:submit'; const context = { planDigest: plan.digest };
  const operation = reduceOperation(reduceOperation(null, { type: 'intent', operationKey: stage, request: context }), { type: 'accepted', operationId: submissionId });
  const state = { release: { id: 1, draft: true }, plan, events: [{ stage, status: 'accepted', operation }] };
  const ledger = { read: async () => structuredClone(state), append: async (_id, event) => state.events.push(structuredClone(event)) };
  const input = { ledger, releaseId: 1, stage, context };
  const factory = () => createCorrectableEasSubmissionProvider({ spec: f.spec, transport: f.transport, operation: latestOperation(state.events, stage) });
  const destination = { confirmed: true, reason: 'Reviewed the rejected upload and confirmed no store publication.',
    operationId: submissionId, artifactSha256: digest, from: 'invalid-track', to: 'internal' };
  const request = { action: 'reconcile', stage, destination };
  await assert.rejects(recoverRelease({ ...input, request: { ...request, destination: { ...destination, to: 'production' } }, providerForStage: factory }), /sealed destination/);
  const wrongReadback = f.transport.getSubmission;
  f.transport.getSubmission = async id => ({ ...await wrongReadback(id), id: retryId });
  await assert.rejects(recoverRelease({ ...input, request, providerForStage: factory }), /readback ID/);
  f.transport.getSubmission = wrongReadback;
  await recoverRelease({ ...input, request, providerForStage: factory });
  assert.equal(f.calls.length, 0); assert.equal(state.events[0].operation.operationId, submissionId);
  await assert.rejects(executeOperation({ ...input, provider: factory() }), /explicit retry/);
  f.submission.status = 'IN_PROGRESS';
  await assert.rejects(executeOperation({ ...input, provider: factory(), retry: true }), /rejection/);
  assert.equal(f.calls.length, 0); f.submission.status = 'ERRORED';
  f.transport.cli = async args => {
    f.calls.push(args); assert.equal(args[0], 'submit');
    f.submissions.set(retryId, { ...f.submission, id: retryId, status: 'IN_QUEUE', androidConfig: { track: 'internal', releaseStatus: 'DRAFT' } });
    f.build.submissions.push({ id: retryId }); return '';
  };
  const result = await executeOperation({ ...input, provider: factory(), retry: true });
  assert.equal(result.operationId, retryId); assert.equal(result.history[0].operationId, submissionId);
  assert.equal(result.history[0].proof.from, 'invalid-track'); assert.equal(result.proof.destination.track, 'internal');
  assert.equal(f.calls.length, 1); assert.equal(state.plan.digest, plan.digest);
});

test('expired retries, cancellations, wrong destinations and altered bytes never authorize upload', async () => {
  for (const mutation of ['expired', 'canceled', 'destination', 'artifact', 'source']) {
    const f = fixture(); f.submission.status = 'ERRORED'; f.submission.canRetry = true;
    if (mutation === 'expired') f.submission.canRetry = false;
    if (mutation === 'canceled') f.submission.status = 'CANCELED';
    if (mutation === 'destination') f.submission.androidConfig.track = 'production';
    if (mutation === 'artifact') f.transport.hashArtifact = async () => 'd'.repeat(64);
    if (mutation === 'source') f.build.gitCommitHash = 'd'.repeat(40);
    await assert.rejects(createEasSubmissionProvider(f.spec, f.transport).prepareRetry({ id: submissionId }));
    assert.equal(f.calls.length, 0);
  }
});

test('retry eligibility is checked again immediately before mutation', async () => {
  const f = fixture(); f.submission.status = 'ERRORED'; f.submission.canRetry = true;
  const provider = createEasSubmissionProvider(f.spec, f.transport);
  const retry = await provider.prepareRetry({ id: submissionId }); f.submission.canRetry = false;
  await assert.rejects(provider.start({ retry }), /authorize/); assert.equal(f.calls.length, 0);
});

test('local-file submissions retain local origin and ambiguous lost responses cannot be guessed', async () => {
  const f = fixture(); delete f.submission.submittedBuild;
  const spec = { ...f.spec, owner: 'fixture', slug: 'app', artifact: { kind: 'local-file', origin: 'local', path: '/retained/app.aab', sha256: digest } };
  f.transport.cli = async () => `https://expo.dev/accounts/fixture/projects/app/submissions/${submissionId}`;
  const provider = createEasSubmissionProvider(spec, f.transport);
  const accepted = await provider.start();
  assert.equal((await provider.verify(accepted, { requireComplete: false })).artifact.origin, 'local');
  f.transport.hashArtifact = async () => 'f'.repeat(64);
  await assert.rejects(provider.verify(accepted, { observe: true }), /Submitted archive differs/);
  f.transport.hashArtifact = async () => digest;
  assert.equal(await provider.find(), null);
  f.transport.cli = async () => 'response unavailable'; await assert.rejects(provider.start(), /uncertain/);
  assert.throws(() => verifyEasSubmission({ ...f.submission, submittedBuild: f.build }, spec), /distinct/);
});

test('iOS submission destinations must be explicitly configured', () => {
  const f = fixture(); const spec = { ...f.spec, platform: 'ios', destination: {}, artifact: { kind: 'local-file', origin: 'local' } };
  const raw = { ...f.submission, platform: 'IOS', submittedBuild: undefined, iosConfig: { ascAppIdentifier: '12345' } };
  assert.throws(() => verifyEasSubmission(raw, spec), /App Store/);
  assert.equal(verifyEasSubmission(raw, { ...spec, destination: { ascAppId: '12345' } }), raw);
});

function otaFixture() {
  const payloadHash = Buffer.from(digest, 'hex').toString('base64url');
  const spec = { projectId: buildSpec.projectId, platform: 'android', source: buildSpec.source, runtime: '1.2.3', channel: 'internal', environment: 'preview',
    branch: { id: 'branch-id', name: 'internal' }, marker: 'release:fixture:ota:android', directory: '/retained/export', serverUrl: 'https://fixture.invalid', payload: { launch: payloadHash, assets: [payloadHash] } };
  const raw = { id: retryId, group: groupId, platform: 'android', runtime: { version: spec.runtime }, gitCommitHash: spec.source,
    isGitWorkingTreeDirty: false, branch: spec.branch, message: spec.marker, environment: 'PREVIEW',
    manifestFragment: JSON.stringify({ launchAsset: { fileSHA256: payloadHash, storageKey: 'launch' }, assets: [{ fileSHA256: payloadHash, storageKey: 'asset' }],
      extra: { expoClient: { extra: { eas: { projectId: spec.projectId }, serverUrl: spec.serverUrl } } } }) };
  const calls = [];
  const transport = {
    async channel() { return spec.branch; }, async listUpdates() { return [[raw]]; }, async getUpdate() { return [raw]; },
    async cli(args) { calls.push(args); return [raw]; }, async exportPayload() { return spec.payload; },
    async assetUrls() { return ['launch', 'asset'].map(storageKey => ({ storageKey, url: 'https://fixture.invalid/asset', headers: {} })); },
    async hashArtifact() { return digest; },
  };
  return { spec, raw, calls, transport };
}

function otaAbsence(spec, context) {
  return { confirmed: true, outcome: 'not-published', noPublishedUpdate: true, noInFlightRequest: true,
    projectId: spec.projectId, target: spec.target, applicationId: spec.applicationId, platform: spec.platform, runtime: spec.runtime,
    channel: spec.channel, environment: spec.environment, branch: spec.branch, source: spec.source, marker: spec.marker, payload: spec.payload,
    planDigest: context.planDigest, operationKey: context.operationKey, attempt: context.attempt,
    observedAt: '2026-10-18T01:00:00.000Z', evidence: 'Operator audited the provider request and confirmed no published update and no request still in flight.' };
}

test('OTA lost response stays blocked until audited absence, then permits exactly one fresh explicit attempt', async () => {
  const f = otaFixture(); Object.assign(f.spec, { target: 'android.ota', applicationId: 'app.fixture' });
  const previous = { stage: 'server:deploy', operation: reduceOperation(reduceOperation(null, { type: 'intent', operationKey: 'server:deploy' }),
    { type: 'complete', receipt: { healthy: true } }) };
  const events = [structuredClone(previous)]; let count = 0;
  f.transport.cli = async () => { count++; if (count === 1) throw new Error('Lost response'); return [f.raw]; };
  f.transport.listUpdates = async () => count < 2 ? [] : [[f.raw]];
  const ledger = { read: async () => ({ events }), append: async (_id, event) => events.push(event) };
  const context = { planDigest: 'a'.repeat(64), source: f.spec.source, target: f.spec.target };
  const stage = 'android.ota:publish:runtime-fixture'; const provider = createEasOtaProvider(f.spec, f.transport);
  const args = { ledger, releaseId: '123', stage, provider, context };
  await assert.rejects(executeOperation(args), /Lost response/);
  await assert.rejects(executeOperation({ ...args, retry: true }), /absence from a search/); assert.equal(count, 1);
  const bound = { ...context, operationKey: stage, attempt: 1 }; const evidence = otaAbsence(f.spec, bound);
  const proof = await provider.verifyAbsence(evidence, bound);
  const transition = { type: 'reconciled-absent', proof };
  events.push({ stage, operation: reduceOperation(latestOperation(events, stage), transition), transition });
  await assert.rejects(executeOperation(args), /explicit retry/); assert.equal(count, 1);
  const result = await executeOperation({ ...args, retry: true });
  assert.equal(result.status, 'complete'); assert.equal(result.attempt, 2); assert.equal(count, 2);
  assert.equal(result.history[0].retryProof.attempt, 1); assert.deepEqual(result.history[0].retryProof.payload, f.spec.payload);
  await executeOperation({ ...args, retry: true }); assert.equal(count, 2); assert.deepEqual(events[0], previous);
});

test('OTA absence rejects declined, mismatched, conflicting and unbounded evidence without publishing', async () => {
  const f = otaFixture(); Object.assign(f.spec, { target: 'android.ota', applicationId: 'app.fixture' });
  f.transport.listUpdates = async () => [];
  const provider = createEasOtaProvider(f.spec, f.transport);
  const context = { planDigest: 'a'.repeat(64), source: f.spec.source, target: f.spec.target, operationKey: 'ota-stage', attempt: 1 };
  const evidence = otaAbsence(f.spec, context);
  for (const change of [{ confirmed: false }, { noPublishedUpdate: false }, { noInFlightRequest: false }, { attempt: 2 }, { marker: 'other' },
    { payload: { launch: 'changed', assets: [] } }, { branch: { id: 'other', name: 'internal' } }, { projectId: 'other' }, { source: 'c'.repeat(40) },
    { observedAt: 'invalid' }, { evidence: '' }, { unsupported: true }]) {
    await assert.rejects(provider.verifyAbsence({ ...evidence, ...change }, context), /explicit provider audit/);
  }
  await assert.rejects(provider.start({ ...context, retry: { mode: 'new-request', proof: evidence } }), /explicit provider reconciliation/);
  f.transport.listUpdates = async () => [[f.raw]];
  await assert.rejects(provider.verifyAbsence(evidence, context), /conflicts/);
  let pages = 0;
  f.transport.listUpdates = async (_spec, offset) => { pages++; return Array.from({ length: 50 }, (_, index) => [{ group: `other-${offset + index}`, message: 'other' }]); };
  await assert.rejects(provider.verifyAbsence(evidence, context), /exceeded its bound/); assert.equal(pages, 20);
  f.transport.listUpdates = async () => [];
  const proof = await provider.verifyAbsence(evidence, context);
  f.transport.listUpdates = async () => [[f.raw]];
  await assert.rejects(provider.start({ ...context, retry: { mode: 'new-request', proof } }), /conflicts/);
  assert.equal(f.calls.length, 0);
});

test('OTA verifies exact retained bytes and uses skip-bundler publication', async () => {
  const f = otaFixture(); const provider = createEasOtaProvider(f.spec, f.transport);
  const accepted = await provider.start(); assert.equal(accepted.id, groupId);
  assert(f.calls[0].includes('--skip-bundler'));
  assert.deepEqual((await provider.verify(accepted)).payload, f.spec.payload);
  assert.equal((await provider.find()).id, groupId); assert.equal(f.calls.length, 1);
});

test('OTA refuses changed retained bytes before sending a publication request', async () => {
  const f = otaFixture(); f.transport.exportPayload = async () => ({ launch: 'changed', assets: [] });
  await assert.rejects(createEasOtaProvider(f.spec, f.transport).start(), /changed before/);
  assert.equal(f.calls.length, 0);
});

test('OTA rejects downloaded-byte corruption, channel drift, extra groups and changed manifests', async () => {
  const f = otaFixture(); const provider = createEasOtaProvider(f.spec, f.transport);
  f.transport.hashArtifact = async () => 'd'.repeat(64); await assert.rejects(provider.verify({ id: groupId }), /bytes/);
  f.transport.channel = async () => ({ id: 'other', name: 'internal' }); await assert.rejects(provider.find(), /mapping/);
  f.transport.channel = async () => f.spec.branch;
  f.transport.getUpdate = async () => [f.raw, f.raw]; await assert.rejects(provider.status(groupId), /contents/);
  assert.throws(() => verifyEasUpdate({ ...f.raw, runtime: { version: 'other' } }, f.spec), /runtime/);
});

test('retained export hashing rejects traversal and verifies actual bundle/assets', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'release-export-fixture-'));
  try {
    mkdirSync(resolve(directory, 'assets')); writeFileSync(resolve(directory, 'bundle.hbc'), 'bundle'); writeFileSync(resolve(directory, 'assets/icon.png'), 'icon');
    const metadata = { fileMetadata: { android: { bundle: 'bundle.hbc', assets: [{ path: 'assets/icon.png' }] } } };
    writeFileSync(resolve(directory, 'metadata.json'), JSON.stringify(metadata));
    const hash = text => createHash('sha256').update(text).digest('base64url');
    assert.deepEqual(await exportPayload(directory, 'android'), { launch: hash('bundle'), assets: [hash('icon')] });
    metadata.fileMetadata.android.bundle = '../outside'; writeFileSync(resolve(directory, 'metadata.json'), JSON.stringify(metadata));
    await assert.rejects(exportPayload(directory, 'android'), /Unsafe/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('download hashing requires nonempty successful HTTPS content', async () => {
  assert.equal(await hashRemoteArtifact('https://fixture.invalid/artifact', {}, async () => new Response('bytes')), createHash('sha256').update('bytes').digest('hex'));
  await assert.rejects(hashRemoteArtifact('http://fixture.invalid/artifact'), /HTTPS/);
  await assert.rejects(hashRemoteArtifact('https://fixture.invalid/artifact', {}, async () => new Response('', { status: 404 })), /unavailable/);
  await assert.rejects(hashRemoteArtifact('https://fixture.invalid/artifact', {}, async () => new Response('')), /empty/);
});

test('accepted IDs survive failed readback and observation does not claim native completion', async () => {
  const f = fixture(); const provider = createEasBuildProvider(buildSpec, f.transport);
  const read = f.transport.getBuild; f.transport.getBuild = async () => { throw Error('offline'); };
  assert.equal((await provider.start()).id, buildId);
  f.transport.getBuild = read; f.build.status = 'ERRORED';
  const proof = await provider.verify({ id: buildId }, { observe: true });
  assert.equal(proof.status, 'failed'); assert.equal(proof.artifact, undefined);
  await assert.rejects(provider.verify({ id: buildId }), /not finished/);
  f.build.status = 'FINISHED'; f.submission.status = 'ERRORED';
  assert.equal((await createEasSubmissionProvider(f.spec, f.transport).verify({ id: submissionId }, { observe: true })).status, 'failed');
});

test('source-free OTA accepts only branded hosted retained-source proof and never conflicting provider Git data', async () => {
  const directory = mkdtempSync(resolve(tmpdir(), 'release-source-proof-'));
  try {
    writeFileSync(resolve(directory, 'bundle.hbc'), 'bundle');
    const config = { schemaVersion: 1, repository: 'fixture/app', defaultBranch: 'main', components: [
      { id: 'android', kind: 'native', platform: 'android', builder: 'eas' },
      { id: 'android.ota', kind: 'ota', platform: 'android', nativeTarget: 'android', channel: 'internal', environment: 'preview' },
    ] };
    const source = { repository: config.repository, commit: buildSpec.source, workflowCommit: 'b'.repeat(40), toolkitCommit: 'c'.repeat(40) };
    const plan = planRelease({ config, source, origin: { kind: 'github', runId: '123', runAttempt: 1 },
      observations: config.components.map(item => ({ id: item.id, identity: item.id, version: '1.2.3', versionCode: 7, runtime: '1.2.3' })) });
    const receipt = await createArtifactReceipt({ plan, target: 'android.ota', directory });
    const proof = await verifyRetainedArtifact({ plan, target: 'android.ota', directory, receipt, verifyProducer: async () => true, verifyAttestation: async () => true });
    const f = otaFixture(); delete f.raw.gitCommitHash; delete f.raw.isGitWorkingTreeDirty;
    const spec = { ...f.spec, target: 'android.ota', repository: config.repository, sourceProof: proof };
    assert.equal(verifyEasUpdate(f.raw, spec), f.raw);
    assert.throws(() => verifyEasUpdate(f.raw, { ...spec, sourceProof: structuredClone(proof) }), /hosted artifact/);
    assert.throws(() => verifyEasUpdate(f.raw, { ...spec, target: 'ios.ota' }), /hosted artifact/);
    assert.throws(() => verifyEasUpdate(f.raw, { ...spec, source: 'd'.repeat(40) }), /hosted artifact/);
    assert.throws(() => verifyEasUpdate({ ...f.raw, gitCommitHash: 'd'.repeat(40) }, spec), /source/);
    assert.throws(() => verifyEasUpdate({ ...f.raw, isGitWorkingTreeDirty: true }, spec), /source/);
    const nativeReceipt = await createArtifactReceipt({ plan, target: 'android', directory });
    const nativeProof = await verifyRetainedArtifact({ plan, target: 'android', directory, receipt: nativeReceipt, verifyProducer: async () => true, verifyAttestation: async () => true });
    const submitted = fixture(); delete submitted.submission.submittedBuild;
    submitted.transport.cli = async () => `https://expo.dev/accounts/fixture/projects/app/submissions/${submissionId}`;
    const retainedSpec = { ...submitted.spec, owner: 'fixture', slug: 'app', source: plan.source.commit, target: 'android', repository: config.repository,
      sourceProof: nativeProof, artifact: { kind: 'retained-file', origin: plan.origin, path: resolve(directory, 'bundle.hbc'), sha256: digest } };
    const provider = createEasSubmissionProvider(retainedSpec, submitted.transport);
    assert.equal((await provider.start()).id, submissionId); assert.equal(await provider.find(), null);
    assert.deepEqual((await provider.verify({ id: submissionId }, { observe: true })).artifact.origin, plan.origin);
    await assert.rejects(createEasSubmissionProvider({ ...retainedSpec, sourceProof: structuredClone(nativeProof) }, submitted.transport).start(), /producer evidence/);
    writeFileSync(resolve(directory, 'bundle.hbc'), 'changed');
    await assert.rejects(verifyRetainedArtifact({ plan, target: 'android.ota', directory, receipt, verifyProducer: async () => true, verifyAttestation: async () => true }));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('publisher workspace contains JSON metadata only and strips executable app configuration', () => {
  const workspace = createEasPublisherWorkspace({ ...buildSpec, owner: 'fixture', slug: 'app', destination: { track: 'internal', releaseStatus: 'draft' },
    expoConfig: { name: 'Fixture', plugins: ['./untrusted'], hooks: { postPublish: [] }, entryPoint: 'untrusted.js', extra: { publicValue: 'kept' } } });
  try {
    assert.deepEqual(readdirSync(workspace.root).sort(), ['app.json', 'eas.json', 'package.json']);
    const app = JSON.parse(readFileSync(resolve(workspace.root, 'app.json'))).expo;
    assert.equal(app.plugins, undefined); assert.equal(app.hooks, undefined); assert.equal(app.entryPoint, undefined);
    assert.equal(app.extra.publicValue, 'kept'); assert.equal(app.runtimeVersion, buildSpec.runtime);
    assert.equal(app.extra.eas.projectId, buildSpec.projectId);
  } finally { workspace.dispose(); }
});

test('signing preflight enforces selected credentials, distribution, expiry and declared entitlements', async () => {
  const encoded = Buffer.from('cms<plist>fixture</plist>signature').toString('base64');
  const parseProfile = () => ({ Entitlements: { 'com.apple.developer.applesignin': ['Default'] } });
  const app = { androidAppCredentials: [{ androidAppBuildCredentialsList: [{ isDefault: true, androidKeystore: { id: 'key' } }], googleServiceAccountKeyForSubmissions: { id: 'google' } }],
    iosAppCredentials: [{ appleAppIdentifier: { bundleIdentifier: 'app.fixture' }, appStoreConnectApiKeyForSubmissions: { id: 'asc' },
      iosAppBuildCredentialsList: [{ iosDistributionType: 'APP_STORE', distributionCertificate: { id: 'cert' },
        provisioningProfile: { id: 'profile', expiration: '2030-01-01', provisioningProfile: encoded } }] }] };
  const transport = { signingCredentials: async () => app };
  const spec = { ...buildSpec, platform: 'ios', submit: true, destination: { ascAppId: '12345' }, requiredEntitlements: { 'com.apple.developer.applesignin': ['Default'] } };
  assert.equal((await preflightEasSigning(spec, transport, { now: 0, parseProfile })).verified, true);
  await assert.rejects(preflightEasSigning(spec, transport, { now: Date.parse('2031-01-01'), parseProfile }), /unexpired/);
  await assert.rejects(preflightEasSigning({ ...spec, distribution: 'internal' }, transport, { now: 0, parseProfile }), /unexpired/);
  await assert.rejects(preflightEasSigning(spec, transport, { now: 0, parseProfile: () => ({ Entitlements: {} }) }), /entitlement/);
  assert.throws(() => verifyProvisioningProfile('invalid', spec.requiredEntitlements, parseProfile), /decode/);
  assert.equal((await preflightEasSigning({ ...buildSpec, submit: true }, transport)).verified, true);
  delete app.androidAppCredentials[0].googleServiceAccountKeyForSubmissions;
  await assert.rejects(preflightEasSigning({ ...buildSpec, submit: true }, transport), /Play/);
});
