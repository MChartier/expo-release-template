/** @file Fresh history keeps monotonic version floors without importing old provider records or runtime baselines. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { planRelease } from '../src/planner.mjs';
import { GitHubLedger } from '../src/ledger.mjs';

const config = { schemaVersion: 1, repository: 'fixture/app', defaultBranch: 'main', components: [
  { id: 'phone', kind: 'native', builder: 'command', platform: 'android' },
  { id: 'watch', kind: 'native', builder: 'command', platform: 'android' },
], nativeGroups: [['phone', 'watch']], versionGroups: [{ id: 'native', targets: ['phone', 'watch'], codeAllocation: 'global',
  minimumVersion: '1.4.0', minimumCodes: { phone: 17, watch: 18 }, reusePrepared: true,
  lanes: { phone: { modulus: 2, residue: 1 }, watch: { modulus: 2, residue: 0 } } }] };
const input = { config, source: { origin: 'local', repository: config.repository, commit: 'a'.repeat(40), toolkitCommit: 'b'.repeat(40) }, origin: { kind: 'local' },
  observations: config.components.map(value => ({ id: value.id, identity: value.id, version: '1.0.0', versionCode: 1, runtime: '1.0.0' })) };

test('fresh releases exceed explicit version/code floors and retain paired lanes', () => {
  const plan = planRelease(input);
  assert.deepEqual(plan.reservations.native, { version: '1.4.1', codes: { phone: 19, watch: 20 } });
  assert.deepEqual(plan.baseline, {});
  const next = planRelease({ ...input, baseline: { reservations: { native: { version: '1.5.0', codes: { phone: 29, watch: 30 } } } } });
  assert.deepEqual(next.reservations.native, { version: '1.5.1', codes: { phone: 31, watch: 32 } });
});

test('independent platform floors do not transfer Android counters to iOS', () => {
  const independent = structuredClone(config); independent.components[1].platform = 'ios'; independent.nativeGroups = [];
  Object.assign(independent.versionGroups[0], { codeAllocation: 'independent', lanes: {}, minimumCodes: { phone: 100, watch: 5 } });
  const plan = planRelease({ ...input, config: independent });
  assert.deepEqual(plan.reservations.native.codes, { phone: 101, watch: 6 });
});

test('old journals are outside the new history while unfinished new releases still block allocation', async () => {
  const api = async () => { throw Error('Historical data must not be inspected.'); };
  api.pages = async () => [{ id: 1, tag_name: 'release-run-1', draft: true }, { id: 2, tag_name: 'candidate/2', draft: true }];
  const ledger = new GitHubLedger({ config, api });
  assert.deepEqual(await ledger.baseline(), { components: {}, runtimes: {}, reservations: {} });
  api.pages = async () => [{ id: 3, tag_name: 'expo-release-3', draft: true }];
  ledger.read = async () => ({ plan: {}, events: [], release: { draft: true } });
  await assert.rejects(ledger.baseline(), /unfinished release/);
});
