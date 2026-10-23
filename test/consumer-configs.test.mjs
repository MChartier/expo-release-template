/** @file Exercise both real consumer contracts together; the third serverless example guards against accidental application coupling. */
import fs from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { validateConfig } from '../src/config.mjs';
import { planRelease, configuredComponents, completedBaseline } from '../src/planner.mjs';

for (const name of ['calibrate', 'little-say']) {
  const config = JSON.parse(fs.readFileSync(new URL(`./fixtures/${name}/release.config.json`, import.meta.url)));
  test(`${name} contract selects real targets, retains independent baselines, and rejects cloud signing environments`, () => {
    validateConfig(config);
    const components = configuredComponents(config, config.defaultProfile);
    const observations = components.map(value => ({ id: value.id, identity: value.id, version: '1.2.3',
      runtime: value.runtimePolicy === 'appVersion' ? '1.2.3' : 'a'.repeat(40), fingerprint: 'a'.repeat(40),
      ...(value.kind === 'native' ? { versionCode: value.id === 'wear' ? 18 : 17 } : {}) }));
    const input = { config, source: { repository: config.repository, commit: 'b'.repeat(40), toolkitCommit: 'c'.repeat(40), origin: 'local' },
      origin: { kind: 'local' }, observations };
    const first = planRelease(input);
    const baseline = completedBaseline(first, first.graph.stages.map(value => ({ stage: value.id, status: 'complete' })));
    assert(planRelease({ ...input, baseline }).selection.noop);
    for (const native of components.filter(value => value.kind === 'native')) {
      const changed = observations.map(value => value.id === native.id ? { ...value, identity: 'changed', runtime: 'd'.repeat(40), fingerprint: 'd'.repeat(40) } : value);
      const plan = planRelease({ ...input, baseline, observations: changed });
      assert(plan.selection.selected.includes(native.id));
      for (const group of config.nativeGroups ?? []) if (group.includes(native.id)) assert(group.every(id => plan.selection.selected.includes(id)));
      for (const independent of components.filter(value => value.kind === 'native' && value.id !== native.id
        && !(config.nativeGroups ?? []).some(group => group.includes(native.id) && group.includes(value.id)))) {
        assert(!plan.selection.selected.includes(independent.id), 'Independent unchanged native platform was selected.');
      }
    }
    const cloud = structuredClone(config); const target = cloud.components.find(value => value.kind === 'native');
    target.builder = 'eas'; target.signingEnvironment = 'separate-signing';
    assert.throws(() => validateConfig(cloud), /EAS owns cloud signing/);
  });
}
