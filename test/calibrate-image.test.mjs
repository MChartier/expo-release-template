/** @file Verifies original GHCR API evidence reconstruction, retained/revoked signer policy, certificate identity and exact receipt verification arguments. */
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { authorizeOriginalImageSigner, verifyOriginalImage } from '../src/compat/calibrate-image.mjs';
import { GHCR_RELEASE_ATTESTATION_CRITICAL_PATHS, serializeGhcrReleaseReceipt } from '../src/compat/v1/ghcr-release-receipt.mjs';

const signer = '1'.repeat(40); const current = '2'.repeat(40); const releaseCommit = '3'.repeat(40);
const config = { repository: 'MChartier/calibrate-health', defaultBranch: 'master' };
const policyFile = '.github/release-image-attestation-trusted-workflow-shas';

function fixture({ policy = '', head = current, protectedBranch = true, ancestry = 'ahead', changed = false,
  parents = [signer], marker = true, missing, wrongCommit = false } = {}) {
  const requests = [];
  const api = async (route, options = {}) => {
    requests.push(route); assert.equal(options.method, undefined);
    if (route === '/branches/master') return { protected: protectedBranch, commit: { sha: head } };
    if (route.startsWith('/git/commits/')) return { sha: wrongCommit ? 'f'.repeat(40) : route.slice('/git/commits/'.length), parents: parents.map(sha => ({ sha })) };
    if (route === `/compare/${signer}...${head}`) return { status: ancestry, merge_base_commit: { sha: signer } };
    const match = /^\/contents\/(.+)\?ref=([a-f0-9]{40})$/.exec(route); assert.ok(match, `Unexpected ${route}`);
    const [, file, revision] = match;
    if (file === missing) throw new Error('Missing historical file');
    let text = file === policyFile ? policy : file === '.github/workflows/container.yml' && marker
      ? 'actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d\nattest_image_receipt:\nverify_receipt_attestation'
      : file === 'scripts/ghcr-release-receipt.mjs' ? 'image_config_digest' : 'original policy contents';
    return { type: 'file', encoding: 'base64', size: Buffer.byteLength(text), content: Buffer.from(text).toString('base64'),
      sha: (changed && revision === signer ? 'd' : 'c').repeat(40) };
  };
  return { api, requests };
}
const authorize = value => authorizeOriginalImageSigner({ api: value.api, config, signer, releaseCommit });

test('original image API adapter accepts current and explicit retained signers only within protected ancestry', async () => {
  const exact = fixture({ head: signer }); assert.equal((await authorize(exact)).mode, 'current-workflow');
  const retained = fixture({ policy: `allow ${signer}` }); assert.equal((await authorize(retained)).mode, 'explicit-retained');
  assert.equal(retained.requests.filter(route => route.startsWith('/contents/')).length, 1);
  for (const options of [{ protectedBranch: false }, { ancestry: 'diverged', policy: `allow ${signer}` }, { wrongCommit: true }]) {
    await assert.rejects(authorize(fixture(options)), /protected|exact/);
  }
  const revoked = fixture({ head: signer, policy: `revoke ${signer}` });
  await assert.rejects(authorize(revoked), /revoked/);
  assert.equal(revoked.requests.some(route => route.startsWith('/git/commits/')), false);
});

test('original image API adapter preserves unchanged tooling and canonical Cut-parent exceptions', async () => {
  const unchanged = fixture(); assert.equal((await authorize(unchanged)).mode, 'unchanged-critical-tooling');
  for (const file of GHCR_RELEASE_ATTESTATION_CRITICAL_PATHS) for (const revision of [signer, current]) {
    assert.ok(unchanged.requests.includes(`/contents/${file}?ref=${revision}`));
  }
  assert.equal((await authorize(fixture({ changed: true }))).mode, 'canonical-cut-parent');
  for (const options of [{ changed: true, parents: [signer, '4'.repeat(40)] }, { changed: true, parents: ['4'.repeat(40)] },
    { changed: true, marker: false }]) await assert.rejects(authorize(fixture(options)), /neither the post-hardening Cut parent/);
  await assert.rejects(authorize(fixture({ missing: 'scripts/release-config.mjs' })), /lacks the reviewed critical tooling/);
});

function certificate() {
  const data = JSON.parse(fs.readFileSync(new URL('./fixtures/ghcr-cut-release-attestation-verification.json', import.meta.url), 'utf8'));
  const certificate = structuredClone(data[0].verificationResult.signature.certificate);
  for (const key of ['buildSignerDigest', 'sourceRepositoryDigest', 'buildConfigDigest', 'githubWorkflowSHA']) certificate[key] = signer;
  return { verificationResult: { signature: { certificate } } };
}

const component = { image: 'ghcr.io/mchartier/calibratehealth' };
const image = { manifests: [{ platform: 'linux/amd64', configDigest: `sha256:${'e'.repeat(64)}` }] };
const expected = () => serializeGhcrReleaseReceipt({ repository: config.repository, ghcrImage: component.image,
  releaseTag: 'v0.40.3', releaseCommit, imageConfigDigest: image.manifests[0].configDigest });

test('original image receipt verification binds reconstructed bytes and both original signer/source digests', async () => {
  const value = fixture({ policy: `allow ${signer}` }); const calls = []; let file;
  const execute = (command, args, options) => {
    assert.equal(command, 'gh'); calls.push(args); file = args[2]; assert.equal(fs.readFileSync(file, 'utf8'), expected());
    assert.equal(options.encoding, 'utf8'); assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
    return JSON.stringify([certificate()]);
  };
  const result = await verifyOriginalImage({ api: value.api, config, component, image, commit: releaseCommit, version: '0.40.3', execute });
  assert.equal(result.signer, signer); assert.equal(result.policy.mode, 'explicit-retained'); assert.deepEqual(result.receipt, JSON.parse(expected()));
  assert.equal(calls.length, 2); assert.equal(calls[0][calls[0].indexOf('--signer-workflow') + 1], `${config.repository}/.github/workflows/container.yml`);
  assert.equal(calls[0][calls[0].indexOf('--source-ref') + 1], 'refs/heads/master'); assert.ok(calls[0].includes('--deny-self-hosted-runners'));
  assert.deepEqual(calls[1].slice(-4), ['--signer-digest', signer, '--source-digest', signer]);
  assert.equal(fs.existsSync(file), false);
});

test('original image verification rejects altered caller/source identities and exact verification failures, then removes temporary bytes', async () => {
  for (const [key, invalid] of [['buildConfigURI', 'https://github.com/other/repo/.github/workflows/container.yml@refs/heads/master'],
    ['sourceRepositoryDigest', current], ['githubWorkflowSHA', current], ['buildTrigger', 'workflow_dispatch'], ['runnerEnvironment', 'self-hosted']]) {
    const result = certificate(); result.verificationResult.signature.certificate[key] = invalid; let file;
    await assert.rejects(verifyOriginalImage({ api: fixture().api, config, component, image, commit: releaseCommit, version: '0.40.3',
      execute: (_command, args) => { file = args[2]; return JSON.stringify([result]); } }), /certificate does not match/);
    assert.equal(fs.existsSync(file), false);
  }
  let file;
  await assert.rejects(verifyOriginalImage({ api: fixture({ policy: `allow ${signer}` }).api, config, component, image, commit: releaseCommit, version: '0.40.3',
    execute: (_command, args) => { file = args[2]; if (args.includes('--signer-digest')) throw new Error('Exact subject verification failed'); return JSON.stringify([certificate()]); } }), /Exact subject verification failed/);
  assert.equal(fs.existsSync(file), false);
  await assert.rejects(verifyOriginalImage({ config, component, image: { manifests: [{ ...image.manifests[0], platform: 'linux/arm64' }] } }), /exactly linux\/amd64/);
});
