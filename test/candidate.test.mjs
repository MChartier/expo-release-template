/** @file Exact-source validation and merge recovery never replace a moved candidate or infer success from a loose merge SHA. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeCandidate, abandonCandidate } from '../src/candidate.mjs';

function fixture() {
  const source = 'a'.repeat(40); const head = 'b'.repeat(40); const merged = 'c'.repeat(40); const tree = 'd'.repeat(40); const toolkit = 'e'.repeat(40);
  const origin = { kind: 'github', runId: '123', runAttempt: 1 };
  const plan = { source: { repository: 'fixture/app', commit: source, workflowCommit: source, toolkitCommit: toolkit },
    config: { repository: 'fixture/app', defaultBranch: 'main', github: { handlerWorkflow: 'release-handler.yml' } } };
  const candidate = { commit: head, tree, branch: 'release/expo-123', pullNumber: 7 };
  const events = []; const calls = []; let didMerge = false; let loseResponse = false;
  const ledger = { read: async () => ({ events }), append: async (_id, event) => events.push(structuredClone(event)) };
  const pull = { state: 'open', draft: false, head: { repo: { full_name: 'fixture/app' }, ref: candidate.branch, sha: head },
    base: { ref: 'main', sha: source }, merge_commit_sha: merged };
  const api = async (route, options = {}) => {
    calls.push({ route, method: options.method });
    if (route === '/branches/main') return { protected: true, commit: { sha: didMerge ? merged : source } };
    if (route === '/pulls/7') return { ...pull, state: didMerge ? 'closed' : 'open', merged: didMerge };
    if (route === `/git/commits/${head}`) return { parents: [{ sha: source }], tree: { sha: tree } };
    if (route === `/git/commits/${merged}`) return { parents: [{ sha: source }, { sha: head }], tree: { sha: tree } };
    if (route === `/compare/${merged}...${merged}`) return { status: 'identical', merge_base_commit: { sha: merged } };
    if (route === '/actions/runs/123') return { id: 123, run_attempt: 1, repository: { full_name: 'fixture/app' }, head_sha: source,
      head_branch: 'main', event: 'workflow_run', path: '.github/workflows/release-handler.yml', status: didMerge ? 'completed' : 'in_progress',
      referenced_workflows: [{ path: 'MChartier/expo-release-template/.github/workflows/release-handler.yml@' + toolkit, sha: toolkit }] };
    if (route === '/actions/runs/123/jobs?filter=latest&per_page=100') return { total_count: 2,
      jobs: ['source', 'candidate'].map(role => ({ name: `Release validation (${role})`, status: 'completed', conclusion: 'success', run_attempt: 1 })) };
    if (route === '/pulls/7/merge') {
      assert.equal(options.method, 'PUT'); assert.equal(options.body.sha, head); didMerge = true;
      if (loseResponse) throw new Error('lost merge response');
      return { merged: true, sha: merged };
    }
    throw new Error(route);
  };
  return { input: { api, plan, candidate, origin, ledger, releaseId: 1 }, events, calls, pull, merged,
    lose() { loseResponse = true; }, alreadyMerged() { didMerge = true; } };
}

test('lost protected merge response resumes its original checked tree without merging again', async () => {
  const f = fixture(); f.lose();
  await assert.rejects(finalizeCandidate(f.input), /lost merge/);
  assert.equal(f.events[0].type, 'merge-intent');
  assert.equal(await finalizeCandidate({ ...f.input, origin: { kind: 'github', runId: '999', runAttempt: 1 } }), f.merged);
  assert.equal(f.calls.filter(value => value.method === 'PUT').length, 1);
});

test('a merged or moved PR cannot be adopted without original merge intent and exact ancestry', async () => {
  const f = fixture(); f.alreadyMerged();
  await assert.rejects(finalizeCandidate(f.input), /no original exact validated merge intent/);
  const moved = fixture(); moved.pull.head.sha = 'f'.repeat(40);
  await assert.rejects(finalizeCandidate(moved.input), /no longer identifies/);
  assert.equal(moved.calls.some(value => value.method === 'PUT'), false);
});

test('explicit abandonment inspects exact candidate twice and never removes a merged or moved branch', async () => {
  const f = fixture(); const { plan, candidate, ledger } = f.input;
  const state = { release: { id: 1 }, plan, events: [{ ...candidate, type: 'candidate' }] };
  const calls = []; let changed = false;
  const api = async (route, options = {}) => {
    calls.push({ route, method: options.method });
    if (options.method === 'PATCH') { changed = true; return {}; }
    if (options.method === 'DELETE') return {};
    if (route.startsWith('/git/ref/')) return { object: { sha: candidate.commit } };
    return { ...f.pull, merged: false, state: changed ? 'closed' : 'open' };
  };
  await abandonCandidate({ api, ledger, state });
  assert.equal(calls.filter(value => value.method === 'DELETE').length, 1);
  assert.equal(calls.filter(value => value.route.startsWith('/git/ref/')).length, 2);
  for (const altered of [{ merged: true }, { head: { ...f.pull.head, sha: 'f'.repeat(40) } }]) {
    await assert.rejects(abandonCandidate({ api: async () => ({ ...f.pull, ...altered }), ledger, state }), /merged or moved/);
  }
  changed = false;
  await assert.rejects(abandonCandidate({ ledger, state, api: async (route, options) => {
    const value = await api(route, options);
    return changed && !options?.method && route.startsWith('/git/ref/') ? { object: { sha: 'f'.repeat(40) } } : value;
  } }), /changed during cleanup/);
  assert.equal(calls.filter(value => value.method === 'DELETE').length, 1);
});
