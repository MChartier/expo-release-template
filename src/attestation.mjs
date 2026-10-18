/** @file Fresh protected-branch signer retention/revocation with separate consumer and reusable-toolkit certificate identities. */
import { execFileSync } from 'node:child_process';
import { invariant } from '../packages/release-engine/index.mjs';
import { repositoryJson } from './trusted.mjs';

/** Parse exact reviewed allow/revoke directives; revocation always has precedence over automatic retention. */
export function parseTrustSet(text) {
  const allowed = new Set(); const revoked = new Set();
  for (const line of text.split(/\r?\n/).map(value => value.trim()).filter(value => value && !value.startsWith('#'))) {
    const match = /^(allow|revoke) ([a-f0-9]{40})$/.exec(line);
    invariant(match, 'Signer policy requires exact allow SHA or revoke SHA directives.');
    (match[1] === 'allow' ? allowed : revoked).add(match[2]);
  }
  return { allowed, revoked };
}

/** Read the latest protected consumer policy, even when recovering an older run or toolkit. */
export async function authorizeSigner({ api, config, signer, criticalFiles = [], policyFile = config.trust?.workflowFile }) {
  invariant(/^[a-f0-9]{40}$/.test(signer), 'Missing original consumer workflow revision.');
  const branch = await api(`/branches/${encodeURIComponent(config.defaultBranch)}`);
  invariant(branch.protected === true, 'Signer trust requires current protected branch authority.');
  const current = branch.commit.sha;
  let trust = { allowed: new Set(), revoked: new Set() };
  if (policyFile) {
    const file = await api(`/contents/${policyFile}?ref=${current}`);
    invariant(file.type === 'file' && file.encoding === 'base64' && file.size < 1024 * 1024, 'Signer trust policy is invalid.');
    trust = parseTrustSet(Buffer.from(file.content, 'base64').toString('utf8'));
  }
  invariant(!trust.revoked.has(signer), 'Original artifact workflow signer is revoked by current protected policy.');
  const ancestry = await api(`/compare/${signer}...${current}`);
  invariant(['ahead', 'identical'].includes(ancestry.status) && ancestry.merge_base_commit?.sha === signer, 'Original signer is outside protected branch history.');
  if (signer === current || trust.allowed.has(signer)) return { signer, current, mode: signer === current ? 'current' : 'retained' };
  invariant(criticalFiles.length > 0, 'An older changed workflow requires explicit signer retention.');
  for (const path of criticalFiles) {
    const original = await api(`/contents/${path}?ref=${signer}`);
    const latest = await api(`/contents/${path}?ref=${current}`);
    invariant(original.type === 'file' && latest.type === 'file' && original.sha === latest.sha, 'Critical artifact tooling changed; explicitly retain its original signer for recovery.');
  }
  return { signer, current, mode: 'unchanged-critical-tooling' };
}

/** Verify retained common receipt bytes against the exact reusable signer and original consumer workflow independently. */
export async function verifyReceiptAttestation({ api, config, receipt, file, execute = execFileSync }) {
  invariant(receipt.origin?.kind === 'github', 'Local receipts cannot acquire protected hosted provenance.');
  const producer = receipt.producer;
  invariant(producer?.workflowCommit && producer.toolkitCommit, 'Artifact is missing its actual producing workflow identities.');
  await authorizeSigner({ api, config, signer: producer.workflowCommit,
    criticalFiles: ['release.config.json', 'package.json', `.github/workflows/${config.github.handlerWorkflow}`],
    policyFile: receipt.metadata?.kind === 'native' || receipt.metadata?.kind === 'ota' ? config.trust?.nativeWorkflowFile ?? config.trust?.workflowFile : config.trust?.workflowFile });
  const original = await repositoryJson(api, 'package.json', producer.workflowCommit);
  invariant((original.devDependencies?.['@mchartier/expo-release'] ?? original.dependencies?.['@mchartier/expo-release'])
    === `git+https://github.com/MChartier/expo-release-template.git#${producer.toolkitCommit}`, 'Original workflow did not pin the artifact toolkit revision.');
  const text = execute('gh', ['attestation', 'verify', file, '--repo', config.repository,
    '--signer-workflow', 'MChartier/expo-release-template/.github/workflows/release-attest.yml',
    '--signer-digest', producer.toolkitCommit, '--source-digest', producer.workflowCommit,
    '--source-ref', `refs/heads/${config.defaultBranch}`, '--deny-self-hosted-runners', '--limit', '100', '--format', 'json'], {
    encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const results = JSON.parse(text);
  invariant(Array.isArray(results) && results.length > 0 && results.length <= 100, 'No matching artifact attestation.');
  const expectedCaller = `https://github.com/${config.repository}/.github/workflows/${config.github.handlerWorkflow}@refs/heads/${config.defaultBranch}`;
  invariant(results.some(result => {
    const certificate = result.verificationResult?.signature?.certificate;
    return certificate?.buildSignerDigest === producer.toolkitCommit && certificate.sourceRepositoryDigest === producer.workflowCommit
      && certificate.buildConfigDigest === producer.workflowCommit && certificate.buildConfigURI === expectedCaller
      && certificate.buildTrigger === 'workflow_run' && certificate.runnerEnvironment === 'github-hosted';
  }), 'Artifact certificate does not bind the original consumer and shared signer independently.');
  return true;
}

/** Verify an original-format receipt using its historical workflow path and source identity, never the new toolkit's SHA. */
export async function verifyHistoricalAttestation({ api, config, file, signer, workflow, criticalFiles, policyFile, execute = execFileSync }) {
  await authorizeSigner({ api, config, signer, criticalFiles, policyFile });
  execute('gh', ['attestation', 'verify', file, '--repo', config.repository, '--signer-workflow', `${config.repository}/${workflow}`,
    '--signer-digest', signer, '--source-digest', signer, '--source-ref', `refs/heads/${config.legacy?.defaultBranch ?? config.defaultBranch}`,
    '--deny-self-hosted-runners', '--limit', '100'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  return true;
}
