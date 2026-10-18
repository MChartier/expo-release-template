/** @file Exact server tag and moving-image finalization after immutable image publication, with fresh protected-source checks. */
import { invariant, hashIdentity } from '../packages/release-engine/index.mjs';
import { isVerifiedSourceProof } from './artifacts.mjs';
import { stageContext, completeStage } from './stages.mjs';
import { repositoryJson } from './trusted.mjs';
import { readPointer } from './config.mjs';

/** Resolve annotated/lightweight tags without following arbitrary references or accepting a moved version tag. */
async function tagTarget(api, tag) {
  let reference;
  try { reference = await api(`/git/ref/tags/${encodeURIComponent(tag)}`); }
  catch (error) { if (error.status === 404) return null; throw error; }
  let object = reference.object;
  for (let depth = 0; object.type === 'tag' && depth < 4; depth++) object = (await api(`/git/tags/${object.sha}`)).object;
  invariant(object.type === 'commit' && /^[a-f0-9]{40}$/.test(object.sha), 'Server tag does not resolve to a commit.');
  return object.sha;
}

/** Keep existing immutable version tags and update a moving alias only while protected metadata still names this version. */
export async function finalizeServer({ ledger, releaseId, target, api, artifact, transport }) {
  const { plan, component, complete } = await stageContext(ledger, releaseId, target, 'finalize');
  if (complete) return;
  invariant(isVerifiedSourceProof(artifact.sourceProof, { source: plan.source.commit, target, repository: plan.source.repository }), 'Server finalization requires hosted artifact proof.');
  const version = component.observation.version; const policy = component.publication;
  invariant(policy && /^\d+\.\d+\.\d+$/.test(version), 'Server publication policy or version is missing.');
  const expected = artifact.receipt.metadata.oci;
  const verify = value => invariant(value?.digest === expected.digest
    && hashIdentity(value.manifests) === hashIdentity(expected.manifests), 'Published image differs from retained artifact evidence.');
  for (const alias of [`v${version}`, `sha-${plan.source.commit}`]) verify(await transport.inspect(alias));
  const protectedBranch = await api(`/branches/${encodeURIComponent(plan.config.defaultBranch)}`);
  invariant(protectedBranch.protected === true, 'Server finalization requires protected branch authority.');
  const current = protectedBranch.commit.sha;
  const ancestry = await api(`/compare/${plan.source.commit}...${current}`);
  invariant(['ahead', 'identical'].includes(ancestry.status) && ancestry.merge_base_commit?.sha === plan.source.commit, 'Server source is outside protected history.');
  let tag = null;
  if (policy.gitTagPrefix !== undefined) {
    invariant(/^[A-Za-z0-9][A-Za-z0-9._-]{0,40}$/.test(policy.gitTagPrefix), 'Unsafe server tag prefix.');
    tag = `${policy.gitTagPrefix}${version}`;
    const previous = await tagTarget(api, tag);
    invariant(!previous || previous === plan.source.commit, 'Immutable server version tag already points elsewhere.');
    if (!previous) {
      await ledger.append(releaseId, { type: 'server-tag-intent', target, tag, source: plan.source.commit });
      try { await api('/git/refs', { method: 'POST', body: { ref: `refs/tags/${tag}`, sha: plan.source.commit } }); }
      catch (error) { if (![409, 422].includes(error.status)) throw error; }
    }
    invariant(await tagTarget(api, tag) === plan.source.commit, 'Server tag readback differs.');
  }
  let moving = null;
  if (policy.movingTag) {
    invariant(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(policy.movingTag) && component.version, 'Moving image alias requires mapped server metadata.');
    const metadata = await repositoryJson(api, component.version.file, current);
    if (readPointer(metadata, component.version.pointer) !== version) moving = { alias: policy.movingTag, status: 'superseded' };
    else {
      const existing = await transport.inspect(policy.movingTag);
      if (existing?.digest !== expected.digest) {
        await ledger.append(releaseId, { type: 'server-alias-intent', target, alias: policy.movingTag,
          protectedSource: current, digest: expected.digest, previousDigest: existing?.digest ?? null });
        // Recheck immediately before mutation; all shared writers use the consumer's serialized release queue.
        invariant((await api(`/branches/${encodeURIComponent(plan.config.defaultBranch)}`)).commit.sha === current, 'Protected source advanced before moving-alias publication.');
        await transport.publish(artifact.file, [policy.movingTag]);
      }
      verify(await transport.inspect(policy.movingTag));
      moving = { alias: policy.movingTag, status: 'published', digest: expected.digest };
    }
  }
  return completeStage({ ledger, releaseId, target, action: 'finalize', receipt: { tag, moving, digest: expected.digest, source: plan.source.commit } });
}
