/** @file Interrupted retention preserves original producer and bytes across every upload/checkpoint boundary. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createArtifactManifest } from '../packages/release-engine/index.mjs';
import { retainArtifact, restoreArtifact, retentionRecovery } from '../src/retention.mjs';

test('each interrupted upload resumes identical bytes and preserves the original cohort archive', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'retention-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const directory = path.join(root, 'built'); fs.mkdirSync(directory);
  fs.writeFileSync(path.join(directory, 'app.aab'), 'original application'); fs.writeFileSync(path.join(directory, 'app.apk'), 'original install');
  const receipt = { target: 'phone', producer: { origin: { kind: 'github', runId: '123', runAttempt: 2 }, workflowCommit: 'a'.repeat(40), toolkitCommit: 'b'.repeat(40) },
    manifest: await createArtifactManifest(directory) };
  const staging = { runId: '123', runAttempt: 2, name: 'artifact-phone-2' };
  for (let boundary = 1; boundary <= 5; boundary += 1) {
    const state = { events: [], assets: [] }; let writes = 0; let armed = true;
    const fail = () => { writes += 1; if (armed && writes === boundary) { armed = false; throw new Error('interrupted'); } };
    const ledger = { read: async () => state,
      async append(_id, event) { fail(); state.events.push(event); },
      async upload(_id, name, bytes) {
        fail(); const old = state.assets.find(value => value.name === name);
        if (old) { assert.deepEqual(old.bytes, bytes); return old; }
        const asset = { id: state.assets.length + 1, name, bytes, size: bytes.length }; state.assets.push(asset); return asset;
      },
      async download(asset, digest, file) {
        assert.equal(createHash('sha256').update(asset.bytes).digest('hex'), digest);
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, asset.bytes);
      } };
    const args = { ledger, releaseId: 1, receipt, directory, staging, verify: async value => value.producer };
    await assert.rejects(retainArtifact(args), /interrupted/);
    const recovered = await retainArtifact(args);
    assert.deepEqual(retentionRecovery(state, ['phone', 'wear']), staging);
    assert.equal(state.events.filter(event => event.type === 'artifact').length, 1);
    const restored = await restoreArtifact({ ledger, releaseId: 1, target: 'phone', directory: path.join(root, `restored-${boundary}`), verify: args.verify });
    assert.deepEqual(restored.receipt, receipt); assert.deepEqual(recovered.receipt.producer, receipt.producer);
    await assert.rejects(retainArtifact({ ...args, receipt: { ...receipt, producer: { ...receipt.producer, origin: { kind: 'github', runId: '999', runAttempt: 1 } } } }), /already began/);
    state.assets.pop();
    await assert.rejects(restoreArtifact({ ledger, releaseId: 1, target: 'phone', directory: path.join(root, `missing-${boundary}`), verify: args.verify }), /missing/);
  }
});
