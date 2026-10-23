/** @file Local appVersion collision guard; remembered fingerprints can block a build but never authorize publication or hosted provenance. */
import fs from 'node:fs';
import path from 'node:path';
import { hashIdentity, invariant } from '../packages/release-engine/index.mjs';
import { localSettingsPath } from './local-credentials.mjs';

/** Read local build memory without changing application version policy. */
export function localRuntimeGuard({ plan, root, environment = process.env }) {
  const targets = plan.components.filter(value => value.selected && value.kind === 'native' && (value.runtimePolicy ?? 'appVersion') === 'appVersion');
  if (!targets.length) return { record() {} };
  const settingsFile = localSettingsPath(plan.config, root, environment);
  const directory = path.join(path.dirname(settingsFile), 'expo-release-runtimes');
  const key = component => hashIdentity({ repository: plan.source.repository, project: plan.providerConfiguration?.expo?.projectId ?? null,
    application: component.applicationId ?? component.id, target: component.id, platform: component.platform, profile: plan.profile, runtime: component.observation.runtime });
  const read = component => {
    const file = path.join(directory, `${key(component)}.json`);
    if (!fs.existsSync(file)) return null;
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    invariant(value.schemaVersion === 1 && value.kind === 'expo-local-runtime-guard' && value.key === key(component) && value.origin === 'local', 'Invalid local runtime guard history.');
    return value;
  };
  const check = () => {
    for (const target of targets) {
      const fingerprint = target.observation.fingerprint;
      invariant(typeof fingerprint === 'string' && fingerprint.length > 0, 'appVersion local builds require a full native fingerprint.');
      const previous = read(target);
      invariant(!previous || previous.fingerprint === fingerprint, 'Native inputs changed under an existing appVersion runtime; prepare and commit a new native version before rebuilding.');
    }
  };
  check();
  return {
    /** Remember successful local fingerprints across worktrees; this is only an incompatibility guard, never a release baseline. */
    record() {
      check(); fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      for (const target of targets) {
        const entry = { schemaVersion: 1, kind: 'expo-local-runtime-guard', key: key(target),
          fingerprint: target.observation.fingerprint, source: plan.source.commit, origin: 'local' };
        try { fs.writeFileSync(path.join(directory, `${entry.key}.json`), `${JSON.stringify(entry)}\n`, { flag: 'wx', mode: 0o600 }); }
        catch (error) { if (error.code !== 'EEXIST') throw error; check(); }
      }
    }
  };
}
