/** @file Read-only characterization of the real held paired release; no provider transport or release mutation is allowed. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { calibrateReader } from '../src/compat/calibrate.mjs';

const directory = new URL('./fixtures/calibrate-held/', import.meta.url);
const json = name => JSON.parse(fs.readFileSync(new URL(name, directory), 'utf8').replace(/^\uFEFF/, ''));
const release = json('release.json');
const record = JSON.parse(release.body);
const run = json('run.json');
const config = { repository: record.repository, defaultBranch: 'master', defaultProfile: 'production', components: [],
  legacy: { format: 'calibrate-v1', defaultBranch: 'master', handlerWorkflow: '.github/workflows/cut-release-handler.yml', recoveryWorkflow: '.github/workflows/publish-release-handler.yml' } };

/** Only fixture GETs are supported; any attempt to mutate or consult a live provider fails the test. */
async function api(route) {
  if (route === `/actions/runs/${record.run_id}`) return run;
  const asset = release.assets.find(value => route === `/releases/assets/${value.id}`);
  assert.ok(asset, `Unexpected historical request ${route}`);
  return fs.readFileSync(new URL(asset.name, directory));
}

test('held 17/18 pair preserves its original source/run, failed phone ID and partial server success', async () => {
  const state = await calibrateReader.read({ release, record, assets: release.assets, api, config });
  assert.equal(state.resolved, false);
  assert.equal(state.plan, null);
  assert.deepEqual(state.record, record);
  assert.deepEqual(state.summary.completedComponents, ['server']);
  assert.equal(state.baseline.reservations.native.codes.phone, 17);
  assert.equal(state.baseline.reservations.native.codes.wear, 18);
  assert.equal(state.recovery.providerIds['phone-submit'], '602c0864-a253-4133-ac26-6f8a2f4de11e');
  assert.equal(state.events.findLast(event => event.stage === 'phone-submit').operation.status, 'unknown');
  assert.equal(state.recovery.originalRunId, '38338448015');
  assert.equal(state.nativeMetadata.workflow_sha, record.workflow_sha);
});

test('historical metadata substitution and replacement producing runs are rejected', async () => {
  const args = { release, record, assets: release.assets, config };
  await assert.rejects(calibrateReader.read({ ...args, api: async route => route.includes('releases/assets/')
    && release.assets.find(value => route.endsWith(`/${value.id}`))?.name === 'native-metadata.json' ? Buffer.from('{}') : api(route) }), /hash differs/);
  await assert.rejects(calibrateReader.read({ ...args, api: async route => route.includes('/actions/runs/') ? { ...run, path: '.github/workflows/release-handler.yml' } : api(route) }), /original workflow contract/);
});
