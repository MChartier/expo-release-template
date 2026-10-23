/** @file Promotes configured same-application Android cohorts in one Play edit, preserving exact artifact provenance and resolving lost commits by readback. */
import { hashIdentity, invariant } from '../../packages/release-engine/index.mjs';
import { isVerifiedSourceProof } from '../artifacts.mjs';

function exact(track, bundles, target, destination) {
  const entries = (track?.releases || []).filter(value => value.versionCodes?.map(Number).includes(target.versionCode));
  const bytes = (bundles?.bundles || []).filter(value => Number(value.versionCode) === target.versionCode);
  invariant(entries.length === 1 && entries[0].status === 'completed' && entries[0].versionCodes.length === 1,
    'Play track must contain one completed singleton for the exact version.');
  const marker = destination ? target.marker : target.sourceMarker;
  invariant(!marker || entries[0].name === marker, 'Play source/destination marker differs.');
  invariant(bytes.length === 1 && bytes[0].sha256?.toLowerCase() === target.sha256, 'Play bundle differs from the retained artifact.');
}

/** Create one atomic same-app promotion; partial/missing readback blocks retries instead of replacing concurrent Console changes. */
export function createPlayCohortPromotionProvider(spec, publisher) {
  const targets = spec.targets;
  invariant(Array.isArray(targets) && targets.length > 0 && new Set(targets.map(value => value.target)).size === targets.length
    && new Set(targets.map(value => value.destination)).size === targets.length, 'A promotion cohort needs unique targets and tracks.');
  for (const target of targets) invariant(target.applicationId === spec.applicationId && target.sourceTrack !== target.destination
    && Number.isSafeInteger(target.versionCode) && target.versionCode > 0 && /^[a-f0-9]{64}$/.test(target.sha256)
    && isVerifiedSourceProof(target.sourceProof, { source: spec.source, target: target.target, repository: spec.repository }),
  'A Play cohort requires exact independently verified hosted artifacts for one application.');
  invariant(new Set(targets.map(value => value.versionCode)).size === targets.length, 'Same-app cohort codes must be distinct.');
  const id = `play:${hashIdentity({ applicationId: spec.applicationId, source: spec.source,
    targets: targets.map(({ target, destination, versionCode, sha256, marker }) => ({ target, destination, versionCode, sha256, marker })) })}`;
  const proof = { applicationId: spec.applicationId, source: spec.source, targets: targets.map(value => ({ target: value.target,
    track: value.destination, versionCode: value.versionCode, sha256: value.sha256, originalOrigin: value.sourceProof.origin })) };
  const observe = async () => {
    const edit = await publisher.createEdit();
    try {
      const bundles = await publisher.listBundles(edit); let complete = 0;
      for (const target of targets) {
        const track = await publisher.getTrack(edit, target.destination);
        if ((track.releases || []).some(value => value.versionCodes?.map(Number).includes(target.versionCode))) {
          exact(track, bundles, target, true); complete++;
        }
      }
      return { id, status: complete === targets.length ? 'complete' : 'unknown', completeTargets: complete };
    } finally { await publisher.deleteEdit(edit); }
  };
  return {
    /** An absent or partial destination never authorizes another edit after an unknown commit. */
    async find() { return observe(); },
    /** Keep the operation's exact cohort identity while reading all destination tracks. */
    async status(expected) { invariant(expected === id, 'Play cohort operation ID differs.'); return observe(); },
    /** Verify live exact track/hash evidence before reporting completion. */
    async verify(value) { invariant(value.id === id, 'Play cohort response identity differs.'); const current = await observe();
      invariant(current.status === value.status && current.completeTargets === value.completeTargets, 'Play cohort changed during readback.');
      return { ...proof, completeTargets: current.completeTargets, status: current.status }; },
    /** Stage every configured target in one edit and commit only after all source/destination checks pass. */
    async start() {
      const edit = await publisher.createEdit(); let committed = false;
      try {
        const bundles = await publisher.listBundles(edit); const destinations = [];
        for (const target of targets) {
          exact(await publisher.getTrack(edit, target.sourceTrack), bundles, target, false);
          const track = await publisher.getTrack(edit, target.destination);
          const existing = (track.releases || []).some(value => value.versionCodes?.map(Number).includes(target.versionCode));
          if (existing) exact(track, bundles, target, true);
          else invariant((track.releases || []).every(value => value.status === 'completed' && (value.versionCodes || []).every(code => Number.isSafeInteger(Number(code))
            && Number(code) < target.versionCode)), 'Promotion would replace pending Console changes or downgrade a track.');
          destinations.push({ target, existing });
        }
        if (destinations.every(value => value.existing)) return { id };
        invariant(destinations.every(value => !value.existing), 'Partially promoted cohort needs reconciliation before another edit.');
        for (const { target } of destinations) await publisher.updateTrack(edit, target.destination,
          { name: target.marker, versionCodes: [String(target.versionCode)], status: 'completed' });
        await publisher.commitEdit(edit); committed = true; return { id };
      } finally { if (!committed) try { await publisher.deleteEdit(edit); } catch { /* A lost commit response remains unresolved in the durable operation. */ } }
    },
  };
}
