/** @file Exercises a third consumer with the canonical planner, source-hook observations, reservations and runtime binding; no app-specific branches or custom graph construction. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { planExpoOnly, demonstrationBaseline, expoOnlyConfig } from '../examples/expo-only.mjs';
import { expoOnlyObservations } from '../examples/expo-only/release-hooks.mjs';
import { verifyPlan } from '../packages/release-engine/index.mjs';
import { validateConfig } from '../src/config.mjs';
import { resolveOtaBindings } from '../src/ota-runtime.mjs';
import { finalizePlan } from '../src/planner.mjs';
import { baselineRuntimeOverrides } from '../src/eas-stages.mjs';

const initial = { fingerprint: 'c'.repeat(40), compatibility: 'd'.repeat(40), bundle: 'bundle-1', environmentHash: 'e'.repeat(64),
  expoConfig: { version: '1.0.0', android: { versionCode: 1, package: 'com.example.expoonly' }, extra: { eas: { projectId: expoOnlyConfig.expo.projectId } } } };

test('third consumer is declarative and has no backend, deployment, store or paired-device prerequisite', () => {
  assert.equal(validateConfig(expoOnlyConfig), expoOnlyConfig);
  assert.equal(expoOnlyConfig.deployment, undefined); assert.equal(expoOnlyConfig.nativeGroups, undefined);
  const plan = planExpoOnly({ current: initial }); verifyPlan(plan);
  assert.deepEqual(plan.selection.selected, ['android', 'android.ota']);
  assert.deepEqual(plan.graph.stages.map(stage => stage.id).sort(), ['android.ota:export', 'android.ota:publish', 'android:build']);
  assert.deepEqual(plan.components.find(component => component.id === 'android').next, { version: '1.0.1', versionCode: 2 });
  assert.deepEqual(plan.graph.stages.find(stage => stage.id === 'android.ota:export').needs, ['android:build']);
});

test('unchanged completed consumer is a no-op without allocating another version', () => {
  const previous = demonstrationBaseline(initial); const plan = planExpoOnly(previous);
  assert.equal(plan.selection.noop, true); assert.deepEqual(plan.graph.stages, []);
  assert.deepEqual(plan.reservations, previous.baseline.reservations);
});

test('JavaScript-only change selects only OTA with no native credentials or version bump', () => {
  const previous = demonstrationBaseline(initial); const plan = planExpoOnly({ ...previous, current: { ...previous.current, bundle: 'bundle-2' } });
  assert.deepEqual(plan.selection.selected, ['android.ota']);
  assert.deepEqual(plan.graph.stages.find(stage => stage.id === 'android.ota:export').needs, []);
  assert.deepEqual(plan.reservations, previous.baseline.reservations);
});

test('native change uses shared version reservations and requires native completion before OTA', () => {
  const previous = demonstrationBaseline(initial); const plan = planExpoOnly({ ...previous, current: { ...previous.current, compatibility: 'f'.repeat(40) } });
  assert.deepEqual(plan.selection.selected, ['android', 'android.ota']);
  assert.equal(plan.components.find(component => component.id === 'android').next.versionCode, 3);
  assert.deepEqual(plan.graph.stages.find(stage => stage.id === 'android.ota:export').needs, ['android:build']);
});

test('environment differences trigger the same native compatibility decision as other consumers', () => {
  const previous = demonstrationBaseline(initial); const plan = planExpoOnly({ ...previous, current: { ...previous.current, environmentHash: 'f'.repeat(64) } });
  assert.deepEqual(plan.selection.selected, ['android', 'android.ota']);
});

test('source-hook observations keep full native proof distinct from normalized selection identity', () => {
  const observations = expoOnlyObservations(initial);
  assert.equal(observations[0].fingerprint, initial.fingerprint); assert.equal(observations[0].identity, initial.compatibility);
  assert.equal(observations[1].identity, initial.bundle); assert.equal(observations[1].compatibilityIdentity, undefined);
});

test('Android-only retained runtime binds and overlays its original versions without an invented iOS counter', async () => {
  const previous = demonstrationBaseline(initial); const current = { ...previous.current, bundle: 'bundle-2' };
  const planned = planExpoOnly({ ...previous, current }); const plan = finalizePlan(planned, planned.source, expoOnlyObservations(current));
  const overlays = [];
  const resolved = await resolveOtaBindings({ plan, component: 'android.ota', root: process.cwd(),
    inputs: { expo: expoOnlyConfig.expo, hash: current.environmentHash, environment: {} },
    git: (_root, args) => args[0] === 'rev-parse' ? plan.source.commit : '',
    inspect: (_config, options) => { overlays.push(options.runtimeOverrides); return expoOnlyObservations(current); } });
  assert.equal(resolved.bindings.length, 1); assert.equal(resolved.bindings[0].runtime, '1.0.1');
  assert.deepEqual(overlays, [{ version: '1.0.1', androidVersionCode: 2 }]);
  assert.deepEqual(baselineRuntimeOverrides({ platform: 'ios', version: '2.0.0', versionCode: 8 }), { version: '2.0.0', iosBuildNumber: '8' });
  assert.throws(() => baselineRuntimeOverrides({ releaseMetadata: { version: '2.0.0' } }), /metadata/);
});
