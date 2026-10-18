/** @file Exact artifact receipts and in-process verified source capabilities for source-free publishers. */
import fs from 'node:fs';
import { createArtifactManifest, verifyArtifactManifest, verifyPlan, immutable, invariant, hashIdentity } from '../packages/release-engine/index.mjs';

const verifiedProofs = new WeakSet();

/** Record artifact bytes and all producing identities separately; this unverified receipt grants no publication authority. */
export async function createArtifactReceipt({ plan, target, directory, metadata = {}, origin = plan.origin,
  workflowCommit = plan.source.workflowCommit, toolkitCommit = plan.source.toolkitCommit }) {
  verifyPlan(plan);
  invariant(plan.components.some(component => component.id === target && component.selected), 'Artifact target is not selected.');
  const manifest = await createArtifactManifest(directory);
  return immutable({ schemaVersion: 1, kind: 'expo-release-artifact', planDigest: plan.digest, target,
    source: plan.source, origin, producer: { origin, toolkitCommit, ...(workflowCommit ? { workflowCommit } : {}) },
    configuration: hashIdentity(plan.config), manifest, metadata });
}

/** Verify exact retained bytes and the original trusted producer before granting a non-serializable source proof. */
export async function verifyRetainedArtifact({ plan, target, directory, receipt, verifyProducer, verifyAttestation, allowLocal = false }) {
  verifyPlan(plan);
  invariant(receipt?.schemaVersion === 1 && receipt.kind === 'expo-release-artifact' && receipt.planDigest === plan.digest
    && receipt.target === target && hashIdentity(receipt.source) === hashIdentity(plan.source)
    && receipt.configuration === hashIdentity(plan.config) && receipt.origin?.kind === plan.origin.kind
    && hashIdentity(receipt.producer?.origin) === hashIdentity(receipt.origin), 'Artifact provenance differs from the exact producing plan.');
  await verifyArtifactManifest(directory, receipt.manifest);
  if (receipt.origin.kind === 'github') {
    invariant(typeof verifyProducer === 'function' && typeof verifyAttestation === 'function', 'Hosted artifact requires producer and attestation verification.');
    invariant(await verifyProducer(receipt), 'Original producing run verification failed.');
    invariant(await verifyAttestation(receipt), 'Retained artifact attestation verification failed.');
  } else invariant(allowLocal && plan.origin.kind === 'local' && receipt.origin.kind === 'local', 'Local build evidence cannot authorize hosted publication.');
  const proof = immutable({ schemaVersion: 1, kind: 'verified-artifact-source', source: plan.source.commit,
    repository: plan.source.repository, planDigest: plan.digest, target, origin: receipt.origin,
    manifestDigest: receipt.manifest.digest, configuration: receipt.configuration });
  verifiedProofs.add(proof);
  return proof;
}

/** Accept only a proof created by this verifier in the publisher process, never a boolean or deserialized claim. */
export function isVerifiedSourceProof(proof, { source, target, repository, hosted = true } = {}) {
  return verifiedProofs.has(proof) && (!source || proof.source === source) && (!target || proof.target === target)
    && (!repository || proof.repository === repository) && (!hosted || proof.origin.kind === 'github');
}

/** Grant an original-format artifact capability only after its compatibility reader verifies producer, attestation and exact file hashes. */
export async function verifyHistoricalArtifact({ repository, source, target, origin, original, directory, verifyOriginal }) {
  invariant(origin?.kind === 'github' && /^[1-9]\d*$/.test(String(origin.runId)) && /^[a-f0-9]{40}$/.test(source)
    && typeof verifyOriginal === 'function', 'Historical artifacts require their original hosted identity.');
  const files = await verifyOriginal(original);
  const manifest = await createArtifactManifest(directory);
  invariant(Array.isArray(files) && files.length > 0 && files.length === manifest.files.length
    && manifest.files.every(file => files.filter(expected => expected.path === file.path && expected.sha256 === file.sha256).length === 1),
  'Historical artifact bytes differ from their attested inventory.');
  const proof = immutable({ schemaVersion: 1, kind: 'verified-artifact-source', repository, source, target, origin,
    planDigest: hashIdentity(original), manifestDigest: manifest.digest, historical: true });
  verifiedProofs.add(proof);
  return proof;
}

/** Serialize canonical receipt bytes outside the artifact directory so the receipt does not hash itself. */
export function saveArtifactReceipt(file, receipt) {
  invariant(receipt?.kind === 'expo-release-artifact', 'Unsupported artifact receipt.');
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
}
