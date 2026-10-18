/** @file Local runtime collisions remain blocked across worktrees and original caches without creating hosted release authority. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { localRuntimeGuard } from '../src/local-runtime.mjs';
import { localSettingsPath } from '../src/local-credentials.mjs';

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'runtime-guard-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const root = path.join(directory, 'app'); fs.mkdirSync(root);
  const config = { repository: 'fixture/app', local: { legacyMetadataFields: { baselines: 'string-map' }, legacyBuildReceiptsField: 'baselines' } };
  const component = { id: 'android', selected: true, kind: 'native', platform: 'android', runtimePolicy: 'appVersion',
    observation: { version: '1.0.0', runtime: '1.0.0', fingerprint: 'a'.repeat(40) } };
  const plan = { config, source: { repository: config.repository, commit: 'b'.repeat(40) }, profile: 'internal', components: [component] };
  return { plan, root, environment: { LOCALAPPDATA: directory, XDG_CONFIG_HOME: directory } };
}

test('successful local appVersion fingerprints guard another worktree but a failed build reserves nothing', t => {
  const input = fixture(t);
  localRuntimeGuard(input); input.plan.components[0].observation.fingerprint = 'c'.repeat(40);
  localRuntimeGuard(input).record();
  const nextRoot = path.join(path.dirname(input.root), 'second'); fs.mkdirSync(nextRoot); input.root = nextRoot;
  localRuntimeGuard(input);
  input.plan.components[0].observation.fingerprint = 'd'.repeat(40);
  assert.throws(() => localRuntimeGuard(input), /new native version/);
  input.plan.components[0].observation.runtime = '1.0.1'; input.plan.components[0].observation.version = '1.0.1';
  localRuntimeGuard(input).record();
  input.plan.components[0].runtimePolicy = 'fingerprint'; localRuntimeGuard(input).record();
});

test('original local receipts block same-version native changes before and after settings migration', t => {
  for (const migrated of [false, true]) {
    const input = fixture(t); const settings = localSettingsPath(input.plan.config, input.root, input.environment);
    fs.mkdirSync(path.dirname(settings), { recursive: true }); const baseline = path.join(path.dirname(settings), 'baseline.json');
    fs.writeFileSync(baseline, JSON.stringify({ schema: 1, platform: 'android', profile: 'internal', release: { version: '1.0.0' }, fingerprint: 'a'.repeat(40) }));
    const original = { baselines: { 'android:internal': baseline } };
    fs.writeFileSync(settings, JSON.stringify(migrated ? { schemaVersion: 1, legacy: original } : original));
    localRuntimeGuard(input);
    input.plan.components[0].observation.fingerprint = 'c'.repeat(40);
    assert.throws(() => localRuntimeGuard(input), /new native version/);
    assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')), migrated ? { schemaVersion: 1, legacy: original } : original);
    fs.rmSync(baseline); assert.throws(() => localRuntimeGuard(input), /missing/);
  }
});

test('overlapping worktree builds cannot replace a successful runtime fingerprint', t => {
  const input = fixture(t); const first = localRuntimeGuard(input);
  const secondInput = { ...input, plan: structuredClone(input.plan) };
  secondInput.plan.components[0].observation.fingerprint = 'c'.repeat(40);
  const second = localRuntimeGuard(secondInput);
  first.record();
  assert.throws(() => second.record(), /new native version/);
  localRuntimeGuard(input).record();
  assert.throws(() => localRuntimeGuard(secondInput), /new native version/);
});
