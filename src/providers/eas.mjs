/** @file Pinned EAS transports and verified provider observations; the shared executor owns durable intents, polling, and retry decisions. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createReadStream, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { isVerifiedSourceProof } from '../artifacts.mjs';
import { hashIdentity } from '../../packages/release-engine/index.mjs';

const require = createRequire(import.meta.url);
const VERSION = '22.4.0';
const UUID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const SHA256 = /^[a-f0-9]{64}$/;
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const same = (a, b) => a === b || a !== undefined && b !== undefined && hashIdentity(a) === hashIdentity(b);
const platform = value => String(value ?? '').toLowerCase();
const observation = raw => ({ id: raw.id, status: raw.status === 'FINISHED' ? 'complete'
  : ['ERRORED', 'CANCELED'].includes(raw.status) ? 'failed'
    : ['NEW', 'IN_QUEUE', 'IN_PROGRESS', 'AWAITING_BUILD', 'PENDING_CANCEL'].includes(raw.status) ? 'accepted' : 'unknown', raw });

async function digestStream(stream) {
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of stream) { hash.update(chunk); bytes += chunk.length; }
  assert(bytes > 0, 'Artifact is empty.');
  return hash.digest('hex');
}

/** Hash exact downloaded artifact bytes without exposing temporary download URLs or authorization headers. */
export async function hashRemoteArtifact(url, headers = {}, fetcher = fetch) {
  assert(typeof url === 'string' && new URL(url).protocol === 'https:', 'Artifact download requires HTTPS.');
  const response = await fetcher(url, { headers, signal: AbortSignal.timeout(300000) });
  assert(response.ok && response.body, 'Provider artifact is unavailable.');
  return digestStream(response.body);
}

/** Hash the referenced retained export files before publication, refusing symlinks and paths escaping the export. */
export async function exportPayload(directory, selectedPlatform) {
  const root = resolve(directory);
  const file = name => {
    assert(typeof name === 'string' && name && !name.includes('\\') && !name.includes(':') && !name.startsWith('/'), 'Unsafe export asset path.');
    const parts = name.split('/');
    assert(parts.every(part => part && part !== '.' && part !== '..'), 'Unsafe export asset path.');
    const result = resolve(root, name); const rel = relative(root, result);
    assert(rel && !rel.startsWith(`..${sep}`) && !isAbsolute(rel), 'Export asset escapes its root.');
    let current = root;
    assert(lstatSync(current).isDirectory() && !lstatSync(current).isSymbolicLink(), 'Export root must be a real directory.');
    for (const part of parts) { current = resolve(current, part); assert(!lstatSync(current).isSymbolicLink(), 'Export contains a symbolic link.'); }
    assert(lstatSync(result).isFile(), 'Export asset must be a regular file.'); return result;
  };
  const metadata = JSON.parse(readFileSync(file('metadata.json'), 'utf8')).fileMetadata?.[selectedPlatform];
  assert(metadata?.bundle && Array.isArray(metadata.assets), 'Missing exported platform metadata.');
  const hash = async name => Buffer.from(await digestStream(createReadStream(file(name))), 'hex').toString('base64url');
  return { launch: await hash(metadata.bundle), assets: [...new Set(await Promise.all(metadata.assets.map(asset => hash(asset.path))))].sort() };
}

/** Create a package-relative pinned EAS transport; only build commands intentionally evaluate authenticated application configuration. */
export function resolveEasCli() {
  const manifest = require.resolve('eas-cli/package.json');
  assert(JSON.parse(readFileSync(manifest, 'utf8')).version === VERSION, `Expected EAS CLI ${VERSION}.`);
  return resolve(dirname(manifest), 'bin/run');
}

/** Create a package-relative pinned EAS transport; only build commands intentionally evaluate authenticated application configuration. */
export function createEasTransport({ cwd = process.cwd(), env = process.env, run = execFileSync, fetch: fetcher = fetch } = {}) {
  const location = () => {
    const manifest = require.resolve('eas-cli/package.json');
    assert(JSON.parse(readFileSync(manifest, 'utf8')).version === VERSION, `Expected EAS CLI ${VERSION}.`);
    return dirname(manifest);
  };
  const sdk = name => require(resolve(location(), 'build', name));
  const client = () => {
    const SessionManager = sdk('user/SessionManager.js').default;
    const session = new SessionManager();
    const accessToken = env.EXPO_TOKEN || session.getAccessToken();
    const sessionSecret = accessToken ? undefined : session.getSessionSecret();
    assert(accessToken || sessionSecret, 'EAS authentication is required.');
    return sdk('commandUtils/context/contextUtils/createGraphqlClient.js').createGraphqlClient({ accessToken, sessionSecret });
  };
  const cli = (args, json = true, { interactive = false } = {}) => {
    let result;
    try { result = run(process.execPath, [resolve(location(), 'bin/run'), ...args], { cwd, env,
      encoding: 'utf8', stdio: interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'], windowsHide: true, maxBuffer: 32 * 1024 * 1024 }); }
    catch { throw new Error(`EAS ${args[0]} did not return a successful response. Observe the provider before retrying.`); }
    return json ? JSON.parse(result) : result;
  };
  return {
    /** Execute one exact pinned CLI invocation without retries or logging sensitive output. */
    cli,
    /** Read fresh build/submission association data using a new GraphQL client. */
    getBuild: id => sdk('graphql/queries/BuildQuery.js').BuildQuery.withSubmissionsByIdAsync(client(), id, { useCache: false }),
    /** Read fresh retry eligibility and the original submitted build. */
    async getSubmission(id) {
      const value = await sdk('graphql/queries/SubmissionQuery.js').SubmissionQuery.byIdWithSubmittedBuildAsync(client(), id);
      const archive = await client().query(`query SubmissionArchive($id: ID!) { submissions { byId(submissionId: $id) { id archiveUrl } } }`,
        { id }, { requestPolicy: 'network-only', noRetry: true }).toPromise();
      assert(!archive.error && archive.data?.submissions?.byId?.id === id, 'Cannot verify the original submitted archive.');
      return { ...value, archiveUrl: archive.data.submissions.byId.archiveUrl };
    },
    /** Read one bounded page of raw update groups without CLI message truncation. */
    listUpdates: (spec, offset) => sdk('graphql/queries/UpdateQuery.js').UpdateQuery.viewUpdateGroupsOnBranchAsync(client(), {
      appId: spec.projectId, branchName: spec.branch.name, offset, limit: 50,
      filter: { platform: spec.platform.toUpperCase(), runtimeVersions: [spec.runtime] },
    }),
    /** Read an exact update group without evaluating application source. */
    getUpdate: id => sdk('graphql/queries/UpdateQuery.js').UpdateQuery.viewUpdateGroupAsync(client(), { groupId: id }),
    /** Resolve provider-supplied download locations; callers must not persist their credentials. */
    assetUrls: (id, keys) => sdk('graphql/queries/AssetQuery.js').AssetQuery.getSignedUrlsAsync(client(), id, keys),
    /** Resolve the channel's single active unconditional branch without changing it. */
    async channel(spec) {
      const value = await sdk('graphql/queries/ChannelQuery.js').ChannelQuery.viewUpdateChannelAsync(client(), { appId: spec.projectId, channelName: spec.channel });
      const mapping = JSON.parse(value.branchMapping);
      assert(!value.isPaused && value.updateBranches.length === 1 && mapping.data?.length === 1 && mapping.data[0].branchMappingLogic === 'true', 'Channel must have one active unconditional branch.');
      const branch = value.updateBranches[0];
      assert(mapping.data[0].branchId === branch.id, 'Channel branch mapping conflicts.');
      return { id: branch.id, name: branch.name };
    },
    /** Obtain readable remote variables; source environment policy is enforced by shared configuration. */
    environment: (projectId, environment) => sdk('graphql/queries/EnvironmentVariablesQuery.js').EnvironmentVariablesQuery.byAppIdWithSensitiveAsync(client(), { appId: projectId, environment, includeFileContent: false }),
    /** Read signing prerequisites in memory; callers must never persist credential responses. */
    async signingCredentials(spec) {
      const result = await client().query(`query Signing($id: String!, $applicationId: String!) { app { byId(appId: $id) {
        androidAppCredentials(filter: { applicationIdentifier: $applicationId, legacyOnly: false }) {
          androidAppBuildCredentialsList { isDefault androidKeystore { id } } googleServiceAccountKeyForSubmissions { id }
        }
        iosAppCredentials { appleAppIdentifier { bundleIdentifier } appStoreConnectApiKeyForSubmissions { id }
          iosAppBuildCredentialsList { iosDistributionType distributionCertificate { id } provisioningProfile { id expiration provisioningProfile } }
        }
      } } }`, { id: spec.projectId, applicationId: spec.applicationId }, { requestPolicy: 'network-only', noRetry: true }).toPromise();
      assert(!result.error && result.data?.app?.byId, 'Cannot verify EAS signing prerequisites.');
      return result.data.app.byId;
    },
    /** Read the default Android keystore without persisting or logging the secret response. */
    async androidCredentials(spec) {
      const response = await client().query(`query AndroidSigning($id: String!, $applicationId: String!) {
        app { byId(appId: $id) { id androidAppCredentials(filter: { applicationIdentifier: $applicationId, legacyOnly: false }) {
          applicationIdentifier androidAppBuildCredentialsList { isDefault androidKeystore { keystore keystorePassword keyAlias keyPassword } }
        } } }
      }`, { id: spec.projectId, applicationId: spec.applicationId }, { requestPolicy: 'network-only', noRetry: true }).toPromise();
      assert(!response.error && response.data?.app?.byId?.id === spec.projectId, 'Cannot read the configured Android signing identity.');
      const apps = response.data.app.byId.androidAppCredentials.filter(item => item.applicationIdentifier === spec.applicationId);
      assert(apps.length === 1, 'Configure Android signing for the exact application ID.');
      const keys = apps[0].androidAppBuildCredentialsList.filter(item => item.isDefault && item.androidKeystore);
      assert(keys.length === 1, 'Configure exactly one default Android keystore.');
      return keys[0].androidKeystore;
    },
    /** Download only the Play key assigned to the exact configured app, without authenticating to Google. */
    async assignedPlayCredentials(spec) {
      const result = await client().query(`query AssignedPlay($id: String!, $applicationId: String!) {
        app { byId(appId: $id) { id androidAppCredentials(filter: {applicationIdentifier: $applicationId, legacyOnly: false}) {
          applicationIdentifier googleServiceAccountKeyForSubmissions { keyJson }
        } } } }`, { id: spec.projectId, applicationId: spec.applicationId }, { requestPolicy: 'network-only', noRetry: true }).toPromise();
      const app = result.data?.app?.byId; const matches = app?.androidAppCredentials;
      assert(!result.error && app?.id === spec.projectId && matches?.length === 1
        && matches[0].applicationIdentifier === spec.applicationId, 'Assigned Play credentials do not match the configured project/application.');
      const value = matches[0].googleServiceAccountKeyForSubmissions;
      if (!value) return null;
      try { return JSON.parse(value.keyJson); } catch { throw new Error('Assigned Play credential is invalid JSON.'); }
    },
    /** Verify the configured Expo project owner and slug against provider identity. */
    async project({ projectId, owner, slug }) {
      const result = await client().query('query Project($id: String!) { app { byId(appId: $id) { id fullName } } }', { id: projectId }, { requestPolicy: 'network-only' }).toPromise();
      assert(!result.error && result.data?.app?.byId?.id === projectId && result.data.app.byId.fullName === `@${owner}/${slug}`, 'Expo project identity differs.');
      return { projectId, owner, slug };
    },
    /** Hash provider bytes, accepting provider-supplied headers only for that download. */
    hashArtifact: (url, headers) => hashRemoteArtifact(url, headers, fetcher),
    /** Hash a retained local artifact immediately before use. */
    hashFile: file => digestStream(createReadStream(file)),
    /** Recheck retained OTA bytes immediately before handing them to EAS. */
    exportPayload,
  };
}

/** Save a verified EAS Android keystore to an explicitly supplied external directory; the caller owns secure retention. */
export async function downloadEasAndroidCredentials(spec, directory, transport = createEasTransport()) {
  assert(isAbsolute(directory), 'Credential destination must be absolute.');
  const key = await transport.androidCredentials(spec);
  if (key && key.keyPassword == null) key.keyPassword = key.keystorePassword;
  assert(['keystore', 'keystorePassword', 'keyAlias', 'keyPassword'].every(name => typeof key?.[name] === 'string' && key[name].length), 'Incomplete Android signing credential.');
  const bytes = Buffer.from(key.keystore, 'base64');
  assert(bytes.length > 100 && bytes.toString('base64') === key.keystore, 'Invalid Android signing bytes.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keystorePath = resolve(directory, 'android.keystore');
  writeFileSync(keystorePath, bytes, { mode: 0o600, flag: 'wx' });
  const file = resolve(directory, 'credentials.json');
  writeFileSync(file, `${JSON.stringify({ android: { keystore: { keystorePath, keystorePassword: key.keystorePassword, keyAlias: key.keyAlias, keyPassword: key.keyPassword } } }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
  return file;
}

/** Inspect embedded provisioning entitlements in memory; this preflight does not verify the CMS signature. */
export function verifyProvisioningProfile(encoded, requiredEntitlements, parse) {
  let profile;
  try {
    assert(typeof encoded === 'string' && encoded, 'Missing provisioning profile.');
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const start = decoded.indexOf('<plist'); const end = decoded.indexOf('</plist>', start);
    assert(start >= 0 && end > start, 'Missing embedded provisioning plist.');
    const parser = parse || createRequire(require.resolve('eas-cli/package.json'))('@expo/plist').parse;
    profile = parser(decoded.slice(start, end + 8));
  } catch { throw new Error('Cannot decode the selected provisioning profile; refresh it with EAS credentials:configure-build.'); }
  for (const [key, expected] of Object.entries(requiredEntitlements || {})) {
    const actual = profile?.Entitlements?.[key];
    assert(Array.isArray(expected) ? Array.isArray(actual) && expected.every(value => actual.includes(value)) : same(actual, expected),
      `Selected provisioning profile lacks required entitlement ${key}; regenerate it with EAS credentials:configure-build.`);
  }
}

/** Verify one selected platform's signing and optional store credentials without changing or saving credentials. */
export async function preflightEasSigning(spec, transport = createEasTransport(), { now = Date.now(), parseProfile } = {}) {
  const app = await transport.signingCredentials(spec);
  if (spec.platform === 'android') {
    const records = app.androidAppCredentials || [];
    assert(records.length === 1 && records[0].androidAppBuildCredentialsList?.filter(item => item.isDefault && item.androidKeystore?.id).length === 1,
      'Configure exactly one default Android signing credential in EAS.');
    if (spec.submit) assert(records[0].googleServiceAccountKeyForSubmissions?.id, 'Configure Play submission credentials in EAS.');
  } else {
    assert(spec.platform === 'ios', 'Unknown signing platform.');
    const records = (app.iosAppCredentials || []).filter(item => item.appleAppIdentifier?.bundleIdentifier === spec.applicationId);
    assert(records.length === 1, 'Configure one matching iOS signing identity in EAS.');
    const distribution = spec.distribution === 'store' ? 'APP_STORE' : 'AD_HOC';
    const credentials = records[0].iosAppBuildCredentialsList?.filter(item => item.iosDistributionType === distribution) || [];
    assert(credentials.length === 1 && credentials[0].distributionCertificate?.id && credentials[0].provisioningProfile?.id
      && Date.parse(credentials[0].provisioningProfile.expiration) > now, 'Configure one unexpired iOS signing credential for the selected distribution.');
    verifyProvisioningProfile(credentials[0].provisioningProfile.provisioningProfile, spec.requiredEntitlements, parseProfile);
    if (spec.submit) assert(records[0].appStoreConnectApiKeyForSubmissions?.id && /^\d+$/.test(String(spec.destination?.ascAppId ?? '')), 'Configure App Store Connect credentials and its exact destination ID.');
  }
  return { projectId: spec.projectId, platform: spec.platform, applicationId: spec.applicationId, distribution: spec.distribution, verified: true };
}

/** Verify immutable native build identity independently of whether the provider operation has finished. */
export function verifyEasBuild(build, expected) {
  assert(build && UUID.test(build.id), 'Missing EAS build ID.');
  assert(build.app?.id === expected.projectId && build.appIdentifier === expected.applicationId, 'EAS build application differs.');
  assert(platform(build.platform) === expected.platform && build.gitCommitHash === expected.source && build.buildProfile === expected.profile, 'EAS build source/platform/profile differs.');
  assert(build.appVersion === expected.version && String(build.appBuildVersion) === String(expected.versionCode), 'EAS build version differs.');
  assert(build.runtime?.version === expected.runtime && build.updateChannel?.name === expected.channel, 'EAS build runtime/channel differs.');
  assert(build.distribution === expected.distribution.toUpperCase() && !build.isForIosSimulator, 'EAS build distribution differs.');
  if (expected.marker) assert(build.message === expected.marker, 'EAS build operation marker differs.');
  if (expected.fingerprint && build.status === 'FINISHED') assert(build.fingerprint?.hash === expected.fingerprint, 'EAS build fingerprint differs.');
  return build;
}

async function uniquePages(read, select) {
  const matches = []; const seen = new Set();
  for (let offset = 0; ; offset += 50) {
    const page = await read(offset);
    assert(Array.isArray(page) && page.length <= 50, 'Unexpected provider page.');
    for (const item of page) {
      const key = Array.isArray(item) ? item[0]?.group : item.id;
      assert(key && !seen.has(key), 'Provider pagination repeated an operation.'); seen.add(key);
      if (select(item)) matches.push(item);
    }
    if (page.length < 50) return matches;
  }
}

function one(matches, convert = observation) {
  assert(matches.length <= 1, 'Multiple provider operations match; reconcile before proceeding.');
  return matches.length ? convert(matches[0]) : null;
}

/** Adapt hosted native builds to the shared executor; empty searches never authorize retrying an unresolved intent. */
export function createEasBuildProvider(spec, transport = createEasTransport()) {
  const inspect = raw => observation(verifyEasBuild(raw, spec));
  return {
    /** Find the exact immutable operation marker across all matching source/profile builds. */
    async find(context = {}) {
      const matches = await uniquePages(offset => transport.cli(['build:list', '--platform', spec.platform, '--build-profile', spec.profile,
        '--git-commit-hash', spec.source, '--offset', String(offset), '--limit', '50', '--json', '--non-interactive']),
      raw => raw.message === spec.marker && !(context.previousIds ?? []).includes(raw.id));
      return one(matches, inspect);
    },
    /** Enqueue once; failed native builds require explicit reconciliation before any replacement build. */
    async start(context = {}) {
      assert(!context.retry, 'EAS native replacement builds require explicit reconciliation.');
      const result = await transport.cli(['build', '--platform', spec.platform, '--profile', spec.profile, '--message', spec.marker,
        '--non-interactive', '--freeze-credentials', '--no-wait', '--json']);
      assert(Array.isArray(result) && result.length === 1 && UUID.test(result[0]?.id), 'Build response is ambiguous; reconcile before retrying.');
      return { id: result[0].id, status: 'accepted' };
    },
    /** Observe the exact build without creating or retrying work. */
    async status(id) { const result = await transport.getBuild(id); assert(result.id === id, 'Build readback ID differs.'); return inspect(result); },
    /** Verify finished native bytes and preserve EAS provenance separately from local artifact provenance. */
    async verify(current, context = {}) {
      const result = await this.status(current.id);
      if (result.status !== 'complete') {
        assert(context.observe === true, 'Native build has not finished.');
        return { schemaVersion: 1, provider: 'eas', kind: 'native-observation', id: result.id, status: result.status,
          source: spec.source, projectId: spec.projectId, platform: spec.platform, profile: spec.profile };
      }
      const raw = result.raw;
      const url = raw.artifacts?.applicationArchiveUrl || raw.artifacts?.buildUrl;
      const sha256 = await transport.hashArtifact(url);
      assert(SHA256.test(sha256) && (!spec.artifactSha256 || sha256 === spec.artifactSha256), 'Native artifact bytes differ.');
      return { schemaVersion: 1, provider: 'eas', kind: 'native-build', origin: 'eas', id: raw.id, source: spec.source,
        projectId: spec.projectId, applicationId: spec.applicationId, platform: spec.platform, profile: spec.profile,
        channel: spec.channel, environment: spec.environment, runtime: spec.runtime, version: spec.version,
        versionCode: spec.versionCode, fingerprint: raw.fingerprint?.hash, artifact: { kind: 'eas-build', buildId: raw.id, sha256 } };
    },
  };
}

/** Verify the exact configured store destination without inferring track aliases from display names. */
export function verifyEasSubmission(submission, spec) {
  assert(submission && UUID.test(submission.id) && submission.app?.id === spec.projectId && platform(submission.platform) === spec.platform, 'Submission application/platform differs.');
  if (spec.platform === 'android') assert(spec.destination?.track && spec.destination?.releaseStatus
    && submission.androidConfig?.track === spec.destination.track
    && platform(submission.androidConfig?.releaseStatus) === platform(spec.destination.releaseStatus), 'Submission Play destination differs.');
  else assert(spec.destination?.ascAppId && String(submission.iosConfig?.ascAppIdentifier) === String(spec.destination.ascAppId), 'Submission App Store destination differs.');
  if (spec.artifact.kind === 'eas-build') {
    assert(submission.submittedBuild?.id === spec.artifact.buildId, 'Submission no longer belongs to the exact build.');
    verifyEasBuild(submission.submittedBuild, spec.build);
  } else {
    verifyFileOrigin(spec);
    assert(!submission.submittedBuild, 'Retained file evidence must remain distinct from an EAS-produced build.');
  }
  return submission;
}

function verifyFileOrigin(spec) {
  if (spec.artifact.kind === 'local-file') { assert(spec.artifact.origin === 'local', 'Local file evidence must retain its local origin.'); return; }
  assert(spec.artifact.kind === 'retained-file' && spec.artifact.origin?.kind === 'github'
    && typeof spec.source === 'string' && typeof spec.target === 'string' && typeof spec.repository === 'string'
    && isVerifiedSourceProof(spec.sourceProof, { source: spec.source, target: spec.target, repository: spec.repository })
    && same(spec.artifact.origin, spec.sourceProof.origin), 'Hosted retained files require verified original producer evidence.');
}

/** Adapt exact-artifact submissions; retry transport requires fresh eligibility, destination, source and byte proof. */
export function createEasSubmissionProvider(spec, transport = createEasTransport()) {
  assert(SHA256.test(spec.artifact?.sha256), 'Submission requires an immutable artifact digest.');
  const bytes = async () => {
    let actual;
    if (spec.artifact.kind === 'eas-build') {
      const raw = verifyEasBuild(await transport.getBuild(spec.artifact.buildId), spec.build);
      assert(raw.id === spec.artifact.buildId && raw.status === 'FINISHED' && raw.distribution === 'STORE', 'Submission requires the exact finished store build.');
      actual = await transport.hashArtifact(raw.artifacts?.applicationArchiveUrl || raw.artifacts?.buildUrl);
    } else {
      verifyFileOrigin(spec);
      actual = await transport.hashFile(spec.artifact.path);
    }
    assert(actual === spec.artifact.sha256, 'Submission artifact bytes differ.');
  };
  const inspect = async id => {
    const raw = await transport.getSubmission(id);
    assert(raw.id === id, 'Submission readback ID differs.');
    return observation(verifyEasSubmission(raw, spec));
  };
  return {
    /** Recover exact build-associated IDs; local lost-response uploads require explicit operator reconciliation. */
    async find(context = {}) {
      if (context.providerId) return inspect(context.providerId);
      if (spec.artifact.kind !== 'eas-build') return null;
      const build = verifyEasBuild(await transport.getBuild(spec.artifact.buildId), spec.build);
      assert(build.id === spec.artifact.buildId && Array.isArray(build.submissions), 'Missing build submission association.');
      const prior = new Set(context.previousIds || []);
      const matches = build.submissions.filter(item => !prior.has(item.id));
      const match = one(matches);
      return match ? inspect(match.id) : null;
    },
    /** Submit a verified exact artifact once, or retry precisely the provider-authorized failed request. */
    async start(context = {}) {
      await bytes();
      if (context.retry) {
        const retry = context.retry;
        assert(retry.mode === 'provider-retry' && retry.proof?.submissionId, 'Only an exact provider-supported retry is permitted.');
        const fresh = await this.prepareRetry({ id: retry.proof.submissionId });
        assert(same(fresh.proof, retry.proof), 'Retry authorization changed; reconcile before proceeding.');
        const result = await transport.cli(['submit:retry', retry.proof.submissionId, '--non-interactive', '--json']);
        assert(UUID.test(result?.id) && result.id !== retry.proof.submissionId && !(context.previousIds || []).includes(result.id), 'Retry response has no new exact submission ID.');
        return { id: result.id, status: 'accepted' };
      }
      const args = ['submit', '--platform', spec.platform, '--profile', spec.profile,
        spec.artifact.kind === 'eas-build' ? '--id' : '--path', spec.artifact.kind === 'eas-build' ? spec.artifact.buildId : spec.artifact.path,
        '--non-interactive', '--no-wait', '--no-auto-testflight-setup'];
      const output = await transport.cli(args, false);
      if (spec.artifact.kind === 'eas-build') {
        const accepted = await this.find(context);
        assert(accepted, 'Cannot identify accepted submission; reconcile before retrying.'); return accepted;
      }
      // The CLI has no JSON submit output. Only an exact project URL can establish a local upload's returned ID.
      const ids = [...new Set([...String(output).matchAll(/https:\/\/expo\.dev\/accounts\/([^/\s]+)\/projects\/([^/\s]+)\/submissions\/([a-f0-9-]{36})/gi)]
        .filter(match => decodeURIComponent(match[1]) === spec.owner && decodeURIComponent(match[2]) === spec.slug).map(match => match[3]))];
      assert(ids.length === 1 && UUID.test(ids[0]), 'Local upload outcome is uncertain; reconcile its exact provider ID before retrying.');
      return { id: ids[0], status: 'accepted' };
    },
    /** Read an exact submission and retain its native provider state. */
    status: inspect,
    /** Prove acceptance independently from completion, retaining the original local/EAS artifact origin. */
    async verify(current, context = {}) {
      const result = await inspect(current.id);
      assert(context.observe === true || (context.requireComplete === false ? ['accepted', 'complete'].includes(result.status) : result.status === 'complete'), 'Submission has not reached its required state.');
      await bytes();
      if (spec.artifact.kind !== 'eas-build') assert(result.raw.archiveUrl
        && await transport.hashArtifact(result.raw.archiveUrl) === spec.artifact.sha256, 'Submitted archive differs from the retained artifact or is unavailable.');
      return { schemaVersion: 1, provider: 'eas', kind: 'submission', id: result.id, status: result.status,
        projectId: spec.projectId, platform: spec.platform, destination: spec.destination,
        artifact: { kind: spec.artifact.kind, origin: spec.artifact.kind === 'eas-build' ? 'eas' : spec.artifact.origin, sha256: spec.artifact.sha256,
          ...(spec.artifact.kind === 'eas-build' ? { buildId: spec.artifact.buildId } : {}) } };
    },
    /** Authorize only a freshly observed retryable failed request with unchanged artifact and destination. */
    async prepareRetry(current) {
      const result = await inspect(current.id); await bytes();
      assert(result.raw.status === 'ERRORED' && result.raw.canRetry === true, 'Provider does not authorize retrying this exact submission.');
      return { mode: 'provider-retry', proof: { provider: 'eas', action: 'submit:retry', submissionId: result.id,
        projectId: spec.projectId, platform: spec.platform, artifactSha256: spec.artifact.sha256,
        ...(spec.artifact.kind === 'eas-build' ? { buildId: spec.artifact.buildId, source: spec.build.source } : { origin: spec.artifact.origin, ...(spec.source ? { source: spec.source } : {}) }),
        destination: spec.destination, status: result.raw.status, canRetry: true } };
    },
  };
}

function manifest(update) {
  const value = typeof update.manifestFragment === 'string' ? JSON.parse(update.manifestFragment) : update.manifestFragment;
  assert(value && value.launchAsset && Array.isArray(value.assets), 'Missing OTA manifest.'); return value;
}

/** Verify a retained export's exact runtime, source, destination and provider-advertised asset hashes. */
export function verifyEasUpdate(update, spec) {
  assert(update && platform(update.platform) === spec.platform && update.runtime?.version === spec.runtime
    && !update.isRollBackToEmbedded, 'OTA source/platform/runtime differs.');
  // A no-VCS publisher has no provider Git metadata. Only the verified retained producer can supply that proof.
  assert((update.gitCommitHash == null || update.gitCommitHash === spec.source) && update.isGitWorkingTreeDirty !== true, 'OTA source/platform/runtime differs.');
  if (update.gitCommitHash !== spec.source || update.isGitWorkingTreeDirty !== false) {
    assert(typeof spec.target === 'string' && typeof spec.repository === 'string'
      && isVerifiedSourceProof(spec.sourceProof, { source: spec.source, target: spec.target, repository: spec.repository }), 'OTA requires verified hosted artifact source evidence.');
  }
  assert(update.branch?.id === spec.branch.id && update.message === spec.marker && platform(update.environment) === platform(spec.environment), 'OTA destination/environment differs.');
  const value = manifest(update);
  const actual = { launch: value.launchAsset.fileSHA256, assets: [...new Set(value.assets.map(asset => asset.fileSHA256))].sort() };
  assert(same(actual, { launch: spec.payload.launch, assets: [...new Set(spec.payload.assets)].sort() }), 'Uploaded OTA payload differs from retained bytes.');
  assert(value.extra?.expoClient?.extra?.eas?.projectId === spec.projectId, 'OTA manifest project differs.');
  if (spec.serverUrl) assert(value.extra.expoClient.extra.serverUrl === spec.serverUrl, 'OTA manifest server differs.');
  return update;
}

/** Adapt retained OTA publication to shared intents, verifying every downloaded payload before completion. */
export function createEasOtaProvider(spec, transport = createEasTransport()) {
  const branch = async () => assert(same(await transport.channel(spec), spec.branch), 'Channel mapping changed.');
  const verifiedAbsences = new WeakSet();
  const verifyAbsence = async (value, context) => {
    const identity = { projectId: spec.projectId, target: spec.target, applicationId: spec.applicationId, platform: spec.platform,
      runtime: spec.runtime, channel: spec.channel, environment: spec.environment, branch: spec.branch, source: spec.source,
      marker: spec.marker, payload: spec.payload, planDigest: context.planDigest, operationKey: context.operationKey, attempt: context.attempt,
      ...(context.bundleIntegrity ? { bundleIntegrity: context.bundleIntegrity } : {}) };
    assert(SHA256.test(context.planDigest ?? '') && typeof context.operationKey === 'string' && context.operationKey
      && Number.isSafeInteger(context.attempt) && context.attempt > 0 && context.source === spec.source && context.target === spec.target
      && typeof spec.target === 'string' && typeof spec.applicationId === 'string'
      && value?.confirmed === true && value.outcome === 'not-published' && value.noPublishedUpdate === true && value.noInFlightRequest === true
      && Object.entries(identity).every(([key, expected]) => same(value[key], expected))
      && typeof value.evidence === 'string' && value.evidence.trim().length >= 20 && value.evidence.length <= 2000
      && typeof value.observedAt === 'string' && Number.isFinite(Date.parse(value.observedAt))
      && (!value.evidenceKind || value.evidenceKind === 'operator-provider-reconciliation')
      && Object.keys(value).every(key => [...Object.keys(identity), 'confirmed', 'outcome', 'noPublishedUpdate', 'noInFlightRequest',
        'evidence', 'observedAt', 'evidenceKind'].includes(key)),
    'OTA absence requires explicit provider audit evidence bound to the exact payload, destination and original request attempt.');
    await branch();
    const conflicts = await uniquePages(offset => {
      assert(offset < 1000, 'OTA absence search exceeded its bound; inspect provider history before retrying.');
      return transport.listUpdates(spec, offset);
    }, group => group.some(update => update.message === spec.marker));
    assert(conflicts.length === 0, 'A provider publication conflicts with the audited OTA absence.');
    assert(same(await transport.exportPayload(spec.directory, spec.platform), spec.payload), 'Retained OTA bytes changed before absence verification.');
    await branch();
    const proof = { ...value, evidenceKind: 'operator-provider-reconciliation' };
    verifiedAbsences.add(proof); return proof;
  };
  const inspect = async id => {
    const updates = await transport.getUpdate(id);
    assert(Array.isArray(updates) && updates.length === 1 && updates[0].group === id, 'Unexpected OTA group contents.');
    const raw = verifyEasUpdate(updates[0], spec);
    return { id, status: 'complete', raw };
  };
  return {
    /** Find the exact publication marker, rejecting ambiguous groups instead of uploading again. */
    async find() {
      await branch();
      const groups = await uniquePages(offset => transport.listUpdates(spec, offset), group => group.some(update => update.message === spec.marker));
      assert(groups.length <= 1, 'Multiple OTA groups match; reconcile before proceeding.');
      return groups.length ? inspect(groups[0][0].group) : null;
    },
    /** Publish an already verified retained export without invoking its bundler. */
    async start(context = {}) {
      if (context.retry) {
        assert(context.retry.mode === 'new-request' && verifiedAbsences.has(context.retry.proof), 'An unknown or failed OTA requires explicit provider reconciliation.');
        const proof = context.retry.proof; verifiedAbsences.delete(proof);
        await verifyAbsence(proof, { ...context, operationKey: proof.operationKey, attempt: proof.attempt });
      }
      await branch();
      assert(typeof spec.directory === 'string' && spec.directory, 'A verified retained export is required.');
      assert(same(await transport.exportPayload(spec.directory, spec.platform), { launch: spec.payload.launch, assets: [...new Set(spec.payload.assets)].sort() }), 'Retained OTA bytes changed before publication.');
      const result = await transport.cli(['update', '--branch', spec.branch.name, '--environment', spec.environment, '--platform', spec.platform,
        '--message', spec.marker, '--input-dir', spec.directory, '--skip-bundler', '--non-interactive', '--json']);
      assert(Array.isArray(result) && result.length === 1 && UUID.test(result[0]?.group), 'OTA response is ambiguous; reconcile before retrying.');
      return { id: result[0].group, status: 'accepted' };
    },
    /** Observe one exact update group without publishing or recompiling anything. */
    status: inspect,
    /** Recheck an explicit provider audit and bounded live search; an empty search alone never authorizes retry. */
    verifyAbsence,
    /** Download and verify every retained payload asset; completion requires unchanged channel mapping. */
    async verify(current) {
      await branch(); const result = await inspect(current.id); const value = manifest(result.raw);
      const assets = [value.launchAsset, ...value.assets];
      assert(assets.every(asset => typeof asset.storageKey === 'string' && /^[A-Za-z0-9_-]{43}$/.test(asset.fileSHA256)), 'Missing OTA asset identity or digest.');
      const keys = [...new Set(assets.map(asset => asset.storageKey))];
      const locations = await transport.assetUrls(result.raw.id, keys);
      assert(locations.length === keys.length && new Set(locations.map(item => item.storageKey)).size === keys.length && locations.every(item => keys.includes(item.storageKey)), 'OTA asset download identities differ.');
      for (const item of locations) {
        const hash = Buffer.from(await transport.hashArtifact(item.url, item.headers), 'hex').toString('base64url');
        assert(assets.filter(asset => asset.storageKey === item.storageKey).every(asset => asset.fileSHA256 === hash), 'Downloaded OTA bytes differ.');
      }
      await branch();
      return { schemaVersion: 1, provider: 'eas', kind: 'ota', id: result.id, projectId: spec.projectId,
        source: spec.source, platform: spec.platform, runtime: spec.runtime, channel: spec.channel,
        environment: spec.environment, branch: spec.branch, payload: spec.payload };
    },
  };
}
