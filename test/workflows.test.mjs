/** @file Check actual workflow dependencies, permission boundaries and supported upstream setup. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import YAML from 'yaml';
const workflow = YAML.parse(fs.readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8'));
const setup = YAML.parse(fs.readFileSync(new URL('../.github/actions/setup/action.yml', import.meta.url), 'utf8'));
const jobs = workflow.jobs;

/** Read the fixed prerequisites from a GitHub job. */
function needs(name) { return [jobs[name].needs ?? []].flat(); }

test('the single reusable release workflow has fixed jobs and repository serialization', () => {
  assert.ok(workflow.on.workflow_call); assert.equal(workflow.concurrency['cancel-in-progress'], false);
  assert.deepEqual(Object.keys(workflow.on.workflow_call.inputs), ['profile', 'rebuild']);
  for (const name of ['prepare', 'reserve', 'server-build', 'server-publish', 'server-deploy', 'native-start', 'native-build', 'native-record', 'native-submit', 'ota-export', 'ota-publish']) assert.ok(jobs[name]);
  assert.ok(!JSON.stringify(workflow).includes('workflow_run'));
});

test('reservation precedes every build and external operation', () => {
  for (const name of ['server-build','native-start','ota-export']) assert.ok(needs(name).includes('reserve'));
  assert.ok(needs('reserve').includes('prepare'));
  assert.ok(needs('server-publish').includes('server-build'));
  assert.ok(needs('server-deploy').includes('server-publish'));
  assert.ok(needs('native-build').includes('native-start'));
  assert.ok(needs('native-start').includes('server-deploy'));
  assert.match(jobs['native-start'].if, /server != 'true'.*server-deploy.result == 'success'/);
});

test('submission waits for native evidence and selected server deployment', () => {
  assert.ok(needs('native-submit').includes('native-record'));
  assert.ok(needs('native-submit').includes('server-deploy'));
  assert.match(jobs['native-submit'].if, /server != 'true'.*server-deploy.result == 'success'/);
  assert.match(jobs['native-submit'].environment, /submit_environment/);
});

test('OTA waits for compatible build evidence, not store submission completion', () => {
  assert.ok(needs('ota-publish').includes('native-record'));
  assert.ok(!needs('ota-publish').includes('native-submit'));
  assert.ok(needs('ota-publish').includes('server-deploy'));
  assert.match(jobs['ota-publish'].if, /native != 'true'.*native-record.result == 'success'/);
  assert.match(jobs['ota-publish'].if, /server != 'true'.*server-deploy.result == 'success'/);
});

test('partial matrix failures still record completed native builds', () => {
  assert.equal(jobs['native-build'].strategy['fail-fast'], false);
  assert.match(jobs['native-record'].if, /always\(\).*native-start.result == 'success'/);
  assert.ok(jobs['native-record'].steps.some(step => step.with?.['merge-multiple'] === true));
});

test('source validation, Docker production and OTA export have no publication credentials', () => {
  for (const name of ['prepare','server-build','ota-export']) {
    const text = JSON.stringify(jobs[name]);
    assert.ok(!text.includes('secrets.')); assert.ok(!text.includes('github.token'));
    assert.ok(!text.includes('write')); assert.ok(!text.includes('EXPO_TOKEN'));
  }
});

test('separate native steps scope signing and cloud authentication', () => {
  const steps = jobs['native-build'].steps;
  const native = steps.find(step => step.run?.endsWith('native-command'));
  const cloud = steps.find(step => step.run?.endsWith('native-cloud'));
  assert.deepEqual(Object.keys(native.env).sort(), ['ANDROID_KEYSTORE_BASE64','ANDROID_STORE_PASSWORD','ANDROID_KEY_ALIAS','ANDROID_KEY_PASSWORD'].sort());
  assert.deepEqual(Object.keys(cloud.env), ['EXPO_TOKEN']);
  assert.ok(steps.findIndex(step => step.run?.includes('android-tools')) < steps.indexOf(native));
  assert.ok(jobs['native-build'].environment);
});

test('publishers do not install or execute application dependencies', () => {
  for (const name of ['server-publish','server-deploy','native-record','native-submit','ota-publish']) {
    assert.ok(!jobs[name].steps.some(step => step.run?.includes('worker.mjs install')));
    assert.ok(jobs[name].steps.some(step => step.uses?.includes('download-artifact')) || name === 'server-deploy');
  }
  for (const name of ['server-publish','server-deploy','native-submit','ota-publish']) assert.ok(jobs[name].environment);
});

test('all artifacts are current-run downloads without arbitrary run or repository inputs', () => {
  for (const job of Object.values(jobs)) for (const step of job.steps) if (step.uses?.includes('download-artifact')) {
    for (const key of ['run-id','repository','github-token']) assert.equal(step.with?.[key], undefined);
  }
});

test('upstream setup uses a full action SHA and a pinned EAS version before credentials', () => {
  const step = setup.runs.steps.find(step => step.uses?.startsWith('expo/expo-github-action@'));
  assert.match(step.uses, /@[a-f0-9]{40}$/); assert.equal(step.with['eas-version'], '25.3.0'); assert.equal(step.with.token, undefined);
  assert.ok(setup.runs.steps.some(step => step.run?.includes('npm ci --prefix .toolkit --ignore-scripts')));
  assert.ok(!fs.existsSync(new URL('../toolchain/package-lock.json', import.meta.url)));
});
