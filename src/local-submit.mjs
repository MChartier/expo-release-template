/** @file Verified retained local Android uploads share durable operations while remaining excluded from protected release baselines. */
import fs from 'node:fs';
import path from 'node:path';
import { invariant, hashIdentity, verifyPlan, verifyArtifactManifest, createPlan, buildReleaseGraph, remainingStages } from '../packages/release-engine/index.mjs';
import { externalCredential, readLocalSettings } from './local-credentials.mjs';
import { LocalLedger } from './local-ledger.mjs';
import { createGooglePlayPublisher, resolveGooglePlayAccessToken } from './providers/play-transport.mjs';
import { executeOperation } from './operations.mjs';
import { recoverRelease } from './recovery.mjs';

/** A local receipt is useful for local upload/install only; hashes cannot turn it into hosted attestation. */
export async function verifyLocalBuild(file) {
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8')); const plan = verifyPlan(receipt.plan);
  invariant(receipt.kind === 'expo-local-artifacts' && receipt.origin.kind === 'local' && plan.origin.kind === 'local'
    && plan.prepared && plan.operation === 'build' && receipt.planDigest === plan.digest, 'Expected a common local build receipt.');
  const targets = plan.components.filter(component => component.selected).map(component => component.id).sort();
  invariant(hashIdentity(receipt.artifacts.map(value => value.target).sort()) === hashIdentity(targets), 'Local artifact inventory differs from its build.');
  for (const artifact of receipt.artifacts) {
    invariant(artifact.receipt.origin.kind === 'local' && !artifact.receipt.producer?.workflowCommit && artifact.receipt.planDigest === plan.digest
      && hashIdentity(artifact.receipt.source) === hashIdentity(plan.source), 'Local artifact identity differs.');
    await verifyArtifactManifest(artifact.directory, artifact.receipt.manifest);
  }
  return receipt;
}

/** Local permissions are deliberately confined to explicitly configured internal Play tracks. */
export function localSubmissionPlan(build, config) {
  const original = verifyPlan(build.plan);
  invariant(hashIdentity(original.config) === hashIdentity(config), 'Local release configuration changed after the build.');
  const targets = original.components.filter(value => value.selected);
  const stages = {}; const graph = [];
  for (const target of targets) {
    const destination = config.local?.submissions?.[target.id];
    invariant(config.profiles?.[original.profile]?.execution === 'local' && target.kind === 'native' && target.platform === 'android'
      && !target.approvalEnvironment && /^(?:[a-z0-9._-]+:)?internal$/.test(destination?.track), 'This target is not permitted to publish locally.');
    stages[`${target.id}:submit`] = { target: target.id, action: 'submit' };
    graph.push({ id: `${target.id}:submit`, component: target.id, needs: (target.after ?? []).filter(id => targets.some(item => item.id === id)).map(id => `${id}:submit`) });
  }
  const { schemaVersion, kind, digest, ...payload } = original;
  const reservations = structuredClone(original.reservations);
  for (const group of config.versionGroups ?? []) {
    const selected = targets.filter(target => group.targets.includes(target.id));
    if (!selected.length) continue;
    reservations[group.id] = { version: selected[0].observation.version,
      codes: Object.fromEntries(selected.map(target => [target.id, target.observation.versionCode])) };
  }
  return createPlan({ ...payload, operation: 'submit', graph: buildReleaseGraph(graph), stages, reservations,
    localBuild: { planDigest: digest, receiptDigest: hashIdentity(build),
      artifacts: build.artifacts.map(value => ({ target: value.target, receipt: value.receipt })) } });
}

/** Upload once; a lost edit response is reconciled by exact version, bytes, and the original operation marker. */
export function localPlayProvider(spec, publisher) {
  const inspect = async () => {
    const edit = await publisher.createEdit();
    try { return { track: await publisher.getTrack(edit, spec.track), bundles: await publisher.listBundles(edit) }; }
    finally { await publisher.deleteEdit(edit); }
  };
  const verify = value => {
    const releases = (value.track.releases ?? []).filter(item => item.versionCodes?.map(Number).includes(spec.versionCode));
    const bundles = (value.bundles.bundles ?? []).filter(item => Number(item.versionCode) === spec.versionCode);
    invariant(releases.length === 1 && releases[0].status === 'completed' && releases[0].name === spec.marker
      && releases[0].versionCodes.length === 1 && bundles.length === 1 && bundles[0].sha256?.toLowerCase() === spec.sha256,
    'Play readback does not prove the exact original local submission.');
    return { origin: { kind: 'local' }, applicationId: spec.applicationId, track: spec.track, versionCode: spec.versionCode, sha256: spec.sha256 };
  };
  const observe = async () => {
    const value = await inspect();
    if (!(value.track.releases ?? []).some(item => item.versionCodes?.map(Number).includes(spec.versionCode))) return null;
    return { id: `${spec.track}:${spec.versionCode}`, status: 'complete', ...value };
  };
  return {
    find: observe,
    async status(id) { const value = await observe(); invariant(value?.id === id, 'Retained local upload is not observable; reconcile before another edit.'); return value; },
    async verify(value) { return verify(value); },
    async start() {
      const edit = await publisher.createEdit(); let committed = false;
      try {
        const track = await publisher.getTrack(edit, spec.track); const bundles = await publisher.listBundles(edit);
        invariant((track.releases ?? []).every(item => item.status === 'completed'
          && (item.versionCodes ?? []).every(code => Number(code) < spec.versionCode)), 'Play track contains pending changes or an equal/newer version.');
        invariant(!(bundles.bundles ?? []).some(item => Number(item.versionCode) === spec.versionCode), 'Local upload code is already used; do not adopt existing bytes.');
        const uploaded = await publisher.uploadBundle(edit, spec.file, spec.sha256);
        invariant(Number(uploaded.versionCode) === spec.versionCode && uploaded.sha256?.toLowerCase() === spec.sha256, 'Play upload response differs from retained bytes.');
        await publisher.updateTrack(edit, spec.track, { name: spec.marker, versionCodes: [String(spec.versionCode)], status: 'completed' });
        await publisher.commitEdit(edit); committed = true;
        return { id: `${spec.track}:${spec.versionCode}` };
      } finally { if (!committed) try { await publisher.deleteEdit(edit); } catch { /* Unknown commit outcome remains in the durable journal. */ } }
    }
  };
}

/** Publish from an explicit local receipt; inspection never runs application hooks or grants protected provenance. */
export async function submitLocally({ config, root, receiptFile, api, environment = process.env, serviceAccountFile, releaseId,
  action = 'resume', reason, token = resolveGooglePlayAccessToken, publisherFactory = createGooglePlayPublisher }) {
  const build = await verifyLocalBuild(receiptFile); const plan = localSubmissionPlan(build, config);
  const ledger = new LocalLedger({ config, api, origin: { kind: 'local' } });
  const release = releaseId ? (await ledger.read(releaseId)).release : await ledger.begin(plan);
  const state = await ledger.read(release.id);
  invariant(state.local && state.plan.digest === plan.digest, 'Selected local operation differs from these retained inputs.');
  if (!release.draft) return { releaseId: String(release.id), complete: true, origin: { kind: 'local' } };
  if (action === 'abandon') return recoverRelease({ ledger, releaseId: release.id, request: { action, reason } });
  invariant(action === 'resume', 'Local publication resumes exact observations; unknown uploads cannot be blindly retried.');
  const first = plan.components.find(value => value.selected && value.signing) ?? plan.components.find(value => value.selected);
  const configured = serviceAccountFile ?? readLocalSettings({ config, root, target: first.id, environment }).credentials.serviceAccountFile;
  const accessToken = await token({ serviceAccountFile: externalCredential(root, configured), environment: {} });
  const pending = new Map(plan.graph.stages.map(stage => [stage.id, stage]));
  while (pending.size) {
    const receipts = (await ledger.read(release.id)).events.filter(event => plan.stages[event.stage]);
    const remaining = new Set(remainingStages(plan.graph, receipts));
    const stage = [...pending.values()].find(value => value.needs.every(id => !remaining.has(id)));
    invariant(stage, 'Local submission dependencies have not completed.');
    pending.delete(stage.id);
    const target = plan.components.find(value => `${value.id}:submit` === stage.id);
    const artifact = build.artifacts.find(value => value.target === target.id);
    const files = artifact.receipt.manifest.files.filter(value => value.path.endsWith('.aab'));
    invariant(files.length === 1, 'Local submission requires exactly one AAB per target.');
    const spec = { ...config.local.submissions[target.id], applicationId: target.applicationId, versionCode: target.observation.versionCode,
      file: path.join(artifact.directory, files[0].path), sha256: files[0].sha256,
      marker: `expo-local:${plan.digest.slice(0, 24)}:${hashIdentity(target.id).slice(0, 8)}` };
    const provider = localPlayProvider(spec, publisherFactory({ applicationId: target.applicationId, accessToken }));
    const operation = await executeOperation({ ledger, releaseId: release.id, stage: stage.id, provider,
      context: { planDigest: plan.digest, source: plan.source.commit, target: target.id } });
    invariant(operation.status === 'complete', 'Local upload remains unresolved; inspect its durable release record.');
  }
  await ledger.finish(release.id);
  return { releaseId: String(release.id), complete: true, origin: { kind: 'local' } };
}
