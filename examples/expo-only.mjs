/** @file Demonstrates selection and stage ordering for a serverless Expo app with internal native distribution. */

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { buildReleaseGraph, selectComponents } from '../packages/release-engine/index.mjs';

/** Plan only changed native runtimes and OTA content; no backend, deployment, or store credentials are required. */
export function planExpoOnly({ current, baseline = {} }) {
  const components = [];
  for (const platform of ['android', 'ios']) {
    const runtimeChanged = current[platform].runtime !== baseline[platform]?.runtime;
    components.push({ id: `native:${platform}`, kind: 'native', identity: current[platform].runtime, baselineIdentity: baseline[platform]?.runtime });
    components.push({ id: `ota:${platform}`, kind: 'ota', identity: current[platform].bundle, baselineIdentity: baseline[platform]?.bundle, force: runtimeChanged, reasons: runtimeChanged ? ['new-native-runtime'] : [] });
  }
  const selection = selectComponents({ components });
  const stages = [];
  for (const platform of ['android', 'ios']) {
    const native = selection.selected.includes(`native:${platform}`);
    if (native) stages.push({ id: `build:${platform}`, component: `native:${platform}` });
    if (selection.selected.includes(`ota:${platform}`)) stages.push({ id: `publish:${platform}`, component: `ota:${platform}`, needs: native ? [`build:${platform}`] : [] });
  }
  return { selection, graph: buildReleaseGraph(stages) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const baseline = { android: { runtime: 'android-runtime-1', bundle: 'android-js-1' }, ios: { runtime: 'ios-runtime-1', bundle: 'ios-js-1' } };
  const current = { ...baseline, android: { runtime: 'android-runtime-1', bundle: 'android-js-2' } };
  process.stdout.write(`${JSON.stringify(planExpoOnly({ current, baseline }), null, 2)}\n`);
}
