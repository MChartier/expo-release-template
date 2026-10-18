/** @file Creates disposable data-only EAS publisher workspaces so submission and OTA commands never evaluate consumer configuration or hooks. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEasTransport } from './eas.mjs';

/**
 * Materialize verified public Expo metadata and exact destinations as JSON only.
 * The caller owns disposal and must supply a retained artifact/export independently of source.
 */
export function createEasPublisherWorkspace(spec, { env = process.env, run, fetch } = {}) {
  if (!/^[a-f0-9-]{36}$/i.test(spec.projectId ?? '') || !['android', 'ios'].includes(spec.platform)
    || !/^[\w-]+$/.test(spec.owner ?? '') || !/^[\w-]+$/.test(spec.slug ?? '')
    || !spec.applicationId || !spec.runtime || !spec.profile) throw new Error('Missing verified publisher identity.');
  const root = mkdtempSync(join(tmpdir(), 'expo-release-publisher-'));
  const client = structuredClone(spec.expoConfig ?? {});
  // Preserve public runtime values while excluding build plugins and executable entry-point configuration.
  delete client.plugins; delete client.hooks; delete client.entryPoint; delete client.experiments;
  const config = { ...client, name: client.name || spec.slug, slug: spec.slug, owner: spec.owner,
    version: spec.version, runtimeVersion: spec.runtime,
    android: { ...client.android, package: spec.applicationId, ...(spec.platform === 'android' ? { versionCode: Number(spec.versionCode) } : {}) },
    ios: { ...client.ios, bundleIdentifier: spec.applicationId, ...(spec.platform === 'ios' ? { buildNumber: String(spec.versionCode) } : {}) },
    extra: { ...client.extra, eas: { projectId: spec.projectId }, ...(spec.serverUrl ? { serverUrl: spec.serverUrl } : {}) },
    updates: { ...client.updates, url: `https://u.expo.dev/${spec.projectId}`, requestHeaders: { 'expo-channel-name': spec.channel } },
  };
  const destination = spec.destination ?? {};
  const submit = spec.platform === 'android'
    ? { android: { track: destination.track, releaseStatus: destination.releaseStatus } }
    : { ios: { ascAppId: destination.ascAppId } };
  const write = (name, value) => writeFileSync(join(root, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  try {
    write('package.json', { name: 'trusted-release-publisher', version: '1.0.0', private: true });
    write('app.json', { expo: config });
    write('eas.json', { cli: { version: '22.4.0', appVersionSource: 'local', requireCommit: false }, submit: { [spec.profile]: submit } });
    return {
      root, transport: createEasTransport({ cwd: root, env: { ...env, EXPO_NO_DOTENV: '1', EAS_NO_VCS: '1', EAS_SKIP_AUTO_FINGERPRINT: '1' }, run, fetch }),
      /** Remove only this generated temporary workspace; retained release artifacts remain caller-owned. */
      dispose() { rmSync(root, { recursive: true, force: true }); },
    };
  } catch (error) { rmSync(root, { recursive: true, force: true }); throw error; }
}
