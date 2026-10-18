/** @file Historical source resolution retains approved public inputs while excluding inherited credentials and workflow capabilities. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectExpoSource, exportExpoSource } from '../src/expo-source.mjs';

test('runtime, public config and export receive the same approved channel/origin without inherited auth', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-source-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  fs.writeFileSync(path.join(directory, 'package.json'), '{}');
  for (const name of ['expo', 'expo-updates']) {
    const root = path.join(directory, 'node_modules', name); fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name, version: '1.0.0' })); fs.writeFileSync(path.join(root, 'bin', 'cli'), '');
  }
  const environment = { EXPO_PUBLIC_CALIBRATE_SERVER_URL: 'https://fixture.invalid', EXPO_PUBLIC_EAS_PROJECT_ID: 'project', EXPO_UPDATES_CHANNEL: 'production' };
  const previous = process.env.EXPO_TOKEN; process.env.EXPO_TOKEN = 'must-not-enter-source';
  t.after(() => { if (previous === undefined) delete process.env.EXPO_TOKEN; else process.env.EXPO_TOKEN = previous; });
  const calls = []; const execute = (_command, args, options) => {
    calls.push({ args, options });
    return JSON.stringify(args.includes('runtimeversion:resolve') ? { runtimeVersion: 'a'.repeat(40) } : { extra: { eas: { projectId: 'project' } } });
  };
  assert.equal(inspectExpoSource({ directory, platform: 'android', environment, execute }).runtime, 'a'.repeat(40));
  exportExpoSource({ directory, platform: 'android', outputDirectory: path.join(directory, 'output'), environment, execute });
  assert.equal(calls.length, 3);
  for (const { options } of calls) {
    for (const [name, value] of Object.entries(environment)) assert.equal(options.env[name], value);
    assert.equal(options.env.EXPO_TOKEN, undefined); assert.equal(options.env.GITHUB_OUTPUT, undefined);
    assert.equal(options.env.EXPO_NO_DOTENV, '1'); assert.equal(options.env.EXPO_NO_METRO_WORKSPACE_ROOT, '1');
    assert.equal(options.env.NODE_ENV, 'production');
  }
  assert.equal(calls[0].options.env.EXPO_UPDATES_WORKFLOW_OVERRIDE, 'managed');
  assert.throws(() => inspectExpoSource({ directory, platform: 'android', environment: { EXPO_TOKEN: 'forbidden' }, execute }), /Unsafe source/);
});
