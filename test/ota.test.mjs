/** @file Exercises retained multi-runtime exports, altered payload rejection and partial publication recovery. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { planRelease, finalizePlan, baselineKey, runtimeBaselineKey, completedBaseline } from '../src/planner.mjs';
import { resolveOtaBindings } from '../src/ota-runtime.mjs';
import { exportOta, verifyOtaExports, publishOta } from '../src/ota.mjs';
import { completeStage, recoveryStatus } from '../src/stages.mjs';
import { hashIdentity } from '../packages/release-engine/index.mjs';
import { createArtifactReceipt, verifyRetainedArtifact } from '../src/artifacts.mjs';
import { executeStage, createStageProvider } from '../src/execution.mjs';
import { exportPayload } from '../src/providers/eas.mjs';

async function fixture(t, { empty = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ota-pipeline-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = { repository: 'fixture/app', commit: 'a'.repeat(40), workflowCommit: 'b'.repeat(40), toolkitCommit: 'c'.repeat(40) };
  const environmentHash = 'e'.repeat(64);
  const native = { id: 'ios', kind: 'native', platform: 'ios', builder: 'eas', runtimePolicy: 'appVersion', channel: 'production', environment: 'production', applicationId: 'fixture.app', profile: 'production' };
  const ota = { id: 'ota', kind: 'ota', nativeTarget: 'ios', platform: 'ios', channel: 'production', environment: 'production', profile: 'production' };
  const expo = { projectId: '11111111-1111-4111-8111-111111111111', owner: 'fixture', slug: 'app' };
  const config = { schemaVersion: 1, repository: source.repository, defaultBranch: 'main', components: [native, ota], expo };
  const observed = runtime => ({ identity: 'native', runtime, fingerprint: hashIdentity(runtime), environmentHash,
    version: runtime, versionCode: 2, releaseMetadata: { version: runtime, androidVersionCode: 3, iosBuildNumber: '2' }, expoConfig: { name: 'Fixture' } });
  const first = { ...observed('1.0.0'), source: 'd'.repeat(40) };
  const second = { ...observed('0.9.0'), source: 'f'.repeat(40) };
  const baseline = { components: empty ? {} : { [baselineKey(native)]: first },
    runtimes: empty ? {} : { [runtimeBaselineKey(native, '', second.runtime)]: second } };
  const observations = [{ id: 'ios', ...observed('1.0.0') }, { id: 'ota', ...observed('1.0.0'), identity: 'bundle' }];
  const reservation = planRelease({ config, source, origin: { kind: 'github', runId: '123', runAttempt: 1 },
    observations, baseline, operation: 'ota', providerConfiguration: { expo } });
  const plan = finalizePlan(reservation, source, observations);
  const component = plan.components.find(value => value.id === 'ota');
  const inputs = { expo, hash: environmentHash, environment: {}, branch: { id: 'branch-id', name: 'production' } };
  const built = await exportOta({ plan, component, root, inputs, directory: root,
    resolveBindings: args => resolveOtaBindings({ ...args,
      git: (_root, argv) => argv[0] === 'rev-parse' ? source.commit : '',
      inspect: (_config, options) => {
        const actual = observed(options.runtimeOverrides.version || '1.0.0');
        return [{ id: 'ios', ...actual }, { id: 'ota', ...actual, identity: 'bundle' }];
      } }),
    hook: (_config, action, request) => {
      if (action === 'verify') return { verified: true };
      fs.writeFileSync(path.join(request.outputDirectory, 'main.js'), `bundle for ${request.binding.runtime}`);
      fs.writeFileSync(path.join(request.outputDirectory, 'metadata.json'), JSON.stringify({ fileMetadata: { ios: { bundle: 'main.js', assets: [] } } }));
      return { artifact: { directory: request.outputDirectory, runtime: request.binding.runtime } };
    } });
  const artifact = { directory: root, receipt: { metadata: built, manifest: { digest: 'retained-manifest' } } };
  const state = { release: { id: '456', draft: true }, plan, events: [] };
  const ledger = { read: async () => structuredClone(state), append: async (_id, event) => state.events.push(structuredClone(event)) };
  await completeStage({ ledger, releaseId: '456', target: 'ota', action: 'export', receipt: { artifact: 'retained' } });
  return { plan, component, artifact, state, ledger, releaseId: '456' };
}

test('export keeps exact per-runtime version overlays and rejects changed retained bytes', async t => {
  const { plan, component, artifact } = await fixture(t);
  assert.deepEqual(artifact.receipt.metadata.bindings.map(value => value.runtime), ['1.0.0', '0.9.0']);
  await verifyOtaExports({ plan, component, directory: artifact.directory, metadata: artifact.receipt.metadata });
  const first = artifact.receipt.metadata.bindings[0];
  fs.appendFileSync(path.join(artifact.directory, first.directory, 'main.js'), 'changed');
  await assert.rejects(verifyOtaExports({ plan, component, directory: artifact.directory, metadata: artifact.receipt.metadata }), /bytes differ/);
});

test('lost response on a second runtime never repeats the successful first publication', async t => {
  const value = await fixture(t); const starts = []; let lost = true;
  const providers = new Map();
  const stageFactory = async ({ binding }) => {
    if (!providers.has(binding.runtime)) providers.set(binding.runtime, {
      start: async () => { starts.push(binding.runtime); if (binding.runtime === '0.9.0' && lost) throw new Error('lost response'); return { id: binding.runtime }; },
      status: async id => ({ id, status: 'complete' }), find: async () => lost ? null : ({ id: binding.runtime, status: 'complete' }),
      verify: async result => ({ runtime: binding.runtime, id: result.id, bytes: binding.payload }) });
    return { provider: providers.get(binding.runtime) };
  };
  await assert.rejects(publishOta({ ...value, stageFactory }), /lost response/);
  assert.equal(recoveryStatus(value.state).summary.completedComponents.includes('ota'), false);
  await assert.rejects(publishOta({ ...value, stageFactory }), /absence from a search/);
  assert.deepEqual(starts, ['1.0.0', '0.9.0']);
  lost = false;
  await publishOta({ ...value, stageFactory });
  assert.deepEqual(starts, ['1.0.0', '0.9.0']);
  assert.equal(recoveryStatus(value.state).summary.remaining.length, 0);
  assert.equal(value.state.events.at(-1).receipt.publications.length, 2);
});

test('no compatible runtime finishes with explicit skip evidence without advancing the publication baseline', async t => {
  const value = await fixture(t, { empty: true });
  await publishOta({ ...value, stageFactory: async () => { throw new Error('must not publish'); } });
  assert.equal(value.state.events.at(-1).receipt.outcome, 'skipped');
  assert.deepEqual(completedBaseline(value.plan, value.state.events).components, {});
});

test('shared executor and recovery factory bind each OTA runtime and reconcile a lost response without publishing twice', async t => {
  const f = await fixture(t); const { plan, artifact } = f;
  artifact.receipt = await createArtifactReceipt({ plan, target: 'ota', directory: artifact.directory,
    metadata: { ...artifact.receipt.metadata, expo: plan.providerConfiguration.expo } });
  artifact.sourceProof = await verifyRetainedArtifact({ plan, target: 'ota', ...artifact, verifyProducer: async () => true, verifyAttestation: async () => true });
  const groups = new Map(); const launches = new Map(); const calls = [];
  const bindings = artifact.receipt.metadata.bindings;
  const easTransport = {
    channel: async () => bindings[0].branch, exportPayload,
    cli: async args => {
      const binding = bindings.find(value => path.join(artifact.directory, value.directory) === args[args.indexOf('--input-dir') + 1]);
      calls.push(binding.runtime);
      const group = `00000000-0000-4000-8000-00000000000${calls.length}`;
      launches.set(group, binding.payload.launch);
      groups.set(group, [{ id: group, group, platform: 'IOS', runtime: { version: binding.runtime }, branch: binding.branch,
        gitCommitHash: plan.source.commit, isGitWorkingTreeDirty: false, environment: 'production', message: args[args.indexOf('--message') + 1],
        manifestFragment: { launchAsset: { fileSHA256: binding.payload.launch, storageKey: group }, assets: [],
          extra: { expoClient: { extra: { eas: { projectId: plan.providerConfiguration.expo.projectId } } } } } }]);
      if (calls.length === 2) throw Error('lost second runtime response');
      return [{ group }];
    },
    getUpdate: async id => groups.get(id), listUpdates: async () => [...groups.values()],
    assetUrls: async id => [{ storageKey: id, url: id }], hashArtifact: async url => Buffer.from(launches.get(url), 'base64url').toString('hex'),
  };
  const options = { ledger: f.ledger, releaseId: f.releaseId, stage: 'ota:publish', directory: artifact.directory,
    restore: async () => artifact, easTransport, environment: {} };
  await assert.rejects(executeStage(options), /lost second runtime response/);
  const stage = `ota:publish:runtime-${bindings[1].key}`;
  const observer = await createStageProvider({ ...options, state: f.state, stage });
  try { assert.equal((await observer.provider.find()).status, 'complete'); assert.equal(calls.length, 2); }
  finally { observer.dispose(); }
  await executeStage(options);
  assert.deepEqual(calls, ['1.0.0', '0.9.0']); assert.equal(recoveryStatus(f.state).summary.remaining.length, 0);
  await assert.rejects(createStageProvider({ ...options, state: f.state, stage: 'ota:publish:runtime-invalid' }), /Invalid OTA/);
  await assert.rejects(createStageProvider({ ...options, state: f.state, stage: `ota:publish:runtime-${'f'.repeat(64)}` }), /exact retained OTA/);
  await assert.rejects(executeStage({ ...options, stage }), /not independently dispatched/);
});
