/** @file Runs a third, serverless consumer through the actual shared plan and source-observation APIs, without a custom graph builder. */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { planRelease, completedBaseline, finalizePlan } from '../src/planner.mjs';
import { expoOnlyObservations } from './expo-only/release-hooks.mjs';

export const expoOnlyConfig = JSON.parse(readFileSync(new URL('./expo-only/release.config.json', import.meta.url), 'utf8'));

/** Pass observed application facts to the same immutable planner used by hosted consumers. */
export function planExpoOnly({ current, baseline = {}, source = { repository: expoOnlyConfig.repository, commit: 'a'.repeat(40), toolkitCommit: 'b'.repeat(40), origin: 'local' } }) {
  return planRelease({ config: expoOnlyConfig, source, origin: { kind: 'local' }, observations: expoOnlyObservations(current), baseline,
    providerConfiguration: { expo: expoOnlyConfig.expo, destinations: {} } });
}

/** Produce a synthetic completed baseline for the runnable demonstration; real callers read the shared release ledger. */
export function demonstrationBaseline(current) {
  const plan = planExpoOnly({ current });
  const allocated = plan.components.find(component => component.id === 'android').next;
  const prepared = { ...current, expoConfig: { ...current.expoConfig, version: allocated.version,
    android: { ...current.expoConfig.android, versionCode: allocated.versionCode } } };
  const finalized = finalizePlan(plan, plan.source, expoOnlyObservations(prepared));
  const baseline = completedBaseline(finalized, finalized.graph.stages.map(stage => ({ stage: stage.id, status: 'complete' })));
  return { current: prepared, baseline };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const previous = demonstrationBaseline({ fingerprint: 'c'.repeat(40), compatibility: 'd'.repeat(40), bundle: 'bundle-1', environmentHash: 'e'.repeat(64),
    expoConfig: { version: '1.0.0', android: { versionCode: 1, package: 'com.example.expoonly' }, extra: { eas: { projectId: expoOnlyConfig.expo.projectId } } } });
  process.stdout.write(`${JSON.stringify(planExpoOnly({ ...previous, current: { ...previous.current, bundle: 'bundle-2' } }), null, 2)}\n`);
}
