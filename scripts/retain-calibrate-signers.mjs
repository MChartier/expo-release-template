/** @file Preserve exactly the pre-extraction image signers accepted for existing canonical release tags. No registry or publication mutation occurs. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { authorizeGhcrReleaseWorkflow } from '../src/compat/v1/ghcr-release-receipt.mjs';
const root = path.resolve(process.argv[2]);
const current = 'efb7c77615ed5144deb13fe939bf84190e1638cc';
const policyFile = '.github/release-image-attestation-trusted-workflow-shas';
const git = (_root, args) => execFileSync('git', ['--no-replace-objects', ...args], { cwd: root, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const policy = git(root, ['show', `${current}:${policyFile}`]);
const retained = [];
for (const tag of git(root, ['tag', '--list', 'v*']).split(/\r?\n/)) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) continue;
  const commit = git(root, ['rev-parse', `${tag}^{commit}`]);
  const parents = git(root, ['rev-list', '--parents', '-n', '1', commit]).split(' ').slice(1);
  for (const signer of parents) {
    try {
      const evidence = authorizeGhcrReleaseWorkflow({ repositoryRoot: root, trustSet: policy, candidateWorkflowRevision: signer,
        currentWorkflowRevision: current, trustedMasterCommit: current, releaseCommit: commit, git });
      retained.push({ tag, commit, signer, policy: evidence.mode });
    } catch { /* A legacy/pre-hardening tag does not acquire authority through this migration. */ }
  }
}
if (!retained.some(value => value.tag === 'v0.40.3')) throw new Error('Current retained release signer was not authorized by the original policy.');
fs.writeFileSync(new URL('../test/fixtures/calibrate/retained-image-signers.json', import.meta.url), `${JSON.stringify({ schemaVersion: 1, policySource: current, retained }, null, 2)}\n`);
const additions = [...new Set(retained.map(value => value.signer))].filter(signer => !policy.includes(`allow ${signer}`));
fs.writeFileSync(path.join(root, policyFile), `${policy}\n\n# Preserve pre-extraction canonical release signers after moving their critical tooling upstream.\n# Each was accepted by the original policy at ${current}.\n${additions.map(signer => `allow ${signer}`).join('\n')}\n`);
console.log(`Preserved ${additions.length} previously authorized signers for ${retained.length} release tags.`);
