/** @file Durable reservations and target-specific success; uncertain requests never authorize retries. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { github, historyFrom, reserve, begin, complete, operationPayload, loadHistory } from '../src/github.mjs';
import { plan } from './helpers.mjs';

/** Deterministic GitHub API stand-in which records ordering without networking. */
function client({ deployments = [], states = {}, failAt } = {}) {
  const calls = [];
  return { calls,
    async pages(route) { calls.push(['pages', route]); return deployments; },
    async api(method, route, body) {
      calls.push([method, route, body]);
      if (failAt?.(method, route)) throw new Error('connection lost');
      if (route.includes('/statuses?')) return states[route.split('/')[1]] === undefined ? [] : [{ state: states[route.split('/')[1]] }];
      if (route === 'git/tags') return { sha: 'd'.repeat(40) };
      return { id: 42 };
    },
    async evidence(id, name, body) { calls.push(['evidence', id, name, body]); if (failAt?.('evidence', name)) throw new Error('connection lost'); }
  };
}

test('reservation writes immutable annotated tags before evidence', async () => {
  const fake = client(), value = plan(); await reserve(fake, value);
  const refs = fake.calls.filter(([method, route]) => method === 'POST' && route === 'git/refs');
  assert.deepEqual(refs.map(call => call[2].ref), [
    'refs/tags/expo-release/v3/run/123', 'refs/tags/expo-release/v3/mobile/v1.0.0', 'refs/tags/expo-release/v3/server/v1.2.4'
  ]);
  assert.equal(fake.calls.at(-1)[0], 'evidence'); assert.equal(fake.calls.at(-1)[2], 'plan.json');
  assert.equal(fake.calls.filter(call => call[0] === 'PATCH').length, 0);
  const tag = JSON.parse(fake.calls[0][2].message);
  assert.equal(tag.build, value.build); assert.equal(tag.family, value.observation.family);
});

test('lost reservation acknowledgement is not repeated', async () => {
  const fake = client({ failAt: (_, route) => route === 'git/refs' });
  await assert.rejects(reserve(fake, plan()), /connection lost/);
  assert.equal(fake.calls.filter(call => call[1] === 'git/refs').length, 1);
  assert.ok(!fake.calls.some(call => call[1] === 'releases'));
});

test('known reservations consume failures independently of success baselines', () => {
  const value = plan();
  const records = [1, 2, 3].map(n => ({ format: 3, source: value.source, run: String(n), versions: { mobile: `1.${n}.0`, server: `0.0.${n}` }, family: 'native', pairCodeFloor: n * 2 }));
  const successful = operationPayload(value, 'build/android');
  const result = historyFrom(records, [{ payload: { ...successful, key: 'production/submit/android' }, state: 'pending' }, { payload: successful, state: 'success' }]);
  assert.equal(result.mobile.version, '1.3.0'); assert.equal(result.mobile.pairCodeFloor, 6);
  assert.deepEqual(result.pending, ['production/submit/android']);
  assert.equal(result.baselines['production/build/android'].runtime, '1');
  assert.equal(result.baselines['production/js/android'].input, 'js-A');
});

test('server failure cannot erase a successful mobile baseline or vice versa', () => {
  const value = plan();
  const result = historyFrom([], [
    { payload: operationPayload(value, 'deploy/server'), state: 'failure' },
    { payload: operationPayload(value, 'ota/android'), state: 'success' },
    { payload: { ...operationPayload(value, 'deploy/server'), input: 'old-server' }, state: 'success' }
  ]);
  assert.equal(result.baselines['production/deploy/server'].input, 'old-server');
  assert.equal(result.baselines['production/js/android'].input, 'js-A');
  assert.deepEqual(result.pending, []);
});

test('OTA reservations cannot erase earlier paired build-number reservations in either history order', () => {
  const records = [
    { format: 3, source: 'source', run: '1', versions: { mobile: '1.0.0' }, family: 'native', pairCodeFloor: 20 },
    { format: 3, source: 'source', run: '2', versions: { mobile: '1.0.1' }, family: 'native', pairCodeFloor: 0 },
  ];
  for (const order of [records, [...records].reverse()]) {
    const result = historyFrom(order, []);
    assert.equal(result.mobile.version, '1.0.1');
    assert.equal(result.mobile.pairCodeFloor, 20);
  }
});

test('latest successful native embedded bundle supersedes an earlier OTA baseline', () => {
  const value = plan();
  const result = historyFrom([], [
    { payload: { ...operationPayload(value, 'build/android'), bundleInput: 'reverted-js' }, state: 'success' },
    { payload: { ...operationPayload(value, 'ota/android'), input: 'old-ota' }, state: 'success' }
  ]);
  assert.equal(result.baselines['production/js/android'].input, 'reverted-js');
});

test('unknown, missing, error, and inactive status all remain outstanding', () => {
  for (const state of [undefined, 'pending', 'in_progress', 'queued', 'error', 'inactive']) {
    const result = historyFrom([], [{ payload: operationPayload(plan(), 'ota/ios'), state }]);
    assert.deepEqual(result.pending, ['production/ota/ios']);
    assert.deepEqual(result.baselines, {});
  }
});

test('intent is saved before the caller may invoke its provider', async () => {
  const fake = client(), value = plan();
  assert.equal(await begin(fake, value, 'ota/android'), 42);
  assert.equal(fake.calls.at(-1)[1], 'deployments');
  assert.equal(fake.calls.at(-1)[2].ref, value.build);
  assert.deepEqual(fake.calls.at(-1)[2].required_contexts, []);
  assert.equal(fake.calls.at(-1)[2].auto_merge, false);
});

test('an outstanding request prevents creation of another intent', async () => {
  for (const state of [undefined, 'pending', 'in_progress', 'error', 'inactive']) {
    const fake = client({ deployments: [{ id: 9, payload: { run: 'older' } }], states: { 9: state } });
    await assert.rejects(begin(fake, plan(), 'ota/android'), /unresolved/);
    assert.equal(fake.calls.filter(call => call[0] === 'POST').length, 0);
  }
});

test('same-run duplicate is rejected even after completed success', async () => {
  const fake = client({ deployments: [{ id: 9, payload: { run: '123' } }], states: { 9: 'success' } });
  await assert.rejects(begin(fake, plan(), 'ota/android'), /already attempted/);
});

test('operator-confirmed failure allows a new run, not an implicit automatic retry', async () => {
  const fake = client({ deployments: [{ id: 9, payload: { run: 'older' } }], states: { 9: 'failure' } });
  assert.equal(await begin(fake, plan(), 'ota/android'), 42);
});

test('immutable evidence precedes success and failure leaves the intent outstanding', async () => {
  const fake = client(); await complete(fake, plan(), 'ota/ios', 77, { id: 'provider' });
  assert.deepEqual(fake.calls.map(call => call[0]), ['GET', 'evidence', 'POST']);
  assert.equal(fake.calls.at(-1)[2].auto_inactive, false);
  const failed = client({ failAt: method => method === 'evidence' });
  await assert.rejects(complete(failed, plan(), 'ota/ios', 77, {}));
  assert.ok(!failed.calls.some(call => call[0] === 'POST'));
});

test('legacy records cannot become current baselines or reservations', () => {
  assert.throws(() => historyFrom([{ schemaVersion: 1 }], []), /Legacy/);
  assert.throws(() => historyFrom([], [{ payload: { schemaVersion: 1 }, state: 'success' }]), /Legacy/);
});

test('history reads only the fresh namespace and rejects lightweight reservation tags', async () => {
  const fake = { pages: async () => [], api: async (_, route) => {
    assert.equal(route, 'git/matching-refs/tags/expo-release/v3/run/'); return [{ object: { type: 'commit' } }];
  } };
  await assert.rejects(loadHistory(fake), /annotated/);
});

test('transport never retries writes or interprets permission failure as absence', async () => {
  let requests = 0;
  const api = github('owner/app', { token: 'test', fetcher: async () => { requests++; return { ok: false, status: 403 }; } });
  await assert.rejects(api.api('POST', 'deployments', {}), /403/); assert.equal(requests, 1);
  await assert.rejects(api.pages('deployments'), /403/); assert.equal(requests, 2);
});

test('pagination reads beyond the first page and evidence conflicts are errors', async () => {
  const api = github('owner/app', { token: 'test', fetcher: async (url, options) => {
    if (options.method === 'POST') return { ok: false, status: 422 };
    return { ok: true, status: 200, json: async () => url.endsWith('page=1') ? Array(100).fill({}) : [{ id: 101 }] };
  } });
  assert.equal((await api.pages('deployments')).length, 101);
  await assert.rejects(api.evidence(1, 'plan.json', {}), /422/);
});
