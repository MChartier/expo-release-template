/** @file Validate nested reusable-worker permissions, secret routing, approvals and canonical stage execution without publication credentials. */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { phaseMatrices, verifyRunReservation } from '../src/worker.mjs';
import { signingSecretNames } from '../src/artifact-worker.mjs';
import { planRelease, completedBaseline } from '../src/planner.mjs';
import { validateConfig } from '../src/config.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const files = fs.readdirSync(path.join(root, '.github/workflows')).filter(file => file.endsWith('.yml'));
const workflows = Object.fromEntries(files.map(file => [file, parse(fs.readFileSync(path.join(root, '.github/workflows', file), 'utf8'))]));
const rank = { none: 0, read: 1, write: 2 };

test('source jobs receive signing names only for configured command Android builds', () => {
  const signing = { variables: { file: 'APP_KEY' }, secretNames: { keystore: 'APP_KEYSTORE' } };
  for (const component of [{ kind: 'server' }, { kind: 'ota' }, { kind: 'native', builder: 'eas', platform: 'android', signing },
    { kind: 'native', builder: 'command', platform: 'ios', signing }, { kind: 'native', builder: 'command', platform: 'android' }]) {
    assert(Object.values(signingSecretNames(component)).every(value => value === ''));
  }
  assert.equal(signingSecretNames({ kind: 'native', builder: 'command', platform: 'android', signing }).signing_keystore_secret, 'APP_KEYSTORE');
});

test('whole-run retries retain original reservation identity and reject changed requested targets', () => {
  const config = { schemaVersion: 1, repository: 'fixture/app', defaultBranch: 'main', components: [{ id: 'server', kind: 'server' }] };
  const origin = { kind: 'github', runId: '123', runAttempt: 1 };
  const source = { repository: config.repository, commit: 'a'.repeat(40), workflowCommit: 'a'.repeat(40), toolkitCommit: 'b'.repeat(40) };
  const plan = planRelease({ config, source, origin, profile: '', operation: 'build', targets: ['server'], observations: [{ id: 'server', identity: 'source' }] });
  const authorized = { config, source, request: { action: 'release', operation: 'build', profile: '', targets: ['server'] } };
  assert.equal(verifyRunReservation({ plan, reservation: plan }, authorized, { ...origin, runAttempt: 2 }), plan);
  assert.throws(() => verifyRunReservation({ plan }, { ...authorized, request: { ...authorized.request, targets: [] } }, { ...origin, runAttempt: 2 }), /selection/);
  assert.throws(() => verifyRunReservation({ plan }, authorized, { ...origin, runId: '124' }), /original run/);
});

test('every nested call exists, forwards declared secrets explicitly, and propagates all required permissions', () => {
  for (const [file, workflow] of Object.entries(workflows)) for (const [name, job] of Object.entries(workflow.jobs)) {
    assert.notEqual(job.secrets, 'inherit', `${file}/${name} implicitly forwards credentials`);
    if (!job.uses?.startsWith('./.github/workflows/')) continue;
    const called = workflows[path.basename(job.uses)]; assert(called, `${file}/${name} points to a missing worker`);
    assert(!job.environment && !job.steps && !job['runs-on'], 'A reusable caller cannot define worker-only properties');
    for (const key of Object.keys(job.with ?? {})) assert(Object.hasOwn(called.on.workflow_call.inputs ?? {}, key), `${file}/${name} passes an unsupported input ${key}`);
    for (const key of Object.keys(job.secrets ?? {})) assert(Object.hasOwn(called.on.workflow_call.secrets ?? {}, key), `${file}/${name} passes an undeclared secret ${key}`);
    const permissions = job.permissions ?? workflow.permissions ?? {};
    for (const child of Object.values(called.jobs)) for (const [scope, level] of Object.entries(child.permissions ?? called.permissions ?? {})) {
      assert((rank[permissions[scope] ?? 'none']) >= rank[level], `${file}/${name} cannot grant ${scope}:${level} to ${job.uses}`);
    }
  }
});

test('publishers use independently pinned tooling and never install or execute application source', () => {
  for (const file of ['release-publish.yml', 'release-image.yml', 'release-deploy.yml', 'release-attest.yml', 'release-legacy.yml']) for (const job of Object.values(workflows[file].jobs)) {
    for (const step of job.steps ?? []) {
      if (step.uses?.startsWith('actions/checkout@')) {
        assert.equal(step.with.repository, 'MChartier/expo-release-template'); assert.equal(step.with.ref, '${{ job.workflow_sha }}');
        assert.equal(step.with['persist-credentials'], false);
      }
      assert(!/worker\.mjs install|source-build|source-prepare|npm ci --prefix \.app|release-hooks/.test(step.run ?? ''), 'Publisher evaluated application source');
      if (step.run?.includes('npm ci')) assert(!step.env?.EXPO_TOKEN && !step.env?.GH_TOKEN, 'Dependency install received publication credentials');
    }
  }
  assert.equal(workflows['release-publish.yml'].jobs['approved-publish'].environment, '${{ inputs.approval }}');
  assert.equal(workflows['release-artifact.yml'].jobs['approved-environment'].environment, '${{ inputs.approval }}');
  assert.equal(workflows['release-artifact.yml'].jobs['signed-source'].environment, '${{ inputs.signing-environment }}');
  const native = workflows['release-artifact.yml'];
  for (const name of Object.keys(native.on.workflow_call.secrets).filter(key => key.startsWith('CALIBRATE_ANDROID_'))) {
    for (const caller of ['release-handler.yml', 'release-components.yml', 'release-recovery.yml']) {
      assert(Object.hasOwn(workflows[caller].on.workflow_call.secrets, name), `Existing environment secret ${name} was lost in ${caller}`);
    }
  }
});

test('canonical matrices skip successful targets and never publish a build-only operation', () => {
  const config = { schemaVersion: 1, repository: 'fixture/app', defaultBranch: 'main', components: [
    { id: 'server', kind: 'server', publication: { movingTag: 'latest' } },
    { id: 'phone', kind: 'native', builder: 'command', platform: 'android', signingEnvironment: 'signing' },
    { id: 'ota', kind: 'ota', platform: 'android', nativeTarget: 'phone', channel: 'production', environment: 'production', approvalEnvironment: 'production' }] };
  const input = { config, source: { repository: config.repository, commit: 'a'.repeat(40), toolkitCommit: 'b'.repeat(40), origin: 'local' },
    origin: { kind: 'local' }, observations: config.components.map(({ id }) => ({ id, identity: id, version: '1.0.0', runtime: '1.0.0' })) };
  const build = phaseMatrices(planRelease({ ...input, operation: 'build' }));
  assert.equal(build.server.length, 1); assert.equal(build.server_publish.length, 0); assert.equal(build.server_finalize.length, 0);
  assert.equal(build.native_first.length, 0); assert.equal(build.ota_first.length, 0);
  const resume = phaseMatrices(planRelease(input), ['phone:submit']);
  assert.equal(resume.server.length, 0); assert.equal(resume.native_builds.length, 0); assert.equal(resume.ota_first.length, 0);
  assert.deepEqual(resume.native_first, [{ target: 'phone', approval: '' }]);
  const buildPlan = planRelease({ ...input, operation: 'build' });
  assert.deepEqual(completedBaseline(buildPlan, Object.keys(buildPlan.stages).map(stage => ({ stage, status: 'complete' }))), buildPlan.baseline);
});

test('a partially retained cohort resumes the original group leader with every cohort target', () => {
  const config = { schemaVersion: 1, repository: 'fixture/app', defaultBranch: 'main', nativeGroups: [['phone', 'wear']], components:
    ['phone', 'wear'].map(id => ({ id, kind: 'native', platform: 'android', builder: 'command', buildGroup: 'pair' })) };
  const plan = planRelease({ config, source: { repository: config.repository, commit: 'a'.repeat(40), toolkitCommit: 'b'.repeat(40), origin: 'local' },
    origin: { kind: 'local' }, observations: config.components.map(({ id }) => ({ id, identity: id, version: '1.0.0', runtime: id })) });
  assert.deepEqual(phaseMatrices(plan, ['wear:build']).native_builds,
    [{ id: 'pair', target: 'phone', targets: ['phone', 'wear'], builder: 'command', approval: '' }]);
});

test('OTA scheduling follows native handoff waves and build-only profiles before any candidate is created', () => {
  const config = { schemaVersion: 1, repository: 'fixture/app', defaultBranch: 'main', components: [
    { id: 'phone', kind: 'native', platform: 'android', builder: 'command' },
    { id: 'wear', kind: 'native', platform: 'android', builder: 'command', after: ['phone'] },
    { id: 'wear-ota', kind: 'ota', platform: 'android', nativeTarget: 'wear', channel: 'internal', environment: 'preview' }] };
  const input = { config, source: { repository: config.repository, commit: 'a'.repeat(40), toolkitCommit: 'b'.repeat(40), origin: 'local' },
    origin: { kind: 'local' }, observations: config.components.map(({ id }) => ({ id, identity: id, version: '1.0.0', runtime: '1.0.0' })) };
  const plan = planRelease(input);
  assert.deepEqual(phaseMatrices(plan).ota_first, []);
  assert.deepEqual(phaseMatrices(plan).ota_second, [{ target: 'wear-ota', approval: '' }]);
  assert.deepEqual(phaseMatrices(plan, ['wear-ota:export', 'wear-ota:publish']).ota_second, [{ target: 'wear-ota', approval: '' }]);
  for (const component of config.components.filter(value => value.kind === 'native')) component.submit = false;
  assert.deepEqual(phaseMatrices(planRelease(input)).ota_first, [{ target: 'wear-ota', approval: '' }]);
  for (const job of ['ota-first-export', 'ota-second-export', 'native-second-handoff']) {
    assert(workflows['release-components.yml'].jobs[job].needs.includes('native-build'), `${job} can race a pending build when submission jobs are skipped`);
    assert(workflows['release-components.yml'].jobs[job].needs.includes('deployment'));
  }
  for (const component of config.components.filter(value => value.kind === 'native')) component.submit = true;
  config.components.push({ ...config.components[2], id: 'wear-production', after: ['wear-ota'] });
  input.observations.push({ ...input.observations[2], id: 'wear-production' });
  assert.throws(() => planRelease(input), /at most two publication waves/);
});

test('configuration rejects ignored publication constraints and conflicting version ownership', () => {
  const components = [{ id: 'server', kind: 'server' }, { id: 'phone', kind: 'native', platform: 'android', builder: 'eas' }];
  const config = { schemaVersion: 1, repository: 'fixture/app', defaultBranch: 'main', components };
  assert.throws(() => validateConfig({ ...config, components: [{ ...components[0], after: ['phone'] }, components[1]] }), /predecessor kind/);
  assert.throws(() => validateConfig({ ...config, versionGroups: [{ id: 'one', targets: ['phone'] }, { id: 'two', targets: ['phone'] }] }), /at most one version group/);
  assert.throws(() => validateConfig({ ...config, versionGroups: [{ id: 'one', targets: ['phone'] }, { id: 'one', targets: ['server'] }] }), /Duplicate version group/);
});

test('historical workers route only their provider credentials and approvals; recovery downloads the producing cloud run', () => {
  const legacy = workflows['release-legacy.yml'];
  for (const [name, job] of Object.entries(legacy.jobs)) {
    const provider = name.replace('approved-', '');
    const env = job.steps.at(-1).env;
    assert.equal(Boolean(env.EXPO_TOKEN), ['expo', 'audit'].includes(provider));
    assert.equal(Boolean(env.GHCR_TOKEN), ['image', 'audit'].includes(provider));
    assert.equal(Boolean(env.DEPLOY_TOKEN), provider === 'deploy');
    assert.equal(Boolean(job.environment), name.startsWith('approved-'));
    assert.equal(env.RECOVERY_PROVIDER, provider);
  }
  const download = workflows['release-artifact.yml'].jobs['cloud-observe'].steps.find(value => value.with?.name?.startsWith('cloud-accepted-'));
  assert.equal(download.with['run-id'], '${{ needs.cloud-intent.outputs.producer_run }}');
  assert.equal(download.with['github-token'], '${{ github.token }}');
});
