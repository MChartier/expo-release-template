/** @file Local upload recovery cannot duplicate ambiguous requests or promote local receipts into hosted authority. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { planRelease, finalizePlan } from '../src/planner.mjs';
import { createArtifactReceipt } from '../src/artifacts.mjs';
import { GitHubLedger, writeLocalReceipt } from '../src/ledger.mjs';
import { localSubmissionPlan, submitLocally, verifyLocalBuild } from '../src/local-submit.mjs';
import { inspectRecovery } from '../src/recovery.mjs';

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-submit-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const credential = path.join(os.tmpdir(), `local-play-${path.basename(root)}.json`);
  fs.writeFileSync(credential, '{}'); t.after(() => fs.rmSync(credential, { force: true }));
  const config = { schemaVersion: 1, repository: 'fixture/app', defaultBranch: 'main', profiles: { local: { execution: 'local' } },
    components: [{ id: 'z-phone', kind: 'native', platform: 'android', builder: 'command', applicationId: 'app.fixture', submit: false },
      { id: 'a-watch', kind: 'native', platform: 'android', builder: 'command', applicationId: 'app.fixture', after: ['z-phone'], submit: false }],
    versionGroups: [{ id: 'native', targets: ['z-phone', 'a-watch'] }],
    local: { submissions: { 'z-phone': { track: 'internal' }, 'a-watch': { track: 'wear:internal' } } } };
  const source = { repository: config.repository, commit: 'a'.repeat(40), toolkitCommit: 'b'.repeat(40), origin: 'local' };
  const observations = config.components.map((value, index) => ({ id: value.id, identity: value.id, version: '1.2.3', runtime: '1.2.3', versionCode: 17 + index }));
  const reserved = planRelease({ config, source, origin: { kind: 'local' }, observations, profile: 'local', operation: 'build' });
  const plan = finalizePlan(reserved, source, observations);
  const artifacts = await Promise.all(plan.components.filter(value => value.selected).map(async component => {
    const directory = path.join(root, component.id); fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'native.aab'), component.id);
    return { target: component.id, directory, receipt: await createArtifactReceipt({ plan, target: component.id, directory }) };
  }));
  const { file: receiptFile, receipt } = writeLocalReceipt(root, plan, artifacts);
  const releases = []; const assets = []; let nextAsset = 1;
  const api = async (route, options = {}) => {
    if (route === '/releases' && options.method === 'POST') {
      const release = { id: 1, author: { login: 'operator' }, ...options.body }; releases.push(release); return release;
    }
    if (route === '/releases/1') {
      if (options.method === 'PATCH') Object.assign(releases[0], options.body);
      return releases[0];
    }
    if (route.startsWith('/releases/1/assets?') && options.method === 'POST') {
      const name = new URLSearchParams(route.split('?')[1]).get('name');
      const asset = { id: nextAsset++, name, size: options.body.length, uploader: { login: 'operator' }, bytes: options.body };
      assets.push(asset); return asset;
    }
    const asset = assets.find(value => route === `/releases/assets/${value.id}`);
    if (asset) return asset.bytes;
    throw new Error(`Unexpected API ${route}`);
  };
  api.pages = async route => route === '/releases' ? releases : route === '/releases/1/assets' ? assets : assert.fail(route);
  const tracks = new Map(); const bundles = []; const calls = []; const edits = new Map(); let nextEdit = 1;
  let loseCommit = false; let rejectBeforeCommit = false;
  const publisher = {
    async createEdit() { const id = String(nextEdit++); edits.set(id, {}); return id; },
    async deleteEdit(id) { edits.delete(id); },
    async getTrack(_id, track) { return { releases: tracks.has(track) ? [tracks.get(track)] : [] }; },
    async listBundles() { return { bundles }; },
    async uploadBundle(edit, file, sha256) {
      const artifact = artifacts.find(value => file === path.join(value.directory, 'native.aab'));
      const versionCode = observations.find(value => value.id === artifact.target).versionCode;
      calls.push(artifact.target); const value = { versionCode, sha256 }; edits.get(edit).bundle = value; return value;
    },
    async updateTrack(edit, track, release) { assert.ok(release.name.length <= 50); Object.assign(edits.get(edit), { track, release }); },
    async commitEdit(edit) {
      if (rejectBeforeCommit) throw new Error('unknown transport outcome');
      const value = edits.get(edit); tracks.set(value.track, value.release); bundles.push(value.bundle);
      if (loseCommit) { loseCommit = false; throw new Error('lost committed response'); }
    }
  };
  let authCalls = 0;
  const options = { root, config, receiptFile, api, serviceAccountFile: credential,
    token: async () => { authCalls += 1; return 'fixture-token'; }, publisherFactory: () => publisher };
  return { options, receipt, artifacts, calls, releases, assets, tracks, config, api,
    loseCommit: () => { loseCommit = true; }, rejectBeforeCommit: () => { rejectBeforeCommit = true; }, authCalls: () => authCalls };
}

test('local upload honors dependency order, retains receipts and reserves codes without a hosted baseline', async t => {
  const value = await fixture(t);
  const result = await submitLocally(value.options);
  assert.equal(result.complete, true); assert.deepEqual(value.calls, ['z-phone', 'a-watch']);
  const ledger = new GitHubLedger({ config: value.config, api: value.api });
  const state = await ledger.read(1); assert.equal(state.local, true); assert.equal(state.release.draft, false);
  const baseline = await ledger.baseline();
  assert.deepEqual(baseline.components, {}); assert.deepEqual(baseline.runtimes, {});
  assert.deepEqual(baseline.reservations.native.codes, { 'z-phone': 17, 'a-watch': 18 });
  await assert.rejects(ledger.append(1, {}), /Hosted operations/);
  assert.equal((await inspectRecovery({ ledger, releaseId: 1 })).summary.status, 'complete');
  assert.ok(value.assets.every(asset => !asset.bytes.toString().includes('fixture-token')));
});

test('lost commit response reconciles exact original bytes and marker without a second upload', async t => {
  const value = await fixture(t); value.loseCommit();
  await assert.rejects(submitLocally(value.options), /lost committed response/);
  assert.deepEqual(value.calls, ['z-phone']); assert.equal(value.releases[0].draft, true);
  const result = await submitLocally(value.options);
  assert.equal(result.complete, true); assert.deepEqual(value.calls, ['z-phone', 'a-watch']);
});

test('an absent result after unknown commit stays blocking and cannot upload again', async t => {
  const value = await fixture(t); value.rejectBeforeCommit();
  await assert.rejects(submitLocally(value.options), /unknown transport/);
  await assert.rejects(submitLocally(value.options), /absence from a search/);
  assert.deepEqual(value.calls, ['z-phone']);
  const state = await new GitHubLedger({ config: value.config, api: value.api }).read(1);
  assert.equal(state.events.findLast(event => event.stage)?.operation.status, 'unknown');
});

test('altered artifacts fail before authentication; protected targets and noninternal tracks cannot opt into local upload', async t => {
  const value = await fixture(t);
  fs.appendFileSync(path.join(value.artifacts[0].directory, 'native.aab'), 'tamper');
  await assert.rejects(submitLocally(value.options), /differ|hash|size/i); assert.equal(value.authCalls(), 0);
  await assert.rejects(verifyLocalBuild(value.options.receiptFile), /differ|hash|size/i);
  const second = await fixture(t);
  const config = structuredClone(second.config); config.local.submissions['z-phone'].track = 'production';
  assert.throws(() => localSubmissionPlan(second.receipt, config), /configuration changed/);
});
