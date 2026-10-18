/** @file Authenticate original GHCR receipts with their preserved signer contract before importing or recovering an immutable image. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { invariant } from '../../packages/release-engine/index.mjs';
import { authorizeGhcrReleaseWorkflow, GHCR_RELEASE_ATTESTATION_CRITICAL_PATHS, parseGhcrAttestationWorkflowCandidates,
  parseGhcrReleaseWorkflowTrustSet, serializeGhcrReleaseReceipt } from './v1/ghcr-release-receipt.mjs';

/** Supply immutable GitHub objects to the original policy without checking out or executing application source. */
export async function authorizeOriginalImageSigner({ api, config, signer, releaseCommit }) {
  const branch = await api(`/branches/${encodeURIComponent(config.defaultBranch)}`);
  invariant(branch.protected && /^[a-f0-9]{40}$/.test(branch.commit.sha), 'Image trust requires current protected history.');
  const current = branch.commit.sha; const cache = new Map();
  const getFile = async (revision, file) => {
    const key = `${revision}:${file}`;
    if (cache.has(key)) return cache.get(key);
    try {
      const value = await api(`/contents/${file}?ref=${revision}`);
      invariant(value.type === 'file' && value.encoding === 'base64' && value.size < 2 * 1024 * 1024, 'Invalid historical image policy file.');
      const result = { sha: value.sha, text: Buffer.from(value.content, 'base64').toString('utf8') }; cache.set(key, result); return result;
    } catch (error) { cache.set(key, error); return error; }
  };
  const policy = await getFile(current, config.trust?.workflowFile ?? '.github/release-image-attestation-trusted-workflow-shas');
  if (policy instanceof Error) throw policy;
  const trust = parseGhcrReleaseWorkflowTrustSet(policy.text);
  invariant(!trust.revoked.includes(signer), 'Original image signer is revoked by current protected policy.');
  const commits = new Map();
  for (const sha of new Set([signer, current, releaseCommit])) {
    const commit = await api(`/git/commits/${sha}`); invariant(commit.sha === sha, 'Historical image revision is not exact.'); commits.set(sha, commit);
  }
  const comparison = await api(`/compare/${signer}...${current}`);
  invariant(['ahead', 'identical'].includes(comparison.status) && comparison.merge_base_commit?.sha === signer, 'Original image signer is outside protected history.');
  if (signer !== current && !trust.allowed.includes(signer)) {
    for (const sha of [signer, current]) for (const file of GHCR_RELEASE_ATTESTATION_CRITICAL_PATHS) await getFile(sha, file);
    await getFile(signer, '.github/release-image-attestation-trusted-workflow-shas');
  }
  const git = (_root, args) => {
    if (args[0] === 'merge-base') return '';
    if (args[0] === 'rev-list') { const commit = commits.get(args.at(-1)); return [commit.sha, ...commit.parents.map(value => value.sha)].join(' '); }
    const reference = args.at(-1);
    if (reference.endsWith('^{commit}')) return commits.get(reference.slice(0, -9)).sha;
    const value = cache.get(reference); if (value instanceof Error) throw value;
    invariant(value, 'Original policy requested unavailable Git evidence.');
    return args[0] === 'show' ? value.text : value.sha;
  };
  return authorizeGhcrReleaseWorkflow({ repositoryRoot: '', trustSet: trust, candidateWorkflowRevision: signer,
    currentWorkflowRevision: current, trustedMasterCommit: current, releaseCommit, git });
}

/** Reconstruct canonical receipt bytes from the registry's config digest and verify the original attestation/caller identities. */
export async function verifyOriginalImage({ api, config, component, commit, version, image, execute = execFileSync }) {
  invariant(image.manifests?.length === 1 && image.manifests[0].platform === 'linux/amd64', 'Original image receipt requires exactly linux/amd64.');
  const bytes = serializeGhcrReleaseReceipt({ repository: config.repository, ghcrImage: component.image,
    releaseTag: `v${version}`, releaseCommit: commit, imageConfigDigest: image.manifests[0].configDigest });
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'original-image-')); const file = path.join(directory, 'receipt.json');
  try {
    fs.writeFileSync(file, bytes);
    const args = ['attestation', 'verify', file, '--repo', config.repository, '--signer-workflow', `${config.repository}/.github/workflows/container.yml`,
      '--source-ref', 'refs/heads/master', '--deny-self-hosted-runners', '--limit', '100', '--format', 'json'];
    const options = { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
    const candidates = parseGhcrAttestationWorkflowCandidates(execute('gh', args, options), config.repository);
    const failures = [];
    for (const signer of candidates) {
      try {
        const policy = await authorizeOriginalImageSigner({ api, config, signer, releaseCommit: commit });
        execute('gh', [...args, '--signer-digest', signer, '--source-digest', signer], options);
        return { signer, policy, receipt: JSON.parse(bytes) };
      } catch (error) { failures.push(error.message); }
    }
    throw new Error(`No permitted original image attestation: ${failures.join('; ')}`);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
