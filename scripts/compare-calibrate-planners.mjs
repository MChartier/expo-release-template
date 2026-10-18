/** @file Characterize old/new selection on real immutable application commits using installed SDK runtime observations; never publish or change the consumer checkout. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { planRelease, configuredComponents, baselineKey } from '../src/planner.mjs';
import { hashIdentity } from '../packages/release-engine/index.mjs';
import { sourceEnvironment } from '../src/hooks.mjs';

const consumer = path.resolve(process.argv[2]);
const config = JSON.parse(fs.readFileSync(path.join(consumer, 'release.config.json'), 'utf8'));
let old;
const { applicationIdentity } = await import(pathToFileURL(path.join(consumer, 'scripts/release-inputs.mjs')));
const { resolveExpoRuntime } = await import(pathToFileURL(path.join(consumer, 'scripts/expo-runtime.mjs')));
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'calibrate-planner-parity-'));
const environment = sourceEnvironment(process.env, config.inspection.environment);
const git = args => execFileSync('git', ['--no-replace-objects', ...args], { cwd: directory, env: sourceEnvironment(),
  encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }).trim();
const read = (commit, file) => git(['show', `${commit}:${file}`]);
const revisions = ['7150900b81f244be41f0f225ad8bb25c78df668b', 'bac172e90462bf8f417f6797e03f10d135b5892f',
  '51da7b8962123a078deb0725a1fa356537318947', '3dfb97c064c55cb55b514415618220f03dce91f1', '2e8def677fff5e4ff486565218ed5d9afcc4498b'];
const observationFile = new URL('../test/fixtures/calibrate/planner-observations.json', import.meta.url);
const observations = fs.existsSync(observationFile) ? new Map(Object.entries(JSON.parse(fs.readFileSync(observationFile)))) : new Map(); let installedLock;
try {
  execFileSync('git', ['clone', '--shared', '--no-checkout', '--quiet', consumer, directory], { env: sourceEnvironment(), windowsHide: true, stdio: 'inherit' });
  git(['checkout', '--quiet', '--detach', revisions.at(-1)]);
  old = await import(pathToFileURL(path.join(directory, 'scripts/release-selection.mjs')));
  for (const commit of revisions) {
    if (observations.has(commit)) continue;
    git(['checkout', '--quiet', '--detach', commit]);
    const lock = hashIdentity(read(commit, 'package-lock.json'));
    if (lock !== installedLock) {
      const npm = process.env.npm_execpath ?? path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
      execFileSync(process.execPath, [npm, 'ci', '--no-audit', '--no-fund'], { cwd: directory, env: sourceEnvironment(), windowsHide: true, stdio: 'inherit' });
      installedLock = lock;
    }
    const manifest = JSON.parse(read(commit, 'shared/release.json'));
    const runtime = resolveExpoRuntime(directory, { environment });
    const identities = Object.fromEntries(['server', 'ota', 'wear'].map(kind => [kind, applicationIdentity(directory, commit, kind)]));
    assert.equal(identities.wear, old.wearInputHash(directory, commit));
    assert.equal(git(['status', '--porcelain', '--untracked-files=no']), '');
    observations.set(commit, { manifest, runtime, identities });
    fs.writeFileSync(observationFile, `${JSON.stringify(Object.fromEntries(observations), null, 2)}\n`);
    console.log(`Read-only source ${commit}: runtime ${runtime}`);
  }
  const components = configuredComponents(config, 'production'); const results = [];
  const cases = [{ name: 'first-release', source: revisions[0] }, { name: 'unchanged', source: revisions[4], baseline: revisions[4] },
    ...revisions.slice(1).map((source, i) => ({ name: `real-change-${i + 1}`, source, baseline: revisions[i] })),
    { name: 'failed-reservation', source: revisions[3], baseline: revisions[2], failed: true },
    { name: 'major-contract', source: revisions[1], baseline: revisions[0], bump: 'major' }];
  const changes = (baseline, source, kind) => !baseline ? ['first release'] : git(['diff', '--name-only', '--no-renames', baseline, source]).split(/\r?\n/)
    .filter(file => file && old.affectsComponent(file, kind)).filter(file => {
      try { return old.applicationContent(file, read(baseline, file)) !== old.applicationContent(file, read(source, file)); } catch { return true; }
    });
  for (const scenario of cases) {
    const actual = observations.get(scenario.source); const previous = observations.get(scenario.baseline); const bump = scenario.bump ?? 'patch';
    const native = previous?.manifest.android;
    const oldBaseline = previous ? { server: { source_commit: scenario.baseline }, ota_internal: { source_commit: scenario.baseline }, ota_production: { source_commit: scenario.baseline },
      native: { runtime_version: previous.runtime, wear_hash: previous.identities.wear, version: native.mobile.version_name,
        phone_code: native.mobile.version_code, wear_code: native.wear.version_code },
      reserved_native_version: scenario.failed ? actual.manifest.android.mobile.version_name : native.mobile.version_name,
      reserved_native_code: scenario.failed ? actual.manifest.android.wear.version_code : native.wear.version_code } : undefined;
    const legacy = old.selectRelease({ manifest: actual.manifest, baseline: oldBaseline, runtimeVersion: actual.runtime, wearHash: actual.identities.wear,
      serverChanges: changes(scenario.baseline, scenario.source, 'server'), otaChanges: changes(scenario.baseline, scenario.source, 'ota'), bump });
    const identity = (component, observation) => component.id === 'phone' ? observation.runtime : observation.identities[component.id === 'wear' ? 'wear' : component.kind === 'server' ? 'server' : 'ota'];
    const baseline = { components: {}, runtimes: {}, reservations: {} };
    if (previous) {
      for (const component of components) baseline.components[baselineKey(component, 'production')] = {
        identity: hashIdentity({ identity: identity(component, previous), environment: null }), source: scenario.baseline };
      baseline.reservations.native = { version: oldBaseline.reserved_native_version,
        codes: { phone: oldBaseline.reserved_native_code - 1, wear: oldBaseline.reserved_native_code } };
      baseline.reservations.server = { version: previous.manifest.server.version, codes: {} };
    }
    const observed = components.map(component => ({ id: component.id, identity: identity(component, actual), runtime: actual.runtime, fingerprint: actual.runtime,
      version: component.kind === 'server' ? actual.manifest.server.version : actual.manifest.android.mobile.version_name,
      ...(component.kind === 'native' ? { versionCode: actual.manifest.android[component.id === 'wear' ? 'wear' : 'mobile'].version_code } : {}) }));
    const modern = planRelease({ config, source: { repository: config.repository, commit: scenario.source, toolkitCommit: 'b'.repeat(40), origin: 'local' },
      origin: { kind: 'local' }, profile: 'production', observations: observed, baseline, bump });
    const selected = id => modern.selection.selected.includes(id); const component = id => modern.components.find(value => value.id === id);
    const outcome = { server: selected('server'), native: selected('phone'), ota_internal: selected('ota-internal'), ota_production: selected('ota-production'), noop: modern.selection.noop,
      server_version: component('server').next?.version ?? null, native_version: component('phone').next?.version ?? null,
      native_codes: selected('phone') ? { mobileVersionCode: component('phone').next.versionCode, wearVersionCode: component('wear').next.versionCode } : null };
    const expected = Object.fromEntries(Object.keys(outcome).map(key => [key, legacy[key]]));
    assert.deepEqual(outcome, expected, scenario.name);
    results.push({ ...scenario, outcome }); console.log(`Planner parity: ${scenario.name}`);
  }
  const output = new URL('../test/fixtures/calibrate/planner-parity.json', import.meta.url);
  fs.writeFileSync(output, `${JSON.stringify({ schemaVersion: 1, method: 'Read-only real Git inputs and installed Expo SDK runtime resolution in an isolated clone; no provider calls.',
    revisions: Object.fromEntries(observations), scenarios: results }, null, 2)}\n`);
} finally {
  assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()));
  fs.rmSync(directory, { recursive: true, force: true });
}
