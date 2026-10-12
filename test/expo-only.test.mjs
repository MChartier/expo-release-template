/** @file Verifies that the starter supports true no-op, client-only OTA, and independent native platforms without server configuration. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { planExpoOnly } from '../examples/expo-only.mjs';

const baseline = { android: { runtime: 'a1', bundle: 'aj1' }, ios: { runtime: 'i1', bundle: 'ij1' } };

test('unchanged serverless app has no release stages', () => {
  const result = planExpoOnly({ current: baseline, baseline });
  assert.equal(result.selection.noop, true);
  assert.deepEqual(result.graph.stages, []);
});

test('Android JavaScript change selects only Android OTA without deploy or native build', () => {
  const result = planExpoOnly({ current: { ...baseline, android: { ...baseline.android, bundle: 'aj2' } }, baseline });
  assert.deepEqual(result.selection.selected, ['ota:android']);
  assert.deepEqual(result.graph.stages.map(stage => [stage.id, stage.needs]), [['publish:android', []]]);
});

test('new iOS runtime selects only its native build and dependent OTA', () => {
  const result = planExpoOnly({ current: { ...baseline, ios: { ...baseline.ios, runtime: 'i2' } }, baseline });
  assert.deepEqual(result.selection.selected, ['native:ios', 'ota:ios']);
  assert.deepEqual(result.graph.stages.find(stage => stage.id === 'publish:ios').needs, ['build:ios']);
});
