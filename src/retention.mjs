/** @file Retain verified artifact inventories in the existing GitHub release ledger and restore identical bytes after interruption. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { invariant, verifyArtifactManifest, validateArtifactPath, hashIdentity } from '../packages/release-engine/index.mjs';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

/** Retain each verified file before appending its completion checkpoint; interrupted uploads reuse only identical bytes. */
export async function retainArtifact({ ledger, releaseId, receipt, directory, verify, staging }) {
  invariant(await verify(receipt, directory), 'Artifact verification did not authorize retention.');
  await verifyArtifactManifest(directory, receipt.manifest);
  const state = await ledger.read(releaseId);
  const previousIntent = state.events.findLast(value => value.type === 'artifact-retention' && value.target === receipt.target);
  if (previousIntent) invariant(hashIdentity(previousIntent.receipt) === hashIdentity(receipt), 'Cannot replace an artifact whose retention already began.');
  else {
    if (staging) invariant(String(staging.runId) === String(receipt.producer?.origin.runId)
      && staging.runAttempt === receipt.producer?.origin.runAttempt && /^artifact-[\w.-]+-\d+$/.test(staging.name), 'Staged artifact identity differs from its original producer.');
    await ledger.append(releaseId, { type: 'artifact-retention', target: receipt.target, receipt, ...(staging ? { staging } : {}) });
  }
  const files = [];
  for (const file of receipt.manifest.files) {
    const bytes = fs.readFileSync(path.join(directory, file.path));
    invariant(sha256(bytes) === file.sha256, 'Artifact changed during retention.');
    const name = `blob-${file.sha256}`;
    const asset = await ledger.upload(releaseId, name, bytes);
    files.push({ ...file, name, assetId: asset.id });
  }
  const name = `artifact-${receipt.target}-${hashIdentity(receipt)}.json`;
  const bytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`);
  const asset = await ledger.upload(releaseId, name, bytes);
  await verifyArtifactManifest(directory, receipt.manifest);
  const event = { type: 'artifact', target: receipt.target, receipt, receiptAsset: { id: asset.id, name, sha256: sha256(bytes) }, files };
  const previous = (await ledger.read(releaseId)).events.findLast(value => value.type === 'artifact' && value.target === receipt.target);
  if (previous) invariant(hashIdentity(previous.receipt) === hashIdentity(receipt), 'Cannot replace a retained target artifact.');
  else await ledger.append(releaseId, event);
  return event;
}

/** Recover a cohort from the same original Actions archive after any durable retention checkpoint. */
export function retentionRecovery(state, targets) {
  const retained = state.events.filter(event => event.type === 'artifact-retention' && targets.includes(event.target));
  if (!retained.length) return null;
  const first = retained[0];
  invariant(first.staging && retained.every(event => hashIdentity(event.staging) === hashIdentity(first.staging)
    && hashIdentity(event.receipt.producer) === hashIdentity(first.receipt.producer)), 'Build cohort has conflicting original artifact producers.');
  return first.staging;
}

/** Restore inert files from their original ledger evidence; a recovery run never becomes their producing run. */
export async function restoreArtifact({ ledger, releaseId, target, directory, verify }) {
  const state = await ledger.read(releaseId);
  const event = state.events.findLast(value => value.type === 'artifact' && value.target === target);
  invariant(event?.receipt && event.files?.length === event.receipt.manifest.files.length, 'Selected artifact has no complete retained inventory.');
  invariant(!fs.existsSync(directory), 'Artifact restoration requires a fresh directory.');
  fs.mkdirSync(directory, { recursive: true });
  const receiptAsset = state.assets.find(asset => asset.id === event.receiptAsset.id && asset.name === event.receiptAsset.name);
  invariant(receiptAsset, 'Retained artifact receipt is missing.');
  const receiptFile = `${directory}.receipt.json`;
  await ledger.download(receiptAsset, event.receiptAsset.sha256, receiptFile);
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
  invariant(hashIdentity(receipt) === hashIdentity(event.receipt), 'Retained receipt differs from its checkpoint.');
  for (const file of event.files) {
    validateArtifactPath(file.path);
    const expected = receipt.manifest.files.find(value => value.path === file.path);
    invariant(expected?.sha256 === file.sha256 && expected.size === file.size, 'Artifact inventory differs from its manifest.');
    const asset = state.assets.find(value => value.id === file.assetId && value.name === file.name);
    invariant(asset?.size === file.size, 'Retained artifact is missing or changed.');
    await ledger.download(asset, file.sha256, path.join(directory, file.path));
  }
  await verifyArtifactManifest(directory, receipt.manifest);
  const sourceProof = await verify(receipt, directory, receiptFile);
  invariant(sourceProof, 'Restored artifact verification did not return source proof.');
  return { receipt, receiptFile, directory, sourceProof };
}
