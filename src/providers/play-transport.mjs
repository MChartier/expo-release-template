/** @file Official Google authentication and Publisher transport; release code owns identity, intents and retries. */
import { createHash, createPrivateKey } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { androidpublisher } from '@googleapis/androidpublisher';
import { JWT, OAuth2Client } from 'google-auth-library';
import { invariant } from '../../packages/release-engine/index.mjs';

/** Validate a downloaded key locally without authenticating or exposing its contents. */
export function validateGoogleServiceAccount(credentials) {
  invariant(typeof credentials?.client_email === 'string' && credentials.client_email.trim() && typeof credentials.private_key === 'string'
    && (!credentials.token_uri || credentials.token_uri === 'https://oauth2.googleapis.com/token'), 'Invalid Google Play service-account identity or token endpoint.');
  try { invariant(createPrivateKey(credentials.private_key).asymmetricKeyType === 'rsa', 'Expected an RSA key.'); }
  catch { throw new Error('Google Play service-account private_key is not a valid RSA signing key.'); }
  return credentials;
}

/** Obtain a token from an explicit service-account key or supplied token; never use ambient ADC. */
export async function resolveGooglePlayAccessToken({ environment = process.env, serviceAccountFile = environment.GOOGLE_PLAY_SERVICE_ACCOUNT_FILE, createAuth = options => new JWT(options) } = {}) {
  if (!serviceAccountFile) {
    invariant(environment.GOOGLE_PLAY_ACCESS_TOKEN?.trim(), 'Google Play credentials are missing. Pass --service-account-file FILE or set GOOGLE_PLAY_ACCESS_TOKEN.');
    return environment.GOOGLE_PLAY_ACCESS_TOKEN.trim();
  }
  let credentials;
  try { credentials = JSON.parse(fs.readFileSync(serviceAccountFile, 'utf8')); }
  catch { throw new Error('Google Play service-account file is missing or invalid JSON.'); }
  validateGoogleServiceAccount(credentials);
  try {
    const auth = createAuth({ email: credentials.client_email, key: credentials.private_key, scopes: ['https://www.googleapis.com/auth/androidpublisher'] });
    const result = await auth.getAccessToken();
    invariant(result.token, 'Google returned no access token.');
    return result.token;
  } catch { throw new Error('Google Play authentication failed. Check the configured service-account key.'); }
}

/** Bind the official client to one application; mutation retries and redirects are disabled. */
export function createGooglePlayPublisher({ applicationId, accessToken, createClient = androidpublisher } = {}) {
  invariant(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(applicationId ?? ''), 'Invalid Play application identifier.');
  invariant(typeof accessToken === 'string' && accessToken.trim(), 'Google Play publisher requires an access token.');
  const auth = new OAuth2Client(); auth.setCredentials({ access_token: accessToken });
  const { edits } = createClient({ version: 'v3', auth, retry: false, maxRedirects: 0, timeout: 300000 });
  const call = async (method, params) => {
    try { return (await method({ packageName: applicationId, ...params }, { retry: false, maxRedirects: 0, timeout: 300000 })).data; }
    catch (error) { throw new Error(`Google Play request failed${Number.isInteger(error.response?.status) ? ` (HTTP ${error.response.status})` : ''}. Observe the provider before retrying.`); }
  };
  return Object.freeze({
    /** Create a staged transaction without changing live tracks. */
    async createEdit() { const value = await call(edits.insert.bind(edits), { requestBody: {} }); invariant(value?.id, 'Google returned no edit ID.'); return value.id; },
    /** Discard the exact staged edit. */
    deleteEdit: editId => call(edits.delete.bind(edits), { editId }),
    /** Read an exact track inside the staged edit. */
    getTrack: (editId, track) => call(edits.tracks.get.bind(edits.tracks), { editId, track }),
    /** Read bundle identities used for duplicate prevention. */
    listBundles: editId => call(edits.bundles.list.bind(edits.bundles), { editId }),
    /** Verify and upload the same in-memory bytes, avoiding a second filesystem read. */
    uploadBundle(editId, file, expectedSha256) {
      const bytes = fs.readFileSync(file);
      invariant(!expectedSha256 || createHash('sha256').update(bytes).digest('hex') === expectedSha256, 'Google Play bundle changed after artifact verification.');
      return call(edits.bundles.upload.bind(edits.bundles), { editId, media: { mimeType: 'application/octet-stream', body: Readable.from(bytes) } });
    },
    /** Stage one release on the exact authorized track. */
    updateTrack: (editId, track, release) => call(edits.tracks.update.bind(edits.tracks), { editId, track, requestBody: { track, releases: [release] } }),
    /** Commit atomically while refusing pending Console review changes. */
    commitEdit: editId => call(edits.commit.bind(edits), { editId, changesInReviewBehavior: 'ERROR_IF_IN_REVIEW' }),
  });
}

/** Resolve only the credentials named by this promotion stage; generic or other-stage secrets are never fallback authority. */
export async function resolvePromotionToken(credentials, environment, resolveToken = resolveGooglePlayAccessToken) {
  const token = credentials.accessToken && environment[credentials.accessToken];
  if (token) return resolveToken({ environment: { GOOGLE_PLAY_ACCESS_TOKEN: token } });
  const encoded = credentials.serviceAccountBase64 && environment[credentials.serviceAccountBase64];
  invariant(typeof encoded === 'string' && /^[A-Za-z0-9+/]+={0,2}$/.test(encoded), 'The selected promotion stage has no credentials.');
  let value; try { value = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8')); } catch { throw new Error('The selected promotion service account is invalid.'); }
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-play-key-'));
  try { const file = path.join(directory, 'key.json'); fs.writeFileSync(file, JSON.stringify(value), { mode: 0o600 }); return await resolveToken({ serviceAccountFile: file, environment: {} }); }
  finally { invariant(path.dirname(path.resolve(directory)) === path.resolve(os.tmpdir()), 'Credential cleanup escaped the temporary directory.'); fs.rmSync(directory, { recursive: true, force: true }); }
}
