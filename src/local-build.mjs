/** @file Local command and macOS EAS builds share canonical artifact schemas while isolating signing and provider authentication from preparation. */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { invariant, hashIdentity, verifyPlan } from '../packages/release-engine/index.mjs';
import { finalizePlan } from './planner.mjs';
import { inspectSource, sourceGit } from './source.mjs';
import { prepareBuild, buildApplication } from './build.mjs';
import { localSigningInputs } from './local-credentials.mjs';
import { writeLocalReceipt } from './ledger.mjs';
import { repositoryPath } from './config.mjs';
import { buildLocalEas } from './local-eas.mjs';
import { localRuntimeGuard } from './local-runtime.mjs';

/** Build each configured native cohort once, record exact local evidence, and never call a publication provider. */
export async function buildLocally({ plan, root, environment = process.env, credentialsFile,
  prepare = prepareBuild, build = buildApplication, eas = buildLocalEas, signing = localSigningInputs, inspect = inspectSource, git = sourceGit }) {
  verifyPlan(plan);
  invariant(plan.origin.kind === 'local' && plan.operation === 'build' && !plan.source.workflowCommit, 'Only local build plans may execute here.');
  invariant(git(root, ['rev-parse', 'HEAD']) === plan.source.commit && !git(root, ['status', '--porcelain', '--untracked-files=no']), 'Local build source changed after planning.');
  const selected = plan.components.filter(component => component.selected);
  const builder = component => component.localBuilder ?? component.builder;
  invariant(selected.length && selected.every(component => component.kind === 'native' &&
    (builder(component) === 'command' || component.platform === 'ios' && component.localBuilder === 'eas')), 'Local builds require an explicit supported native builder.');
  const runtimeGuard = localRuntimeGuard({ plan, root, environment });
  const inputs = { expo: plan.providerConfiguration.expo, components: Object.fromEntries(plan.components.map(component => [component.id, {
    environment: component.observation.environment ?? {}, hash: component.observation.environmentHash ?? null }])) };
  const prepared = finalizePlan(plan, plan.source, plan.components.map(component => component.observation));
  const outputRoot = repositoryPath(root, `.release/builds/${prepared.digest}`);
  const results = []; const groups = new Set();
  for (const component of selected) {
    const group = component.buildGroup ?? component.id;
    if (groups.has(group)) continue;
    groups.add(group);
    invariant(selected.filter(value => (value.buildGroup ?? value.id) === group).every(value => builder(value) === builder(component)), 'A local build group has conflicting builders.');
    const currentInputs = { ...inputs, ...inputs.components[component.id] };
    if (builder(component) === 'eas') {
      invariant(!component.buildGroup && !credentialsFile, 'Local iOS EAS builds use their EAS signing context, not an Android credential file or build group.');
      results.push(...await eas({ plan: prepared, component, root, outputRoot, inputs: currentInputs, environment }));
    } else {
      await prepare({ plan: prepared, target: component.id, root, inputs: currentInputs });
      const secretInputs = component.platform === 'android' && component.signing
        ? signing({ config: plan.config, root, target: component.id, credentialsFile, environment }) : {};
      const signingDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-local-signing-'));
      try {
        results.push(...await build({ plan: prepared, target: component.id, root, outputRoot, inputs: currentInputs,
          origin: plan.origin, toolkitCommit: plan.source.toolkitCommit, signingDirectory, environment: secretInputs }));
      } finally { invariant(path.dirname(path.resolve(signingDirectory)) === path.resolve(os.tmpdir()), 'Signing cleanup escaped temporary storage.'); fs.rmSync(signingDirectory, { recursive: true, force: true }); }
    }
    const observations = inspect(plan.config, { root, source: plan.source, profile: plan.profile, baseline: plan.baseline,
      environment: currentInputs.environment, environmentHash: currentInputs.hash, componentEnvironments: inputs.components });
    for (const target of selected.filter(value => (value.buildGroup ?? value.id) === group)) {
      const actual = observations.find(value => value.id === target.id);
      if (target.runtimePolicy === 'fingerprint') invariant(actual?.runtime === target.observation.runtime, 'Compilation changed the prepared native fingerprint.');
      if (target.observation.fingerprint) invariant(actual?.fingerprint === target.observation.fingerprint, 'Compilation changed the original full native fingerprint.');
    }
  }
  invariant(hashIdentity(results.map(value => value.target).sort()) === hashIdentity(selected.map(value => value.id).sort()), 'Local build did not produce exactly its selected targets.');
  runtimeGuard.record();
  return writeLocalReceipt(root, prepared, results);
}
