/** @file Official Google Play transport; shared execution owns durable intents, retry and publication provenance. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
const ANDROID_PUBLISHER_SCOPE = 'https://www.googleapis.com/auth/androidpublisher';
const ANDROID_PUBLISHER_ROOT = 'https://androidpublisher.googleapis.com/androidpublisher/v3';
const ANDROID_PUBLISHER_UPLOAD_ROOT = 'https://androidpublisher.googleapis.com/upload/androidpublisher/v3';
const GOOGLE_OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const isNonEmptyString = value => typeof value === 'string' && value.trim().length > 0;
const sha256 = value => crypto.createHash('sha256').update(value).digest('hex');
/** Encode JWT fields without padding or URL-unsafe characters. */
function base64Url(value) {
  return Buffer.from(value).toString('base64url');
}

/** Sign a short-lived Publisher assertion for the official Google token endpoint only. */
export function createGoogleServiceAccountAssertion(credentials, options = {}) {
  if (!isNonEmptyString(credentials?.client_email) || !isNonEmptyString(credentials?.private_key)) {
    throw new Error('Google Play service-account JSON must contain client_email and private_key.');
  }
  const tokenUri = credentials.token_uri?.trim() || GOOGLE_OAUTH_TOKEN_URL;
  if (tokenUri !== GOOGLE_OAUTH_TOKEN_URL) {
    throw new Error(`Google Play service-account token_uri must be ${GOOGLE_OAUTH_TOKEN_URL}.`);
  }
  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const header = base64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = base64Url(JSON.stringify({
    iss: credentials.client_email.trim(),
    scope: ANDROID_PUBLISHER_SCOPE,
    aud: tokenUri,
    iat: nowSeconds,
    exp: nowSeconds + 3600
  }));
  const signingInput = `${header}.${claims}`;
  let signature;
  try {
    signature = crypto.sign('RSA-SHA256', Buffer.from(signingInput), credentials.private_key).toString('base64url');
  } catch {
    throw new Error('Google Play service-account private_key is not a valid RSA signing key.');
  }
  return { assertion: `${signingInput}.${signature}`, tokenUri };
}

/** Limit provider diagnostics and redact common credential formats. */
function safeGoogleMessage(payload) {
  const candidate = payload?.error?.message ?? payload?.error_description ??
    (typeof payload?.error === 'string' ? payload.error : null);
  if (!isNonEmptyString(candidate)) return null;
  return candidate
    .replace(/-----BEGIN[^-]+-----[\s\S]*?-----END[^-]+-----/g, '[redacted key]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [redacted]')
    .replace(/\beyJ[A-Za-z0-9._-]{20,}\b/g, '[redacted token]')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
}

/** Accept empty responses while sanitizing unexpected non-JSON bodies. */
async function responsePayload(response) {
  const body = await response.text();
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return { error: { message: 'Google returned a non-JSON response.' } };
  }
}

/** Associate failed HTTP responses with their operation without exposing secrets. */
async function checkedGoogleResponse(response, operation) {
  const payload = await responsePayload(response);
  if (response.ok) return payload;
  const detail = safeGoogleMessage(payload);
  throw new Error(
    `${operation} failed with Google HTTP ${response.status}${detail ? `: ${detail}` : '.'}`
  );
}

/** Exchange an explicit service-account key or use an injected short-lived Play token. */
export async function resolveGooglePlayAccessToken(options = {}) {
  const environment = options.environment ?? process.env;
  const serviceAccountFile = options.serviceAccountFile ?? environment.GOOGLE_PLAY_SERVICE_ACCOUNT_FILE;
  if (isNonEmptyString(serviceAccountFile)) {
    let credentials;
    try {
      credentials = JSON.parse(fs.readFileSync(path.resolve(serviceAccountFile.trim()), 'utf8'));
    } catch {
      throw new Error('Google Play service-account file is missing or invalid JSON.');
    }
    const { assertion, tokenUri } = createGoogleServiceAccountAssertion(credentials, { now: options.now });
    const form = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion
    });
    const fetchImpl = options.fetchImpl ?? globalThis.fetch;
    const response = await fetchImpl(tokenUri, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString()
    });
    const payload = await checkedGoogleResponse(response, 'Google OAuth token exchange');
    if (!isNonEmptyString(payload?.access_token)) {
      throw new Error('Google OAuth token exchange returned no access_token.');
    }
    return payload.access_token;
  }

  const suppliedToken = environment.GOOGLE_PLAY_ACCESS_TOKEN?.trim();
  if (suppliedToken) return suppliedToken;
  throw new Error(
    'Google Play credentials are missing. Pass --service-account-file FILE or set GOOGLE_PLAY_ACCESS_TOKEN.'
  );
}

/** Select Google's normal or media-upload edit endpoint for the exact app. */
function editRoot(applicationId, upload = false) {
  const apiRoot = upload ? ANDROID_PUBLISHER_UPLOAD_ROOT : ANDROID_PUBLISHER_ROOT;
  return `${apiRoot}/applications/${encodeURIComponent(applicationId)}/edits`;
}

/** Restrict authenticated edit operations to the configured application identifier. */
export function createGooglePlayPublisher(options) {
  const applicationId = options?.applicationId;
  const accessToken = options?.accessToken;
  if (!/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/.test(applicationId ?? '')) throw new Error('Invalid Play application identifier.');
  if (!isNonEmptyString(accessToken)) throw new Error('Google Play publisher requires an access token.');
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;

  /** Admit authentication only to the fixed Publisher API endpoints below. */
  const request = async (url, init, operation) => {
    const response = await fetchImpl(url, {
      ...init, redirect: 'error', signal: AbortSignal.timeout(300000),
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.headers ?? {})
      }
    });
    return checkedGoogleResponse(response, operation);
  };

  return Object.freeze({
    /** Stage a transaction without changing live tracks. */
    async createEdit() {
      const payload = await request(editRoot(applicationId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}'
      }, 'Create Google Play edit');
      if (!isNonEmptyString(payload?.id)) throw new Error('Create Google Play edit returned no edit ID.');
      return payload.id;
    },

    /** Discard only the edit created for this operation. */
    async deleteEdit(editId) {
      await request(`${editRoot(applicationId)}/${encodeURIComponent(editId)}`, {
        method: 'DELETE'
      }, 'Delete Google Play edit');
    },

    /** Read the exact configured track inside a staged edit. */
    async getTrack(editId, track) {
      return request(
        `${editRoot(applicationId)}/${encodeURIComponent(editId)}/tracks/${encodeURIComponent(track)}`,
        { method: 'GET' },
        `Read Google Play track ${track}`
      );
    },

    /** Retrieve existing version codes and hashes for idempotency checks. */
    async listBundles(editId) {
      return request(
        `${editRoot(applicationId)}/${encodeURIComponent(editId)}/bundles`,
        { method: 'GET' },
        'List Google Play bundles'
      );
    },

    /** Recheck retained bytes before sending a bundle into the staged edit. */
    async uploadBundle(editId, file, expectedSha256) {
      let bytes;
      try {
        bytes = fs.readFileSync(file);
      } catch {
        throw new Error('Google Play bundle upload source is missing.');
      }
      if (expectedSha256 && sha256(bytes) !== expectedSha256) {
        throw new Error('Google Play bundle changed after artifact verification. Rebuild and verify before uploading.');
      }
      return request(
        `${editRoot(applicationId, true)}/${encodeURIComponent(editId)}/bundles?uploadType=media`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: bytes
        },
        'Upload Android App Bundle'
      );
    },

    /** Stage a single exact release on the requested track. */
    async updateTrack(editId, track, release) {
      return request(
        `${editRoot(applicationId)}/${encodeURIComponent(editId)}/tracks/${encodeURIComponent(track)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ track, releases: [release] })
        },
        `Update Google Play track ${track}`
      );
    },

    /** Publish the staged pair while refusing concurrent changes already in review. */
    async commitEdit(editId) {
      return request(
        `${editRoot(applicationId)}/${encodeURIComponent(editId)}:commit?changesInReviewBehavior=ERROR_IF_IN_REVIEW`,
        { method: 'POST' },
        'Commit Google Play edit'
      );
    }
  });
}
