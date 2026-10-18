/** @file Cross-consumer selection and interruption contracts for the shared release implementation. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { planRelease, completedBaseline, finalizePlan } from '../src/planner.mjs';
import { sourceEnvironment, runHook } from '../src/hooks.mjs';
import { executeOperation, latestOperation } from '../src/operations.mjs';
import { canRunStage } from '../packages/release-engine/index.mjs';

const sha = value => value.repeat(40);
const source = { repository: 'example/app', commit: sha('a'), workflowCommit: sha('b'), toolkitCommit: sha('c') };
const origin = { kind: 'github', runId: '123', runAttempt: 1 };
const observations = ids => ids.map(id => ({ id, identity: `${id}-inputs`, version: '1.2.3', versionCode: id === 'watch' ? 18 : 17, runtime: 'runtime-1' }));

/** A configured Android cohort models paired releases without selecting by application name. */
function paired() {
  return { schemaVersion: 1, repository: 'example/app', defaultBranch: 'master', components: [
    { id: 'server', kind: 'server' },
    { id: 'phone', kind: 'native', platform: 'android', builder: 'command', runtimePolicy: 'fingerprint' },
    { id: 'watch', kind: 'native', platform: 'android', builder: 'command', after: ['phone'] },
    { id: 'internal', kind: 'ota', platform: 'android', nativeTarget: 'phone', channel: 'internal', environment: 'preview' },
    { id: 'production', kind: 'ota', platform: 'android', nativeTarget: 'phone', channel: 'production', environment: 'production', after: ['internal'] }
  ], nativeGroups: [['phone', 'watch']], dependencies: [{ component: 'phone', requires: ['server'] }],
  versionGroups: [{ id: 'native', targets: ['phone', 'watch'], bump: 'patch', codeAllocation: 'global', minimumCode: 12,
    lanes: { phone: { modulus: 2, residue: 1 }, watch: { modulus: 2, residue: 0 } } }],
  deployment: { type: 'wireguard-webhook' } };
}

/** Mark all graph stages complete to build a verified independent baseline fixture. */
function baselineFor(config) {
  const plan = planRelease({ config, source, origin, observations: observations(config.components.map(item => item.id)) });
  return completedBaseline(plan, plan.graph.stages.map(stage => ({ stage: stage.id, status: 'complete' })));
}

test('unchanged input is a no-op while a watch change selects its cohort and real dependencies', () => {
  const config = paired();
  const observed = observations(config.components.map(item => item.id));
  const baseline = baselineFor(config);
  assert.equal(planRelease({ config, source, origin, observations: observed, baseline }).selection.noop, true);
  observed.find(item => item.id === 'watch').identity = 'new-watch-input';
  const plan = planRelease({ config, source, origin, observations: observed, baseline });
  assert.deepEqual(plan.selection.selected, ['internal', 'phone', 'production', 'server', 'watch']);
  assert.equal(plan.components.find(item => item.id === 'phone').next.versionCode, 21);
  assert.equal(plan.components.find(item => item.id === 'watch').next.versionCode, 22);
});

test('phone handoff unlocks OTA, phone completion unlocks watch, and failure preserves completed OTA', () => {
  const config = paired();
  const plan = planRelease({ config, source, origin, observations: observations(config.components.map(item => item.id)) });
  const completed = ['server:build', 'server:publish', 'server:deploy', 'phone:build', 'watch:build', 'phone:handoff', 'internal:export'];
  const receipts = completed.map(stage => ({ stage, status: 'complete' }));
  assert.equal(canRunStage(plan.graph, 'internal:publish', receipts), true);
  assert.equal(canRunStage(plan.graph, 'watch:handoff', receipts), false);
  receipts.push({ stage: 'internal:publish', status: 'complete' }, { stage: 'phone:submit', status: 'failed' });
  const baseline = completedBaseline(plan, receipts);
  assert.ok(Object.keys(baseline.components).some(key => key.startsWith('internal|')));
  assert.ok(!Object.keys(baseline.components).some(key => key.startsWith('phone|')));
  assert.equal(baseline.reservations.native.codes.watch, 20);
});

test('independent appVersion targets retain native-only selection policy without a forced runtime migration', () => {
  const config = { schemaVersion: 1, repository: 'example/app', defaultBranch: 'main', policy: { otaForNewRuntime: false },
    components: [
      { id: 'android', kind: 'native', platform: 'android', builder: 'eas', runtimePolicy: 'appVersion' },
      { id: 'ios', kind: 'native', platform: 'ios', builder: 'eas', runtimePolicy: 'appVersion' },
      { id: 'ota', kind: 'ota', platform: 'android', nativeTarget: 'android', channel: 'internal', environment: 'preview' }
    ], versionGroups: [{ id: 'native', targets: ['android', 'ios'], codeAllocation: 'independent', bump: 'requested' }] };
  const observed = observations(['android', 'ios', 'ota']);
  const baseline = baselineFor(config);
  observed[0].identity = 'new-android';
  const plan = planRelease({ config, source, origin, observations: observed, baseline, bump: 'minor' });
  assert.deepEqual(plan.selection.selected, ['android']);
  assert.equal(plan.components[0].next.version, '1.3.0');
  assert.equal(plan.components[1].next, undefined);
  assert.ok(!plan.graph.stages.some(stage => stage.id.includes('deploy')));
});

test('production-only OTA does not replay internal publication or server deployment', () => {
  const config = paired();
  const observed = observations(config.components.map(item => item.id));
  const baseline = baselineFor(config);
  observed.find(item => item.id === 'production').identity = 'changed-environment';
  const plan = planRelease({ config, source, origin, observations: observed, baseline });
  assert.deepEqual(plan.selection.selected, ['production']);
  assert.deepEqual(plan.graph.stages.map(stage => stage.id), ['production:export', 'production:publish']);
});

test('final candidate must supply its allocated versions and actual runtime', () => {
  const config = paired();
  const observed = observations(config.components.map(item => item.id));
  const plan = planRelease({ config, source, origin, observations: observed });
  assert.throws(() => finalizePlan(plan, source, observed), /allocation/);
  const prepared = observed.map(item => ({ ...item, ...plan.components.find(component => component.id === item.id).next }));
  const result = finalizePlan(plan, { ...source, commit: sha('d') }, prepared);
  assert.equal(result.prepared, true);
  assert.equal(result.requestedSource.commit, source.commit);
});

test('local plans cannot fabricate hosted evidence and source hooks lose publishing capabilities', () => {
  const config = paired();
  assert.throws(() => planRelease({ config, source, origin: { kind: 'local' }, observations: observations(config.components.map(item => item.id)) }), /hosted/);
  const { workflowCommit, ...localSource } = source;
  const local = planRelease({ config, source: { ...localSource, origin: 'local' }, origin: { kind: 'local' }, observations: observations(config.components.map(item => item.id)) });
  assert.equal(local.source.workflowCommit, undefined);
  assert.deepEqual(sourceEnvironment({ PATH: 'tools', EXPO_TOKEN: 'hidden', OPENAI_API_KEY: 'hidden', NODE_OPTIONS: '--import=evil', SSH_AUTH_SOCK: 'agent', GITHUB_OUTPUT: 'command-file', ACTIONS_ID_TOKEN_REQUEST_URL: 'hidden' }, { PUBLIC_ORIGIN: 'https://example.test', TEST_PGPASSWORD: 'disposable' }), { PATH: 'tools', PUBLIC_ORIGIN: 'https://example.test', TEST_PGPASSWORD: 'disposable' });
  assert.throws(() => runHook({ hooks: { inspect: { command: ['node', 'hook.mjs'] } } }, 'inspect', {}, { execute: () => '{"schemaVersion":99}' }), /unsupported schema/);
});

/** In-memory append-only ledger models interruption boundaries without provider credentials. */
function ledger() {
  return { events: [], async read() { return { events: structuredClone(this.events) }; },
    async append(id, event) { this.events.push(structuredClone(event)); } };
}

test('lost enqueue response retains unknown intent and an empty search cannot trigger another enqueue', async () => {
  const store = ledger(); let calls = 0;
  const provider = { async start() { calls += 1; throw new Error('Connection lost'); }, async find() { return null; } };
  const args = { ledger: store, releaseId: '1', stage: 'phone:handoff', provider, context: { digest: 'immutable' } };
  await assert.rejects(executeOperation(args), /Connection lost/);
  assert.equal(latestOperation(store.events, args.stage).status, 'unknown');
  await assert.rejects(executeOperation(args), /does not authorize/);
  assert.equal(calls, 1);
});

test('provider ID survives readback interruption and completion observes that same request', async () => {
  const store = ledger(); let calls = 0; let online = false;
  const provider = { async start() { calls += 1; return { id: 'request-1' }; },
    async status(id) { if (!online) throw new Error('Readback outage'); return { id, status: 'complete' }; },
    async verify(value) { return { providerId: value.id, artifactHash: 'verified-hash' }; } };
  const args = { ledger: store, releaseId: '1', stage: 'phone:handoff', provider, context: { digest: 'immutable' } };
  await assert.rejects(executeOperation(args), /Readback outage/);
  assert.equal(latestOperation(store.events, args.stage).operationId, 'request-1');
  online = true;
  assert.equal((await executeOperation(args)).status, 'complete');
  assert.equal(calls, 1);
});

test('a retained failure never authorizes retry without fresh provider transport proof', async () => {
  const store = ledger(); let calls = 0;
  const provider = { async start() { calls += 1; return { id: `request-${calls}` }; },
    async status(id) { return { id, status: 'failed' }; }, async verify(value) { return { id: value.id, rejected: true }; },
    async prepareRetry() { return { mode: 'provider-retry', proof: { observedNow: true, canRetry: true } }; } };
  const args = { ledger: store, releaseId: '1', stage: 'phone:handoff', provider, context: { digest: 'immutable' } };
  await executeOperation(args);
  await assert.rejects(executeOperation(args), /explicit retry/);
  const next = await executeOperation({ ...args, retry: true });
  assert.equal(next.history[0].operationId, 'request-1');
  assert.equal(next.history[0].retryProof.canRetry, true);
  assert.equal(calls, 2);
});
