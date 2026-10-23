/** @file Behavioral stage execution tests: native handoff, interrupted requests, independent success and immutable merge identities. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { planRelease, finalizePlan, bindMergedPlan } from '../src/planner.mjs';
import { stageContext, completeStage, runProviderStage, recoveryStatus } from '../src/stages.mjs';

/** In-memory journal preserves append order and exercises the real stage/operation implementations. */
function fixture() {
  const source = { repository: 'example/app', commit: 'a'.repeat(40), workflowCommit: 'b'.repeat(40), toolkitCommit: 'c'.repeat(40) };
  const config = { schemaVersion: 1, repository: source.repository, defaultBranch: 'main', components: [
    { id: 'phone', kind: 'native', platform: 'android', builder: 'command' },
    { id: 'watch', kind: 'native', platform: 'android', builder: 'command', after: ['phone'] },
    { id: 'ota', kind: 'ota', platform: 'android', nativeTarget: 'phone', channel: 'internal', environment: 'preview' }
  ] };
  const observations = config.components.map(({ id }) => ({ id, identity: id, runtime: '1.0.0', version: '1.0.0', versionCode: 1 }));
  const reservation = planRelease({ config, source, origin: { kind: 'github', runId: '123', runAttempt: 1 }, observations });
  const plan = finalizePlan(reservation, source, observations);
  const state = { release: { id: '456', draft: true }, plan, events: [], assets: [] };
  const ledger = { read: async () => structuredClone(state), append: async (_id, event) => state.events.push(structuredClone(event)) };
  return { source, reservation, plan, state, ledger, input: { ledger, releaseId: '456' } };
}

test('verified enqueue unlocks OTA while final native success and watch submission still wait', async () => {
  const { input, state } = fixture();
  await completeStage({ ...input, target: 'phone', action: 'build', receipt: { hash: 'retained' } });
  let enqueues = 0;
  const provider = { start: async () => { enqueues++; return { id: 'provider-1' }; },
    status: async id => ({ id, status: 'accepted' }), verify: async () => ({ destination: 'internal', artifact: 'exact' }) };
  await runProviderStage({ ...input, target: 'phone', action: 'submit', provider, handoff: true });
  await completeStage({ ...input, target: 'ota', action: 'export', receipt: { export: 'retained' } });
  assert.equal((await stageContext(input.ledger, input.releaseId, 'ota', 'publish')).complete, false);
  await assert.rejects(stageContext(input.ledger, input.releaseId, 'watch', 'handoff'), /waiting/);
  assert.equal(recoveryStatus(state).summary.completedComponents.includes('phone'), false);
  provider.status = async id => ({ id, status: 'complete' });
  await runProviderStage({ ...input, target: 'phone', action: 'submit', provider });
  assert.equal(enqueues, 1);
  assert.equal(recoveryStatus(state).summary.completedComponents.includes('phone'), true);
});

test('pending observation times out without a second enqueue and resumes by exact ID', async () => {
  const { input, state } = fixture();
  await completeStage({ ...input, target: 'phone', action: 'build', receipt: { hash: 'retained' } });
  let clock = 0; let enqueues = 0;
  const provider = { start: async () => { enqueues++; return { id: 'provider-1' }; },
    status: async id => ({ id, status: 'accepted' }), verify: async () => ({ artifact: 'exact' }) };
  await runProviderStage({ ...input, target: 'phone', action: 'submit', provider, handoff: true });
  await assert.rejects(runProviderStage({ ...input, target: 'phone', action: 'submit', provider, timeoutMs: 10, intervalMs: 5,
    now: () => clock, sleep: async ms => { clock += ms; } }), /remains pending/);
  assert.equal(enqueues, 1);
  assert.equal(recoveryStatus(state).operations['phone:submit'].operationId, 'provider-1');
});

test('lost enqueue remains ambiguous; an empty search cannot restart it', async () => {
  const { input } = fixture();
  await completeStage({ ...input, target: 'phone', action: 'build', receipt: { hash: 'retained' } });
  let enqueues = 0;
  const provider = { start: async () => { enqueues++; throw new Error('lost response'); }, find: async () => null };
  await assert.rejects(runProviderStage({ ...input, target: 'phone', action: 'submit', provider, handoff: true }), /lost response/);
  await assert.rejects(runProviderStage({ ...input, target: 'phone', action: 'submit', provider, handoff: true, retry: true }), /absence from a search/);
  assert.equal(enqueues, 1);
});

test('completed independent OTA survives later native failure and recovery does not replay it', async () => {
  const { input, state } = fixture();
  for (const [target, action] of [['phone', 'build'], ['phone', 'handoff'], ['ota', 'export'], ['ota', 'publish']]) {
    await completeStage({ ...input, target, action, receipt: { identity: `${target}:${action}` } });
  }
  state.events.push({ stage: 'phone:submit', status: 'failed' });
  assert.deepEqual(recoveryStatus(state).summary.completedComponents, ['ota']);
  assert.equal((await stageContext(input.ledger, input.releaseId, 'ota', 'publish')).complete, true);
  await assert.rejects(completeStage({ ...input, target: 'ota', action: 'publish', receipt: { identity: 'changed' } }), /replace/);
});

test('readback cannot replace a retained provider ID or authorize a second request', async () => {
  const { input, state } = fixture();
  await completeStage({ ...input, target: 'phone', action: 'build', receipt: { hash: 'retained' } });
  let enqueues = 0;
  const provider = { start: async () => { enqueues++; return { id: 'original' }; },
    status: async () => ({ id: 'other', status: 'complete' }), verify: async () => ({ artifact: 'exact' }) };
  await assert.rejects(runProviderStage({ ...input, target: 'phone', action: 'submit', provider, handoff: true }), /retained operation ID/);
  await assert.rejects(runProviderStage({ ...input, target: 'phone', action: 'submit', provider, handoff: true }), /retained operation ID/);
  assert.equal(enqueues, 1);
  assert.equal(recoveryStatus(state).operations['phone:submit'].operationId, 'original');
});

test('protected merge binding retains candidate and toolkit identities separately', () => {
  const { reservation, plan, source } = fixture();
  const merged = bindMergedPlan(reservation, plan, { ...source, commit: 'd'.repeat(40) });
  assert.equal(merged.source.commit, 'd'.repeat(40));
  assert.equal(merged.validatedCandidate, source.commit);
  assert.equal(merged.source.workflowCommit, source.workflowCommit);
  assert.equal(merged.source.toolkitCommit, source.toolkitCommit);
  assert.equal(merged.reservationDigest, reservation.digest);
  assert.throws(() => bindMergedPlan(reservation, plan, { ...source, toolkitCommit: 'e'.repeat(40) }), /authority/);
});
