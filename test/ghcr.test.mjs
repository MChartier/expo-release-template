/** @file OCI byte integrity and partial immutable-alias publication recovery without image execution. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { create } from 'tar';
import { inspectOciArchive, createGhcrProvider } from '../src/providers/ghcr.mjs';
import { planRelease, finalizePlan } from '../src/planner.mjs';
import { createArtifactReceipt, verifyRetainedArtifact } from '../src/artifacts.mjs';
import { executeOperation } from '../src/operations.mjs';

async function archive(t, change = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oci-integrity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const content = path.join(root, 'content'); fs.mkdirSync(path.join(content, 'blobs', 'sha256'), { recursive: true });
  const write = value => {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
    const sha = createHash('sha256').update(bytes).digest('hex');
    fs.writeFileSync(path.join(content, 'blobs/sha256', sha), bytes);
    return { digest: `sha256:${sha}`, size: bytes.length };
  };
  const layer = write(Buffer.from('inert test layer'));
  const config = write({ os: 'linux', architecture: 'amd64', rootfs: { type: 'layers', diff_ids: [] } });
  const image = write({ schemaVersion: 2, config, layers: [layer] });
  fs.writeFileSync(path.join(content, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [image] }));
  fs.writeFileSync(path.join(content, 'oci-layout'), JSON.stringify({ imageLayoutVersion: '1.0.0' }));
  change({ content, layer, config, image });
  const file = path.join(root, 'image.oci.tar');
  await create({ file, cwd: content }, ['index.json', 'oci-layout', 'blobs']);
  return { root, file };
}

test('archive validates every referenced layer and rejects corrupt bytes without uncaught stream exceptions', async t => {
  const good = await archive(t);
  assert.deepEqual((await inspectOciArchive(good.file)).manifests.map(value => value.platform), ['linux/amd64']);
  const missing = await archive(t, ({ content, layer }) => fs.rmSync(path.join(content, 'blobs/sha256', layer.digest.slice(7))));
  await assert.rejects(inspectOciArchive(missing.file), /referenced blob/);
  const corrupt = await archive(t, ({ content, layer }) => fs.appendFileSync(path.join(content, 'blobs/sha256', layer.digest.slice(7)), 'changed'));
  await assert.rejects(inspectOciArchive(corrupt.file), /blob bytes differ/);
  const traversal = await archive(t, ({ content }) => fs.writeFileSync(path.join(content, 'blobs/sha256', 'unexpected'), 'no'));
  await assert.rejects(inspectOciArchive(traversal.file), /Unexpected OCI/);
});

test('partial image aliases require explicit continuation and never overwrite an incompatible image', async t => {
  const { root, file } = await archive(t); const oci = await inspectOciArchive(file);
  const source = { repository: 'fixture/app', commit: 'a'.repeat(40), workflowCommit: 'b'.repeat(40), toolkitCommit: 'c'.repeat(40) };
  const config = { schemaVersion: 1, repository: source.repository, defaultBranch: 'main', components: [{ id: 'server', kind: 'server' }] };
  const observations = [{ id: 'server', identity: 'source', version: '1.0.0' }];
  const plan = finalizePlan(planRelease({ config, source, observations, origin: { kind: 'github', runId: '123', runAttempt: 1 } }), source, observations);
  const receipt = await createArtifactReceipt({ plan, target: 'server', directory: root });
  const sourceProof = await verifyRetainedArtifact({ plan, target: 'server', directory: root, receipt,
    verifyProducer: async () => true, verifyAttestation: async () => true });
  const aliases = new Map(); const writes = []; let fail = true;
  const transport = { inspect: async alias => aliases.get(alias) ?? null,
    publish: async (_file, names) => { for (const name of names) { writes.push(name); aliases.set(name, oci); if (fail) { fail = false; throw new Error('interrupted copy'); } } } };
  const provider = createGhcrProvider({ image: 'ghcr.io/fixture/app', source: source.commit, target: 'server', sourceProof,
    file, oci, aliases: ['v1.0.0', `sha-${source.commit}`] }, transport);
  const events = []; const ledger = { read: async () => ({ events }), append: async (_id, event) => events.push(structuredClone(event)) };
  const input = { ledger, releaseId: '456', stage: 'server:publish', provider, context: {} };
  await assert.rejects(executeOperation(input), /interrupted/);
  assert.equal((await executeOperation(input)).status, 'unknown');
  assert.deepEqual(writes, ['v1.0.0']);
  assert.equal((await executeOperation({ ...input, retry: true })).status, 'complete');
  assert.deepEqual(writes, ['v1.0.0', `sha-${source.commit}`]);
  aliases.set('v1.0.0', { ...oci, digest: `sha256:${'f'.repeat(64)}` });
  await assert.rejects(provider.resumeUnknown(), /attested OCI/);
  assert.equal(writes.length, 2);
});
