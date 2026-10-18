/** @file Source-free OCI publication and exact registry readback; existing aliases require retained provenance before reuse. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { list } from 'tar';
import { invariant, hashIdentity } from '../../packages/release-engine/index.mjs';
import { isVerifiedSourceProof } from '../artifacts.mjs';

const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const DIGEST = /^sha256:[a-f0-9]{64}$/;

/** Inspect archive streams without extracting files or executing the image, and verify every OCI-addressed blob. */
export async function inspectOciArchive(file) {
  const objects = new Map(); const blobs = new Map(); const names = new Set();
  let index; let totalMetadata = 0; let failure; let totalBytes = 0;
  await list({ file, strict: true, onentry(entry) {
    const name = entry.path.replace(/^\.\//, '').replace(/\/$/, '');
    try {
      invariant(['File', 'Directory'].includes(entry.type) && !entry.linkpath, 'OCI archives may contain only regular files/directories.');
      invariant(['', 'blobs', 'blobs/sha256', 'oci-layout', 'index.json'].includes(name) || /^blobs\/sha256\/[a-f0-9]{64}$/.test(name), 'Unexpected OCI archive path.');
      invariant(!names.has(name) && names.size < 20000, 'Duplicate or excessive OCI archive entries.');
      names.add(name); totalBytes += entry.size;
      invariant(totalBytes <= 20 * 1024 ** 3, 'OCI archive exceeds its size bound.');
    } catch (error) { failure ??= error; entry.resume(); return; }
    if (entry.type === 'Directory') { entry.resume(); return; }
    const hash = createHash('sha256'); const pieces = []; let bytes = 0;
    entry.on('data', chunk => { hash.update(chunk); bytes += chunk.length; if (entry.size <= 1024 * 1024) pieces.push(chunk); });
    entry.on('end', () => {
      try {
      const actual = hash.digest('hex');
      invariant(bytes === entry.size && (!name.startsWith('blobs/') || name.endsWith(actual)), 'OCI blob bytes differ from their digest.');
      if (name.startsWith('blobs/')) blobs.set(`sha256:${actual}`, bytes);
      if (!pieces.length) return;
      const raw = Buffer.concat(pieces); let value;
      try { value = JSON.parse(raw); } catch { return; }
      if (name === 'index.json') index = value;
      else if (name.startsWith('blobs/') && (value.schemaVersion === 2 || value.rootfs)) {
        totalMetadata += bytes;
        invariant(totalMetadata <= 64 * 1024 * 1024 && !objects.has(`sha256:${actual}`), 'OCI metadata is duplicated or too large.');
        objects.set(`sha256:${actual}`, value);
      }
      } catch (error) { failure ??= error; }
    });
  } });
  if (failure) throw failure;
  invariant(index?.schemaVersion === 2 && index.manifests?.length === 1 && DIGEST.test(index.manifests[0].digest), 'OCI archive must identify exactly one image/index.');
  const manifests = [];
  const visited = new Set();
  const verifyReference = reference => invariant(DIGEST.test(reference?.digest) && Number.isSafeInteger(reference.size)
    && blobs.get(reference.digest) === reference.size, 'OCI referenced blob is missing or has a different size.');
  const visit = (reference, depth = 0) => {
    verifyReference(reference);
    invariant(depth < 8 && !visited.has(reference.digest), 'OCI graph is cyclic, duplicated or too deep.');
    visited.add(reference.digest);
    const value = objects.get(reference.digest);
    invariant(value?.schemaVersion === 2, 'OCI manifest is missing.');
    if (value.manifests) { invariant(Array.isArray(value.manifests) && value.manifests.length > 0, 'Empty OCI index.');
      for (const child of value.manifests) visit(child, depth + 1); return; }
    invariant(DIGEST.test(value.config?.digest) && Array.isArray(value.layers), 'Invalid OCI image manifest.');
    const config = objects.get(value.config.digest);
    verifyReference(value.config);
    for (const layer of value.layers) verifyReference(layer);
    invariant(config && config.os === 'linux' && ['amd64', 'arm64'].includes(config.architecture), 'Unsupported OCI target platform.');
    manifests.push({ digest: reference.digest, configDigest: value.config.digest, platform: `${config.os}/${config.architecture}` });
  };
  visit(index.manifests[0]);
  invariant(new Set(manifests.map(value => value.platform)).size === manifests.length, 'Duplicate OCI platform.');
  return { digest: index.manifests[0].digest, manifests: manifests.sort((a, b) => a.platform.localeCompare(b.platform)) };
}

/** Read GHCR content through fixed HTTPS endpoints; explicit manifest absence alone is classified as not published. */
export function createGhcrTransport({ image, username, token, request = fetch, run = execFileSync }) {
  invariant(/^ghcr\.io\/[a-z0-9._-]+\/[a-z0-9._/-]+$/.test(image) && !image.includes('..'), 'Invalid GHCR repository.');
  const name = image.slice('ghcr.io/'.length);
  const registry = async (kind, reference) => {
    invariant(DIGEST.test(reference) || /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(reference), 'Invalid OCI reference.');
    const auth = await request(`https://ghcr.io/token?service=ghcr.io&scope=${encodeURIComponent(`repository:${name}:pull`)}`, {
      redirect: 'error', signal: AbortSignal.timeout(60000), headers: token ? { Authorization: `Basic ${Buffer.from(`${username}:${token}`).toString('base64')}` } : {} });
    invariant(auth.ok, 'GHCR authentication failed.');
    const bearer = (await auth.json()).token;
    const response = await request(`https://ghcr.io/v2/${name}/${kind}/${reference}`, { redirect: 'manual', signal: AbortSignal.timeout(60000),
      headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/vnd.oci.image.index.v1+json,application/vnd.oci.image.manifest.v1+json,application/vnd.docker.distribution.manifest.list.v2+json,application/vnd.docker.distribution.manifest.v2+json' } });
    if (response.status === 404 && kind === 'manifests') {
      const error = await response.json();
      invariant(error.errors?.length && error.errors.every(value => value.code === 'MANIFEST_UNKNOWN'), 'Registry failure is not verified manifest absence.');
      return null;
    }
    let final = response;
    if (response.status === 307 && kind === 'blobs') {
      const url = new URL(response.headers.get('location'));
      invariant(url.protocol === 'https:' && !url.username && !url.password && (url.hostname.endsWith('.githubusercontent.com') || url.hostname.endsWith('.blob.core.windows.net')), 'Unexpected OCI blob download origin.');
      final = await request(url, { redirect: 'error', signal: AbortSignal.timeout(60000) });
    }
    invariant(final.ok, 'Registry observation failed.');
    const bytes = Buffer.from(await final.arrayBuffer());
    invariant(bytes.length <= 16 * 1024 * 1024, 'Registry metadata is too large.');
    if (DIGEST.test(reference)) invariant(digest(bytes) === reference, 'Registry metadata digest differs.');
    return { digest: digest(bytes), value: JSON.parse(bytes) };
  };
  return {
    /** Read exact registry metadata; historical identity checks may request labels and verified attestation filtering. */
    async inspect(reference, { includeLabels = false } = {}) {
      const top = await registry('manifests', reference);
      if (!top) return null;
      const manifests = [];
      const visit = async item => {
        if (item.value.manifests) {
          for (const child of item.value.manifests) {
            const next = await registry('manifests', child.digest);
            invariant(next, 'Registry child manifest is unavailable.');
            if (includeLabels && child.annotations?.['vnd.docker.reference.type'] === 'attestation-manifest') {
              const reference = child.annotations['vnd.docker.reference.digest'];
              invariant(child.mediaType === 'application/vnd.oci.image.manifest.v1+json'
                && child.platform?.os === 'unknown' && child.platform?.architecture === 'unknown'
                && DIGEST.test(reference) && item.value.manifests.some(value => value.digest === reference && value.platform?.os === 'linux'
                  && ['amd64', 'arm64'].includes(value.platform.architecture))
                && next.value.layers?.length && next.value.layers.every(value => value.mediaType === 'application/vnd.in-toto+json'),
              'Unrecognized historical attestation descriptor.');
              continue;
            }
            await visit(next);
          }
          return;
        }
        const config = await registry('blobs', item.value.config.digest);
        invariant(config && config.value.os === 'linux', 'Invalid registry image configuration.');
        manifests.push({ digest: item.digest, configDigest: config.digest, platform: `${config.value.os}/${config.value.architecture}`,
          ...(includeLabels ? { labels: config.value.config?.Labels ?? {} } : {}) });
      };
      await visit(top);
      return { digest: top.digest, manifests: manifests.sort((a, b) => a.platform.localeCompare(b.platform)) };
    },
    async publish(file, aliases) {
      invariant(username && token, 'GHCR publication credentials are required.');
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-registry-'));
      const authfile = path.join(root, 'auth.json');
      try {
        fs.writeFileSync(authfile, JSON.stringify({ auths: { 'ghcr.io': { auth: Buffer.from(`${username}:${token}`).toString('base64') } } }), { mode: 0o600 });
        for (const alias of aliases) {
          invariant(/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(alias), 'Invalid publication alias.');
          run('skopeo', ['copy', '--all', '--preserve-digests', '--authfile', authfile, `oci-archive:${file}`, `docker://${image}:${alias}`], {
            windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], timeout: 1200000 });
        }
      } catch { throw new Error('Image publication did not complete; inspect each exact alias before resuming.'); }
      finally { fs.rmSync(root, { recursive: true, force: true }); }
    }
  };
}

/** Verify aliases against an attested archive before publication; partial alias completion is recovered by readback. */
export function createGhcrProvider(spec, transport) {
  const proof = observed => {
    invariant(isVerifiedSourceProof(spec.sourceProof, { source: spec.source, target: spec.target }), 'Image publication requires hosted retained source proof.');
    invariant(observed && observed.digest === spec.oci.digest && hashIdentity(observed.manifests) === hashIdentity(spec.oci.manifests), 'Existing image does not reconstruct the attested OCI receipt.');
    return { image: spec.image, digest: observed.digest, source: spec.source, manifests: observed.manifests };
  };
  const observe = async () => {
    const aliases = {};
    for (const alias of spec.aliases) { const value = await transport.inspect(alias); if (value) proof(value); aliases[alias] = value; }
    const present = Object.values(aliases).filter(Boolean);
    return { id: spec.oci.digest, status: present.length === spec.aliases.length ? 'complete' : 'unknown', aliases };
  };
  return {
    async find() { const value = await observe(); return Object.values(value.aliases).some(Boolean) ? value : null; },
    async status() { return observe(); },
    async verify(value) {
      for (const observed of Object.values(value.aliases)) if (observed) proof(observed);
      return { image: spec.image, digest: spec.oci.digest, aliases: Object.fromEntries(Object.entries(value.aliases).map(([alias, observed]) => [alias, Boolean(observed)])) };
    },
    async start() {
      const actual = await inspectOciArchive(spec.file);
      proof(actual);
      const missing = [];
      for (const alias of spec.aliases) { const observed = await transport.inspect(alias); if (observed) proof(observed); else missing.push(alias); }
      await transport.publish(spec.file, missing);
      return { id: spec.oci.digest };
    },
    /** Only immutable aliases may be completed after fresh exact-byte verification and explicit recovery. */
    async resumeUnknown() {
      proof(await inspectOciArchive(spec.file));
      const actual = await observe();
      const missing = Object.entries(actual.aliases).filter(([, value]) => !value).map(([alias]) => alias);
      if (missing.length) await transport.publish(spec.file, missing);
      return observe();
    }
  };
}
