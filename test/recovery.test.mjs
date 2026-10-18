/** @file Recovery preserves frozen sources and independent success, observes lost responses without enqueue, and blocks retirement while any provider suboperation is unresolved. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { planRelease, finalizePlan } from '../src/planner.mjs';
import { reduceOperation } from '../packages/release-engine/index.mjs';
import { inspectRecovery, recoverRelease } from '../src/recovery.mjs';
import { createDeploymentProvider } from '../src/providers/deploy.mjs';
import { executeOperation } from '../src/operations.mjs';

function fixture() {
  const source = { repository: 'fixture/app', commit: 'a'.repeat(40), workflowCommit: 'b'.repeat(40), toolkitCommit: 'c'.repeat(40) };
  const config = { schemaVersion: 1, repository: source.repository, defaultBranch: 'master', components: [
    { id: 'android', kind: 'native', platform: 'android', builder: 'eas', submit: false },
    { id: 'ios', kind: 'native', platform: 'ios', builder: 'eas', submit: false }] };
  const observations = config.components.map(({ id }) => ({ id, identity: id, runtime: '1.0.0', version: '1.0.0', versionCode: 1 }));
  const original = planRelease({ config, source, origin: { kind: 'github', runId: '123', runAttempt: 1 }, observations });
  const plan = finalizePlan(original, source, observations);
  const state = { release: { id: 456, draft: true }, plan, events: [{ stage: 'ios:build', status: 'complete', receipt: { artifact: 'retained-success' } }] };
  const ledger = { read: async () => structuredClone(state), append: async (_id, event) => state.events.push(structuredClone(event)),
    finish: async (_id, options) => { state.release.draft = false; state.finished = options; } };
  const add = (stage, events = []) => {
    let operation = reduceOperation(null, { type: 'intent', operationKey: stage, request: { planDigest: plan.digest, source: source.commit } });
    for (const event of events) operation = reduceOperation(operation, event);
    state.events.push({ stage, status: operation.status, operation }); return operation;
  };
  return { state, ledger, add, input: { ledger, releaseId: 456 } };
}

test('deployment timeout needs attempt-bound operator evidence; healthy reconciliation never posts and absence needs explicit retry', async () => {
  for (const outcome of ['healthy', 'not-started']) {
    const f = fixture(); const stage = 'android:build-provider'; let posts = 0;
    const spec = { service: 'fixture' }; const context = { planDigest: f.state.plan.digest, source: f.state.plan.source.commit };
    const provider = createDeploymentProvider(spec, { transport: () => { posts++; if (posts === 1) throw new Error('timeout'); return { service: 'fixture', healthy: true }; } });
    await assert.rejects(executeOperation({ ...f.input, stage, provider, context }), /timeout/);
    await assert.rejects(executeOperation({ ...f.input, stage, provider, context }), /absence from a search/);
    const proof = { confirmed: true, outcome, service: 'fixture', planDigest: context.planDigest, operationKey: stage, attempt: 1,
      evidence: 'Operator reviewed the exact service logs for this request.', observedAt: '2026-10-18T00:00:00Z',
      ...(outcome === 'healthy' ? { body: { service: 'fixture', status: 'succeeded', healthy: true } } : {}) };
    const evidenceKey = outcome === 'healthy' ? 'health' : 'absence';
    const args = { ...f.input, providerForStage: async () => provider, request: { action: 'reconcile', stage, [evidenceKey]: proof } };
    await assert.rejects(recoverRelease({ ...args, request: { ...args.request, [evidenceKey]: { ...proof, attempt: 2 } } }), /exact request attempt/);
    await recoverRelease(args); assert.equal(posts, 1);
    if (outcome === 'not-started') {
      await assert.rejects(executeOperation({ ...f.input, stage, provider, context }), /explicit retry/);
      const complete = await executeOperation({ ...f.input, stage, provider, context, retry: true });
      assert.equal(complete.attempt, 2); assert.equal(posts, 2); assert.equal(complete.history.length, 1);
    } else {
      const complete = await executeOperation({ ...f.input, stage, provider, context });
      assert.equal(complete.status, 'complete'); assert.equal(complete.receipt.healthy, true); assert.equal(posts, 1);
      assert.equal(complete.receipt.imageDigest, undefined);
    }
  }
});

test('resume retains the exact plan and successful independent stages across a newer recovery workflow', async () => {
  const f = fixture(); f.ledger.workflowCommit = 'd'.repeat(40);
  const original = structuredClone(f.state.plan); const success = structuredClone(f.state.events[0]);
  const result = await recoverRelease({ ...f.input, request: { action: 'resume', planDigest: original.digest } });
  assert.deepEqual(result.plan, original); assert.deepEqual(f.state.events[0], success);
  assert(!result.stages.includes('ios:build')); assert.equal(f.state.events.at(-1).stage, undefined);
  await assert.rejects(recoverRelease({ ...f.input, request: { action: 'resume', planDigest: 'other' } }), /digest differs/);
});

test('reconcile an accepted cloud build observes its exact ID without enqueueing or completing artifact retention', async () => {
  const f = fixture(); f.add('android:build-provider', [{ type: 'accepted', operationId: 'build-1' }]);
  const result = await recoverRelease({ ...f.input, request: { action: 'reconcile', stage: 'android:build-provider' },
    providerForStage: async () => ({ start: () => assert.fail('must not enqueue'), status: async id => ({ id, status: 'complete' }),
      verify: async observed => ({ id: observed.id, sha256: 'e'.repeat(64) }) }) });
  assert.equal(result.operations['android:build-provider'].status, 'complete');
  assert(result.summary.remaining.includes('android:build'));
});

test('unknown result can attach only a freshly verified exact provider ID', async () => {
  const f = fixture(); f.add('android:build-provider');
  const args = { ...f.input, request: { action: 'reconcile', stage: 'android:build-provider', operationId: 'build-1' },
    providerForStage: async () => ({ status: async id => ({ id, status: 'accepted' }), verify: async () => ({ source: f.state.plan.source.commit }) }) };
  await recoverRelease(args);
  assert.equal((await inspectRecovery(f.input)).operations['android:build-provider'].operationId, 'build-1');
  await assert.rejects(recoverRelease({ ...args, request: { ...args.request, operationId: 'build-2' } }), /replace/);
});

test('empty searches and wrong observed IDs do not authorize lost-response retry', async () => {
  const f = fixture(); f.add('android:build-provider');
  const request = { action: 'reconcile', stage: 'android:build-provider' };
  await assert.rejects(recoverRelease({ ...f.input, request, providerForStage: async () => ({ find: async () => null }) }), /empty search/);
  await assert.rejects(recoverRelease({ ...f.input, request: { ...request, operationId: 'one' },
    providerForStage: async () => ({ status: async () => ({ id: 'two' }) }) }), /exact provider/);
  assert.equal(f.state.events.length, 2);
});

test('abandon checks cloud and per-runtime operations outside the canonical graph', async () => {
  for (const stage of ['android:build-provider', `ota:publish:runtime-${'f'.repeat(64)}`]) {
    const f = fixture(); f.add(stage, [{ type: 'accepted', operationId: 'provider-id' }]);
    await assert.rejects(recoverRelease({ ...f.input, request: { action: 'abandon', reason: 'Explicitly abandon remaining test release work.' } }), /every provider/);
    assert.equal(f.state.release.draft, true);
  }
});

test('absence needs provider proof and never applies to a known ID', async () => {
  const f = fixture(); f.add('android:build-provider');
  const result = await recoverRelease({ ...f.input, request: { action: 'reconcile', stage: 'android:build-provider', absence: { request: 'reviewed' } },
    providerForStage: async () => ({ verifyAbsence: async () => ({ provider: 'verified-absence' }) }) });
  assert.equal(result.operations['android:build-provider'].status, 'failed');
  const retry = await recoverRelease({ ...f.input, request: { action: 'retry', stage: 'android:build-provider' } });
  assert.equal(retry.retry, true); assert.equal(retry.plan.digest, f.state.plan.digest);
});

test('unsupported or conflicting correction evidence cannot silently fall through to ordinary observation', async () => {
  const f = fixture(); f.add('android:build-provider', [{ type: 'accepted', operationId: 'build-1' }]);
  const input = { ...f.input, providerForStage: async () => ({ status: () => assert.fail('must reject before readback') }),
    request: { action: 'reconcile', stage: 'android:build-provider', destination: { confirmed: true } } };
  await assert.rejects(recoverRelease(input), /cannot correct/);
  await assert.rejects(recoverRelease({ ...input, request: { ...input.request, health: {} } }), /one reconciliation/);
});

test('completion cannot skip missing stages and finalized releases cannot resume', async () => {
  const f = fixture(); await assert.rejects(recoverRelease({ ...f.input, request: { action: 'complete' } }), /every selected/);
  f.state.release.draft = false;
  await assert.rejects(recoverRelease({ ...f.input, request: { action: 'resume' } }), /unresolved draft/);
});

test('legacy journals require their compatibility contract rather than a synthesized common plan', async () => {
  const f = fixture(); f.state.legacy = true; f.state.legacyPlan = { schema: 1, source: 'a'.repeat(40) };
  await assert.rejects(recoverRelease({ ...f.input, request: { action: 'resume' } }), /compatibility/);
  const result = await recoverRelease({ ...f.input, request: { action: 'resume' }, legacyAdapter: { recover: async ({ state }) => state.legacyPlan } });
  assert.deepEqual(result, f.state.legacyPlan);
});
