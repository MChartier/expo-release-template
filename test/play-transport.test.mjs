/** @file Official client bindings retain application identity, atomic commit policy, no retries and secret-free failures. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createGooglePlayPublisher, resolveGooglePlayAccessToken } from '../src/providers/play-transport.mjs';

test('all official API calls bind the same app, disable replay and preserve review protection', async t => {
  const calls = []; let fail = false;
  const method = name => async (params, options) => {
    calls.push({ name, params }); assert.equal(params.packageName, 'app.fixture'); assert.equal(options.retry, false); assert.equal(options.maxRedirects, 0);
    if (fail) throw { response: { status: 503 }, message: 'secret-token' };
    return { data: { id: 'edit', bundles: [] } };
  };
  const provider = createGooglePlayPublisher({ applicationId: 'app.fixture', accessToken: 'secret-token', createClient: options => {
    assert.equal(options.retry, false); assert.equal(options.auth.credentials.access_token, 'secret-token');
    return { edits: { insert: method('insert'), delete: method('delete'), commit: method('commit'),
      tracks: { get: method('get'), update: method('update') }, bundles: { list: method('list'), upload: method('upload') } } };
  } });
  assert.equal(await provider.createEdit(), 'edit'); await provider.getTrack('edit', 'internal'); await provider.listBundles('edit');
  await provider.updateTrack('edit', 'internal', { versionCodes: ['7'], status: 'completed' }); await provider.commitEdit('edit');
  assert.equal(calls.at(-1).params.changesInReviewBehavior, 'ERROR_IF_IN_REVIEW');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'play-transport-')); t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const file = path.join(directory, 'app.aab'); fs.writeFileSync(file, 'verified');
  assert.throws(() => provider.uploadBundle('edit', file, '0'.repeat(64)), /changed/);
  await provider.uploadBundle('edit', file, createHash('sha256').update('verified').digest('hex'));
  let bytes = ''; for await (const chunk of calls.at(-1).params.media.body) bytes += chunk.toString(); assert.equal(bytes, 'verified');
  fail = true; const count = calls.length;
  await assert.rejects(provider.commitEdit('edit'), error => /503/.test(error.message) && !error.message.includes('secret-token'));
  assert.equal(calls.length, count + 1);
});

test('credential resolution requires an explicit key or token instead of ambient Google identity', async () => {
  await assert.rejects(resolveGooglePlayAccessToken({ environment: {} }), /credentials are missing/);
  assert.equal(await resolveGooglePlayAccessToken({ environment: { GOOGLE_PLAY_ACCESS_TOKEN: ' provided ' } }), 'provided');
});
