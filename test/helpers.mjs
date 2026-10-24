/** @file Current-format deterministic fixtures; no real provider credentials or release operations. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { configured } from '../src/config.mjs';
import { selectRelease } from '../src/engine.mjs';

/** Return an ordinary two-platform Expo application with an optional server. */
export function config() {
  return configured({ schemaVersion: 3, repository: 'owner/app', defaultBranch: 'main', install: [], metadataFiles: ['app.json'],
    profiles: { production: { environment: 'production', approvalEnvironment: 'production', deployEnvironment: 'server', channel: 'production', easProfile: 'production', submit: true, publicEnvironment: {} } },
    mobile: { directory: '.', versionFloor: '0.9.9', projectId: '12345678-1234-1234-1234-123456789012', owner: 'owner', slug: 'app', inputs: ['app', 'package-lock.json'],
      targets: ['android', 'ios'].map(platform => ({ id: platform, platform, applicationId: 'app.example.mobile' })) },
    server: { versionFloor: '1.2.3', inputs: ['server'], image: 'ghcr.io/owner/app', dockerfile: 'Dockerfile', platforms: ['linux/amd64'],
      smoke: { port: 8080, healthPath: '/health' }, deployment: { service: 'app', path: '/deploy/app' } } });
}

/** Produce independent native and bundle input identities. */
export function observation() {
  return { server: 'server-A', js: { android: 'js-A', ios: 'js-A' }, family: 'family-A',
    fingerprints: { production: { android: 'a'.repeat(40), ios: 'b'.repeat(40) } } };
}

/** A successful native release establishes current-runtime baselines for both platforms. */
export function history() {
  const value = { mobile: { version: '1.0.0', family: 'family-A' }, server: { version: '1.2.4' }, baselines: {}, pending: [] };
  value.baselines['production/deploy/server'] = { input: 'server-A' };
  for (const platform of ['android', 'ios']) {
    value.baselines[`production/build/${platform}`] = { runtime: '1', fingerprint: observation().fingerprints.production[platform] };
    value.baselines[`production/js/${platform}`] = { input: 'js-A' };
  }
  return value;
}

/** Bind a pure selection to a hosted run and immutable commits. */
export function plan(overrides = {}) {
  const value = config();
  return { ...selectRelease(value, 'production', observation(), {}, false), config: value, environments: { production: {} },
    repository: value.repository, source: 'a'.repeat(40), build: 'b'.repeat(40), toolkit: 'c'.repeat(40), run: '123',
    submitProfiles: { production: { android: { track: 'internal' }, ios: { ascAppId: '12345' } } }, ...overrides };
}

/** Allocate an isolated temporary directory cleaned after the test. */
export function temporary(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-release-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

/** Create a disposable Git repository suitable for binary/deletion and build-commit tests. */
export function repository(t) {
  const root = temporary(t);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  git(['init', '-q']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.invalid']);
  return { root, git,
    /** Save a source input with portable parent directory creation. */
    save(file, value) { const target = path.join(root, file); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, value); },
    /** Commit exactly the fixture files currently present. */
    commit() { git(['add', '-A']); git(['commit', '-qm', 'fixture']); return git(['rev-parse', 'HEAD']); } };
}
