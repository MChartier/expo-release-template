/** @file Tests the isolated read-only EAS evidence adapter without provider access or publication credentials. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createEasEvidence } from '../src/providers/eas-api.mjs';

test('private build/submission readback preserves associations and exact archive evidence', async () => {
  const calls = [];
  const build = { id: 'build', submissions: [{ id: 'submission' }], artifacts: { applicationArchiveUrl: 'https://example.invalid/build' } };
  const client = { query(document, variables, options) {
    assert.match(document, /^query /); assert.equal(variables.id, 'submission'); assert.equal(options.noRetry, true);
    return { toPromise: async () => ({ data: { submissions: { byId: { id: 'submission', archiveUrl: 'https://example.invalid/exact' } } } }) };
  } };
  const modules = {
    'user/SessionManager.js': { default: class { getAccessToken() { throw Error('Ambient authentication must not override explicit token'); } } },
    'commandUtils/context/contextUtils/createGraphqlClient.js': { createGraphqlClient: options => { assert.equal(options.accessToken, 'fixture'); return client; } },
    'graphql/queries/BuildQuery.js': { BuildQuery: { withSubmissionsByIdAsync: async (_client, id, options) => { calls.push(id); assert.equal(options.useCache, false); return build; } } },
    'graphql/queries/SubmissionQuery.js': { SubmissionQuery: { byIdWithSubmittedBuildAsync: async (_client, id) => ({ id, submittedBuild: build, canRetry: false }) } },
  };
  const api = createEasEvidence({ env: { EXPO_TOKEN: 'fixture' }, loadModule: name => { assert.ok(modules[name]); return modules[name]; } });
  assert.deepEqual(await api.getBuild('build'), build);
  assert.deepEqual(await api.getSubmission('submission'), { id: 'submission', submittedBuild: build, canRetry: false, archiveUrl: 'https://example.invalid/exact' });
  assert.deepEqual(calls, ['build']);
  assert.equal(api.publish, undefined); assert.equal(api.start, undefined);
});

test('channel evidence rejects paused, conditional or mismatched runtime destinations', async () => {
  let channel = { isPaused: false, updateBranches: [{ id: 'branch', name: 'production' }], branchMapping: JSON.stringify({ data: [{ branchId: 'branch', branchMappingLogic: 'true' }] }) };
  const api = createEasEvidence({ env: { EXPO_TOKEN: 'fixture' }, loadModule: name => name.includes('SessionManager') ? { default: class {} }
    : name.includes('createGraphqlClient') ? { createGraphqlClient: () => ({}) }
      : { ChannelQuery: { viewUpdateChannelAsync: async (_client, spec) => { assert.equal(spec.appId, 'project'); return channel; } } } });
  const spec = { projectId: 'project', channel: 'production' };
  assert.deepEqual(await api.channel(spec), { id: 'branch', name: 'production' });
  channel = { ...channel, isPaused: true }; await assert.rejects(api.channel(spec), /active unconditional/);
  channel = { ...channel, isPaused: false, branchMapping: JSON.stringify({ data: [{ branchId: 'other', branchMappingLogic: 'true' }] }) };
  await assert.rejects(api.channel(spec), /mapping conflicts/);
});
