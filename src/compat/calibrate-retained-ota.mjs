/** @file Restore and observe original attested OTA exports without rebuilding, relabeling their producer, or replacing publication IDs. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { invariant, hashIdentity, reduceOperation, verifyArtifactManifest } from '../../packages/release-engine/index.mjs';
import { repositoryPath } from '../config.mjs';
import { verifyHistoricalAttestation } from '../attestation.mjs';
import { verifyHistoricalArtifact } from '../artifacts.mjs';
import { verifyUpdateArtifact } from './v1/expo-ota-artifact.mjs';
import { verifyOriginalNativeRuntime } from './calibrate-ota.mjs';
import { appendCalibrateRecovery } from './calibrate.mjs';
import { createEasOtaProvider, exportPayload } from '../providers/eas.mjs';
import { createEasPublisherWorkspace } from '../providers/eas-workspace.mjs';
import { executeOperation, latestOperation } from '../operations.mjs';
import { sourceEnvironment } from '../hooks.mjs';

/** Expand only bounded inert files and verify their original provenance inventory. */
export function unpackOriginalOta(bytes, root, expected) {
  invariant(!fs.existsSync(root), 'Original OTA restore directory must be fresh.');
  const value = JSON.parse(gunzipSync(bytes, { maxOutputLength: 512 * 1024 * 1024 }));
  invariant(typeof value.provenance === 'string' && Array.isArray(value.files) && value.files.length < 100000, 'Invalid original OTA archive.');
  fs.mkdirSync(path.join(root, 'bundle'), { recursive: true });
  fs.writeFileSync(path.join(root, 'provenance.json'), Buffer.from(value.provenance, 'base64'), { flag: 'wx' });
  for (const file of value.files) {
    const destination = repositoryPath(path.join(root, 'bundle'), file.path);
    invariant(typeof file.bytes === 'string', 'Invalid original OTA file bytes.');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, Buffer.from(file.bytes, 'base64'), { flag: 'wx' });
  }
  return verifyUpdateArtifact({ artifactRoot: root, ...expected });
}

/** Authenticate original archive, runtime and signer against today's protected trust policy. */
export async function restoreOriginalOta({ ledger, state, target, directory, attest = verifyHistoricalAttestation, verifyNative = verifyOriginalNativeRuntime }) {
  const channel = target.slice(4); const component = ledger.config.components.find(value => value.id === target && value.kind === 'ota');
  invariant(component?.channel === channel && component.platform === 'android' && ['internal', 'production'].includes(channel), 'Original OTA destination changed.');
  const checkpoint = state.checkpoints.findLast(value => value.stage === `${target}-artifact`);
  const asset = state.assets.filter(value => value.name === `${target}.json.gz`);
  invariant(checkpoint?.status === 'succeeded' && asset.length === 1, 'Original retained OTA export is missing or ambiguous.');
  const bytes = await ledger.api(`/releases/assets/${asset[0].id}`, { raw: true });
  invariant(createHash('sha256').update(bytes).digest('hex') === checkpoint.sha256, 'Original OTA archive hash differs.');
  const root = path.join(directory, 'original');
  const provenance = unpackOriginalOta(bytes, root, { sourceCommit: state.origin.sourceCommit, channel,
    environment: channel === 'production' ? 'production' : 'preview', projectId: ledger.config.expo.projectId });
  invariant(provenance.runtimeVersion === checkpoint.runtime_version && provenance.bundleIntegrity === checkpoint.bundle_integrity, 'Original OTA checkpoint changed.');
  if (checkpoint.artifact_manifest) await verifyArtifactManifest(root, checkpoint.artifact_manifest);
  if (channel === 'production' && state.record.plan.native) {
    const metadata = await verifyNative({ ledger, state });
    invariant(metadata.native.runtime_version === provenance.runtimeVersion, 'Production export differs from the original selected phone runtime.');
  }
  const origin = { kind: 'github', runId: String(checkpoint.producing_run_id), runAttempt: Number(checkpoint.producing_run_attempt) };
  const sourceProof = await verifyHistoricalArtifact({ repository: ledger.config.repository, source: state.origin.sourceCommit, target, origin,
    original: provenance, directory: path.join(root, 'bundle'), verifyOriginal: async () => {
      await attest({ api: ledger.api, config: ledger.config, file: path.join(root, 'provenance.json'), signer: checkpoint.workflow_sha,
        workflow: '.github/workflows/expo-ota-update.yml', policyFile: ledger.config.trust?.nativeWorkflowFile,
        criticalFiles: ['.github/workflows/expo-ota-update.yml', 'scripts/expo-ota-artifact.mjs', 'scripts/expo-ota-store.mjs',
          'scripts/expo-runtime.mjs', 'scripts/zip-entry.mjs', 'scripts/release-config.mjs', 'scripts/release-engine.mjs',
          'scripts/release-engine.config.mjs', 'release-engine.lock.json', 'tools/verify-release-engine.mjs',
          ...['index', 'core', 'selection', 'graph', 'operation', 'artifacts', 'versions'].map(name => `tools/release-engine/${name}.mjs`)] });
      return provenance.files;
    } });
  return { provenance, directory: path.join(root, 'bundle'), sourceProof };
}

/** Resume or reconcile exactly the original retained export; provider ambiguity never triggers another publication. */
export async function continueOriginalOta({ ledger, state, request, target, environment = process.env, restore = restoreOriginalOta, transport }) {
  const releaseId = state.release.id; const stage = state.graph.stages.find(value => value.id === target);
  invariant(stage && stage.needs.every(id => !state.summary.remaining.includes(id)), 'Original OTA dependencies have not completed.');
  const previous = latestOperation(state.events, target);
  if (previous?.status === 'complete') return previous;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'original-ota-')); let workspace;
  const append = event => ledger.read(releaseId).then(current => appendCalibrateRecovery({ ledger, state: current, event }));
  const adapter = { read: () => ledger.read(releaseId), append: (_id, event) => append(event) };
  try {
    const retained = await restore({ ledger, state, target, directory }); const original = retained.provenance;
    const spec = { ...ledger.config.expo, repository: ledger.config.repository, target, source: state.origin.sourceCommit, platform: 'android',
      applicationId: original.project.androidPackage, profile: original.environment, environment: original.environment,
      channel: original.channel, runtime: original.runtimeVersion, version: original.appVersion, serverUrl: original.serverUrl,
      marker: `Release ${releaseId}`, sourceProof: retained.sourceProof, directory: retained.directory,
      payload: await exportPayload(retained.directory, 'android') };
    workspace = createEasPublisherWorkspace(spec, { env: { ...sourceEnvironment(environment), ...(environment.EXPO_TOKEN ? { EXPO_TOKEN: environment.EXPO_TOKEN } : {}) } });
    const remote = transport ?? workspace.transport; spec.branch = await remote.channel(spec);
    const provider = createEasOtaProvider(spec, remote);
    const context = { planDigest: hashIdentity(state.legacyPlan), source: state.origin.sourceCommit, target, bundleIntegrity: original.bundleIntegrity };
    if (request.action === 'reconcile') {
      if (request.reconciliation?.absence !== undefined) {
        invariant(previous && !previous.operationId && ['intent', 'unknown'].includes(previous.status)
          && !request.reconciliation.operationId, 'Only an unresolved original OTA request without a provider ID can be reconciled as absent.');
        const proof = await provider.verifyAbsence(request.reconciliation.absence,
          { ...context, operationKey: previous.operationKey, attempt: previous.attempt });
        const transition = { type: 'reconciled-absent', proof }; const operation = reduceOperation(previous, transition);
        await append({ stage: target, status: operation.status, operation, transition });
        return operation;
      }
      invariant(previous && previous.status !== 'complete' && request.reconciliation?.operationId
        && (!previous.operationId || previous.operationId === request.reconciliation.operationId), 'Reconcile the exact original OTA provider ID.');
      const result = await provider.status(request.reconciliation.operationId); const proof = await provider.verify(result);
      let current = previous;
      for (const transition of [...(!current.operationId ? [{ type: 'accepted', operationId: result.id, proof }] : []), { type: 'complete', receipt: proof, proof }]) {
        current = reduceOperation(current, transition); await append({ stage: target, status: current.status, operation: current, transition });
      }
      return current;
    }
    return executeOperation({ ledger: adapter, releaseId, stage: target, provider, retry: request.action === 'retry',
      context });
  } finally { workspace?.dispose(); fs.rmSync(directory, { recursive: true, force: true }); }
}
