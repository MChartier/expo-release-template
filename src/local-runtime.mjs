/** @file Local appVersion collision guard; remembered fingerprints can block a build but never authorize publication or hosted provenance. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hashIdentity, invariant } from '../packages/release-engine/index.mjs';
import { localSettingsPath } from './local-credentials.mjs';

/** Read local build memory, including explicitly mapped original native receipts, without changing application version policy. */
export function localRuntimeGuard({ plan, root, environment = process.env }) {
  const targets = plan.components.filter(value => value.selected && value.kind === 'native' && (value.runtimePolicy ?? 'appVersion') === 'appVersion');
  if (!targets.length) return { record() {} };
  const settingsFile = localSettingsPath(plan.config, root, environment);
  const file = path.join(path.dirname(settingsFile), 'expo-release-runtime-history.json');
  const key = component => hashIdentity({ repository: plan.source.repository, project: plan.providerConfiguration?.expo?.projectId ?? null,
    application: component.applicationId ?? component.id, platform: component.platform, profile: plan.profile, runtime: component.observation.runtime });
  const read = () => {
    const value = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { schemaVersion: 1, kind: 'expo-local-runtime-guard', entries: {} };
    invariant(value.schemaVersion === 1 && value.kind === 'expo-local-runtime-guard' && value.entries && !Array.isArray(value.entries), 'Invalid local runtime guard history.');
    return value;
  };
  const check = value => {
    for (const target of targets) {
      const fingerprint = target.observation.fingerprint;
      invariant(typeof fingerprint === 'string' && fingerprint.length > 0, 'appVersion local builds require a full native fingerprint.');
      const previous = value.entries[key(target)];
      invariant(!previous || previous.fingerprint === fingerprint, 'Native inputs changed under an existing appVersion runtime; prepare and commit a new native version before rebuilding.');
    }
  };
  const value = read();
  const legacyField = plan.config.local?.legacyBuildReceiptsField;
  if (legacyField && fs.existsSync(settingsFile)) {
    invariant(plan.config.local.legacyMetadataFields?.[legacyField] === 'string-map', 'Legacy native receipts require an explicitly declared path map.');
    const settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    const originals = (settings.legacy ?? settings)[legacyField] ?? {};
    for (const target of targets) {
      const originalFile = originals[`${target.platform}:${plan.profile}`];
      if (!originalFile) continue;
      invariant(typeof originalFile === 'string' && path.isAbsolute(originalFile), 'Original local receipt path must be absolute.');
      invariant(fs.existsSync(originalFile), 'Original local runtime receipt is missing; restore it before rebuilding this runtime.');
      const previous = JSON.parse(fs.readFileSync(originalFile, 'utf8'));
      invariant(previous.schema === 1 && previous.platform === target.platform && previous.profile === plan.profile
        && typeof previous.release?.version === 'string' && /^[a-f0-9]{40,64}$/.test(previous.fingerprint), 'Invalid original local runtime receipt.');
      if (previous.release.version === target.observation.version) invariant(previous.fingerprint === target.observation.fingerprint,
        'Native inputs changed under an existing appVersion runtime; prepare and commit a new native version before rebuilding.');
    }
  }
  check(value);
  return {
    /** Remember successful local fingerprints across worktrees; this is only an incompatibility guard, never a release baseline. */
    record() {
      const current = read(); check(current);
      for (const target of targets) current.entries[key(target)] = { fingerprint: target.observation.fingerprint, source: plan.source.commit, origin: 'local' };
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try { fs.writeFileSync(temporary, `${JSON.stringify(current, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, file); }
      finally { fs.rmSync(temporary, { force: true }); }
    }
  };
}
