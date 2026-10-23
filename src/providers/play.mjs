/** @file Exact retained-bundle Play promotion; mutable release names never substitute for verified artifact provenance. */
import { invariant } from '../../packages/release-engine/index.mjs';
import { isVerifiedSourceProof } from '../artifacts.mjs';

/** Verify one singleton completed track entry and its independently read bundle digest. */
export function verifyPlayObservation(observed, spec) {
  const entries = (observed.track?.releases ?? []).filter(release => (release.versionCodes ?? []).map(String).includes(String(spec.versionCode)));
  const bundles = (observed.bundles?.bundles ?? []).filter(bundle => Number(bundle.versionCode) === spec.versionCode);
  invariant(entries.length === 1 && entries[0].status === 'completed' && entries[0].versionCodes.length === 1
    && entries[0].name === spec.marker, 'Play destination does not identify one completed exact candidate.');
  invariant(bundles.length === 1 && bundles[0].sha256?.toLowerCase() === spec.sha256, 'Play bundle digest does not match retained bytes.');
  invariant(isVerifiedSourceProof(spec.sourceProof, { source: spec.source, target: spec.target }), 'Play promotion requires independently verified hosted artifact provenance.');
  return { applicationId: spec.applicationId, track: spec.destination, versionCode: spec.versionCode,
    sha256: spec.sha256, source: spec.source, originalOrigin: spec.sourceProof.origin };
}

/** Create an observation-only edit and discard it after reading current tracks/bundles. */
async function inspect(publisher, track) {
  const edit = await publisher.createEdit();
  try { return { track: await publisher.getTrack(edit, track), bundles: await publisher.listBundles(edit) }; }
  finally { await publisher.deleteEdit(edit); }
}

/** Promote existing verified bytes once; unknown commit responses require observation, never another blind edit. */
export function createPlayPromotionProvider(spec, publisher) {
  invariant(spec.sourceTrack && spec.destination && spec.sourceTrack !== spec.destination && Number.isSafeInteger(spec.versionCode), 'Invalid Play promotion destination.');
  return {
    async find() {
      const observed = await inspect(publisher, spec.destination);
      if (!(observed.track?.releases ?? []).some(release => (release.versionCodes ?? []).map(String).includes(String(spec.versionCode)))) return null;
      return { id: `${spec.destination}:${spec.versionCode}`, status: 'complete', ...observed };
    },
    async status(id) { return { id, status: 'complete', ...await inspect(publisher, spec.destination) }; },
    async verify(observed) { return verifyPlayObservation(observed, spec); },
    async start() {
      invariant(isVerifiedSourceProof(spec.sourceProof, { source: spec.source, target: spec.target }), 'Local evidence cannot be promoted.');
      const edit = await publisher.createEdit();
      let committed = false;
      try {
        const source = { track: await publisher.getTrack(edit, spec.sourceTrack), bundles: await publisher.listBundles(edit) };
        verifyPlayObservation(source, { ...spec, destination: spec.sourceTrack });
        const destination = await publisher.getTrack(edit, spec.destination);
        const releases = destination.releases ?? [];
        invariant(releases.every(release => release.status === 'completed'), 'Play has pending destination changes; finish Console coordination first.');
        const codes = releases.flatMap(release => release.versionCodes ?? []).map(Number);
        invariant(codes.every(code => Number.isSafeInteger(code) && code < spec.versionCode), 'Promotion would reuse or downgrade a destination version.');
        await publisher.updateTrack(edit, spec.destination, { name: spec.marker, versionCodes: [String(spec.versionCode)], status: 'completed' });
        await publisher.commitEdit(edit);
        committed = true;
        return { id: `${spec.destination}:${spec.versionCode}` };
      } finally {
        if (!committed) { try { await publisher.deleteEdit(edit); } catch { /* A possibly committed edit must be reconciled from provider state. */ } }
      }
    }
  };
}
