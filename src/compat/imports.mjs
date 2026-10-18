/** @file Hydrates explicit imported cloud baselines and legacy server tags through read-only live provider verification, without creating release history. */
import fs from 'node:fs';
import { hashIdentity, immutable, invariant } from '../../packages/release-engine/index.mjs';
import { repositoryPath } from '../config.mjs';
import { baselineKey, configuredComponents, runtimeBaselineKey } from '../planner.mjs';
import { resolveExpoConfiguration } from '../environment.mjs';
import { createEasTransport, verifyEasBuild } from '../providers/eas.mjs';
import { createGhcrTransport } from '../providers/ghcr.mjs';
import { verifyOriginalImage } from './calibrate-image.mjs';

const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const versionOrder = (a, b) => {
  const aa = a.split('.').map(Number); const bb = b.split('.').map(Number);
  return aa[0] - bb[0] || aa[1] - bb[1] || aa[2] - bb[2];
};

async function ancestor(api, commit, source) {
  invariant(SHA.test(commit) && SHA.test(source), 'Imported source requires exact Git commits.');
  const comparison = await api(`/compare/${commit}...${source}`);
  return ['ahead', 'identical'].includes(comparison.status) && comparison.merge_base_commit?.sha === commit;
}

function reserve(config, result, component, value) {
  const group = config.versionGroups?.find(item => item.targets.includes(component.id));
  if (!group) return;
  const previous = result.reservations[group.id] || { version: value.version, codes: {} };
  const version = versionOrder(previous.version, value.version) >= 0 ? previous.version : value.version;
  result.reservations[group.id] = { version, codes: { ...previous.codes,
    ...(value.versionCode ? { [component.id]: Math.max(previous.codes?.[component.id] || 0, value.versionCode) } : {}) } };
}

/** Verify original cloud build identity and exact bytes, preserving the committed import record with an explicit non-hosted origin. */
export async function verifyImportedCloudBaseline({ config, value, source, profile, api, expo, transport }) {
  invariant([2, 3].includes(value?.schema) && value.profile === profile && SHA.test(value.commit) && UUID.test(value.buildId)
    && ['android', 'ios'].includes(value.platform) && HASH.test(value.environmentHash) && HASH.test(value.artifactSha256)
    && /^[a-f0-9]{40,64}$/.test(value.fingerprint) && /^[a-f0-9]{40,64}$/.test(value.compatibility), 'Imported cloud baseline has incomplete original evidence.');
  const matches = configuredComponents(config, profile).filter(item => item.kind === 'native' && item.platform === value.platform
    && (!value.target || item.id === value.target));
  invariant(matches.length === 1, 'Imported cloud baseline must identify one configured native target.');
  const component = matches[0]; const release = value.release;
  invariant(release && VERSION.test(release.version) && release.expoProjectId === expo.projectId && release.expoOwner === expo.owner
    && release.serverUrl === expo.serverUrl && value.channel === component.channel && value.environment === component.environment,
  'Imported cloud project/server/channel/environment differs from configured identity.');
  invariant(value.schema === 2 ? (component.runtimePolicy ?? 'appVersion') === 'appVersion' && value.runtimeVersion === release.version
    : component.runtimePolicy === 'fingerprint' && value.runtimePolicy === 'fingerprint' && value.runtimeVersion === value.fingerprint,
  'Imported runtime policy differs.');
  const versionCode = Number(value.platform === 'android' ? release.androidVersionCode : release.iosBuildNumber);
  invariant(Number.isSafeInteger(versionCode) && versionCode > 0 && await ancestor(api, value.commit, source.commit), 'Imported cloud source/version is invalid or not an ancestor.');
  const expected = { projectId: expo.projectId, applicationId: component.applicationId, source: value.commit, platform: component.platform,
    profile: component.profile, version: release.version, versionCode, runtime: value.runtimeVersion,
    channel: component.channel, distribution: component.distribution, fingerprint: value.fingerprint };
  const build = verifyEasBuild(await transport.getBuild(value.buildId), expected);
  invariant(build.id === value.buildId && build.status === 'FINISHED', 'Imported EAS build is not the exact finished operation.');
  const digest = await transport.hashArtifact(build.artifacts?.applicationArchiveUrl || build.artifacts?.buildUrl);
  invariant(digest === value.artifactSha256, 'Imported cloud artifact bytes changed.');
  const origin = { kind: 'imported', provider: 'eas', policySource: source.commit, buildId: value.buildId };
  return { component, value: { identity: hashIdentity({ identity: value.compatibility, environment: value.environmentHash }),
    compatibilityIdentity: value.compatibility, source: value.commit, origin, runtime: value.runtimeVersion,
    version: release.version, versionCode, fingerprint: value.fingerprint, environmentHash: value.environmentHash, releaseMetadata: release,
    importEvidence: { kind: 'verified-cloud-import', original: value, originalDigest: hashIdentity(value), buildId: build.id, artifactSha256: digest } } };
}

/** Verify legacy stable-tag images against both immutable aliases, all required architectures and original OCI identity labels. */
export async function bootstrapServerBaseline({ config, component, source, api, transport, inputIdentity, verifyImage = verifyOriginalImage }) {
  const tags = (await api.pages('/tags')).filter(item => /^v\d+\.\d+\.\d+$/.test(item.name) && SHA.test(item.commit?.sha))
    .sort((a, b) => versionOrder(b.name.slice(1), a.name.slice(1)));
  for (const tag of tags) {
    if (!await ancestor(api, tag.commit.sha, source.commit)) continue;
    const version = tag.name.slice(1); const commit = tag.commit.sha;
    const versioned = await transport.inspect(tag.name, { includeLabels: true });
    const revision = await transport.inspect(`sha-${commit}`, { includeLabels: true });
    if (!versioned && !revision) continue;
    invariant(!versioned || !revision || versioned.digest === revision.digest, 'Legacy image immutable aliases conflict.');
    const image = versioned || revision;
    invariant(/^sha256:[a-f0-9]{64}$/.test(image.digest) && Array.isArray(image.manifests), 'Legacy image lacks exact registry proof.');
    const required = component.platforms || ['linux/amd64'];
    invariant(image.manifests.length === required.length && new Set(image.manifests.map(item => item.platform)).size === required.length
      && required.every(platform => image.manifests.some(item => item.platform === platform)), 'Legacy image platform inventory differs.');
    for (const manifest of image.manifests) invariant(/^sha256:[a-f0-9]{64}$/.test(manifest.digest)
      && manifest.labels?.['org.opencontainers.image.revision'] === commit && manifest.labels['org.opencontainers.image.version'] === version
      && manifest.labels['org.opencontainers.image.source']?.toLowerCase() === `https://github.com/${config.repository}`.toLowerCase(),
    'Legacy image source/revision/version labels differ.');
    const attestation = config.legacy?.format === 'calibrate-v1' ? await verifyImage({ api, config, component, commit, version, image }) : null;
    const input = inputIdentity ? await inputIdentity({ component, source: commit }) : null;
    invariant(input === null || typeof input === 'string' && input, 'Legacy server input inspection returned no identity.');
    return { source: commit, version, image: component.image, digest: image.digest,
      ...(input ? { identity: hashIdentity({ identity: input, environment: null }) } : { requiresSourceIdentity: true }),
      origin: { kind: 'imported', provider: 'ghcr', tag: tag.name, policySource: source.commit },
      importEvidence: { kind: 'verified-server-bootstrap', tag: tag.name, aliases: { version: Boolean(versioned), revision: Boolean(revision) }, manifests: image.manifests,
        ...(attestation ? { attestation } : {}) } };
  }
  return null;
}

/**
 * Hydrate configured imports and verified ancestor images without journal writes. Supplied policy/expo JSON
 * lets privileged callers avoid application filesystem reads; inputIdentity is only for source-only callers.
 * Existing successful ledger baselines win; conflicting runtime proof fails, and imported counters reserve
 * their original versions. bootstrap entries lacking input identity require application source inspection.
 */
export async function hydrateBaselines({ config, baseline = {}, root = process.cwd(), source, api, profile = config.defaultProfile ?? '', policy,
  providers = {} }) {
  invariant(source?.repository === config.repository && SHA.test(source.commit), 'Baseline hydration requires exact application source.');
  const support = policy ?? (config.policy?.runtimeSupportFile ? JSON.parse(fs.readFileSync(repositoryPath(root, config.policy.runtimeSupportFile), 'utf8')) : { schema: 1, importedBaselines: [] });
  invariant((support.schemaVersion ?? support.schema) === 1 && Array.isArray(support.importedBaselines ?? []), 'Invalid committed import policy.');
  const result = { ...structuredClone(baseline), components: { ...baseline.components }, runtimes: { ...baseline.runtimes }, reservations: structuredClone(baseline.reservations || {}) };
  const imported = (support.importedBaselines || []).filter(value => value.profile === profile);
  if (imported.length) {
    const expo = providers.expo || resolveExpoConfiguration(config, root); invariant(expo, 'Imported cloud baseline requires configured Expo identity.');
    const transport = providers.eas || createEasTransport();
    const nativeImports = {};
    for (const original of imported) {
      const { component, value } = await verifyImportedCloudBaseline({ config, value: original, source, profile, api, expo, transport });
      const key = baselineKey(component, profile); const runtimeKey = runtimeBaselineKey(component, profile, value.runtime);
      const previous = result.runtimes[runtimeKey] || result.components[key]?.runtime === value.runtime && result.components[key];
      invariant(!previous || previous.fingerprint === value.fingerprint && previous.environmentHash === value.environmentHash, 'Imported runtime conflicts with retained native proof.');
      if (!result.runtimes[runtimeKey]) result.runtimes[runtimeKey] = value;
      nativeImports[key] = value; reserve(config, result, component, value);
    }
    result.components = { ...nativeImports, ...result.components };
  }
  for (const component of configuredComponents(config, profile).filter(value => value.kind === 'server' && value.image?.startsWith('ghcr.io/'))) {
    const key = baselineKey(component, profile); if (result.components[key]) continue;
    const transport = providers.ghcr ? await providers.ghcr(component) : createGhcrTransport({ image: component.image,
      username: process.env.GITHUB_ACTOR, token: process.env.GHCR_TOKEN || process.env.GITHUB_TOKEN || process.env.GH_TOKEN });
    const value = await bootstrapServerBaseline({ config, component, source, api, transport, inputIdentity: providers.inputIdentity });
    if (value) { result.components[key] = value; reserve(config, result, component, value); }
  }
  return immutable(result);
}
