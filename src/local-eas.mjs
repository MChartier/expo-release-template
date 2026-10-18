/** @file Runs an explicitly selected local iOS EAS build on macOS; only the fixed provider invocation receives Expo authentication. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { invariant } from '../packages/release-engine/index.mjs';
import { repositoryPath } from './config.mjs';
import { sourceEnvironment, runHook } from './hooks.mjs';
import { verifyBuildSource, sealBuild } from './build.mjs';
import { createEasTransport } from './providers/eas.mjs';

/** Build exact local source with the configured EAS profile, then verify and seal the IPA without granting hosted publication authority. */
export async function buildLocalEas({ plan, component, root, outputRoot, inputs, environment = process.env,
  platform = process.platform, verifySource = verifyBuildSource, transportFactory = createEasTransport, hook = runHook }) {
  invariant(platform === 'darwin', 'Local iOS EAS builds require macOS with Xcode.');
  invariant(plan.origin.kind === 'local' && plan.operation === 'build' && component.kind === 'native'
    && component.platform === 'ios' && component.localBuilder === 'eas' && !component.buildGroup, 'Expected an explicit local iOS EAS build.');
  invariant(typeof component.profile === 'string' && component.profile.length > 0, 'Local EAS requires an explicit configured build profile.');
  verifySource(plan, component.id, root);
  const directory = repositoryPath(outputRoot, `${component.id}/files`); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'app.ipa'); invariant(!fs.existsSync(file), 'Local EAS output must be fresh.');
  const publicEnvironment = sourceEnvironment(environment, inputs.environment ?? {});
  const platformVariable = plan.config.expo?.environmentPolicy?.platformVariable;
  const platformEnvironment = sourceEnvironment({}, platformVariable ? { [platformVariable]: 'ios' } : {});
  const providerEnvironment = { ...publicEnvironment, CI: '1', EXPO_NO_DOTENV: '1',
    ...platformEnvironment, ...(environment.EXPO_TOKEN ? { EXPO_TOKEN: environment.EXPO_TOKEN } : {}) };
  const cwd = !component.appDirectory || component.appDirectory === '.' ? root : repositoryPath(root, component.appDirectory);
  const transport = transportFactory({ cwd, env: providerEnvironment });
  await transport.cli(['build', '--local', '--platform', 'ios', '--profile', component.profile, '--output', file, '--non-interactive'], false);
  invariant(fs.statSync(file).isFile() && fs.statSync(file).size > 0, 'Local EAS did not return an IPA.');
  verifySource(plan, component.id, root);
  const artifact = { kind: 'native', nativeOrigin: 'local', target: component.id, platform: 'ios', profile: plan.profile,
    source: plan.source.commit, directory, runtime: component.observation.runtime, version: component.observation.version,
    versionCode: component.observation.versionCode, fingerprint: component.observation.fingerprint,
    files: [{ path: 'app.ipa', sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }] };
  const checked = hook(plan.config, 'verify', { plan, target: component.id, source: plan.source, artifact, profile: plan.profile,
    environment: inputs.environment ?? {} }, { root, environment: publicEnvironment });
  invariant(checked.verified === true, 'Application IPA verification failed.');
  return sealBuild({ plan, component, artifacts: [artifact], outputRoot, inputs, origin: plan.origin, toolkitCommit: plan.source.toolkitCommit });
}
