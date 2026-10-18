/** @file Exercises installed-style CLI read-only planning, protected environment deferral, immutable pins and inspection without publication mutations. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { main, parseArguments } from '../src/cli.mjs';
import { hashIdentity } from '../packages/release-engine/index.mjs';
import { validateConfig } from '../src/config.mjs';

const revision = 'c'.repeat(40);
function fixture(t) {
  const root = fs.mkdtempSync(path.join(tmpdir(), 'release-cli-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (name, value) => { const file = path.join(root, name); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); };
  const config = { schemaVersion: 1, repository: 'fixture/app', defaultBranch: 'main', defaultProfile: 'production',
    expo: { projectId: '11111111-1111-4111-8111-111111111111', owner: 'fixture', slug: 'app' },
    profiles: { production: { easProfile: 'production', environment: 'production', channel: 'production', distribution: 'store', submit: false } },
    components: [{ id: 'android', kind: 'native', builder: 'eas', appDirectory: '.', platform: 'android', applicationId: 'app.fixture', runtimePolicy: 'appVersion',
      version: { file: 'metadata.json', pointer: '/version', codePointer: '/code' }, submission: { track: 'internal', releaseStatus: 'draft' } },
    { id: 'android.ota', kind: 'ota', nativeTarget: 'android', platform: 'android', appDirectory: '.', environment: 'preview', approvalEnvironment: 'internal-review' }],
    versionGroups: [{ id: 'native', targets: ['android'], version: { file: 'metadata.json', pointer: '/version', mirrors: [{ file: 'mirror.json', pointer: '/version' }] } }],
    hooks: { inspect: { command: ['node', 'hook.mjs'] }, validate: { command: ['node', 'hook.mjs'] } },
    github: { requestWorkflow: 'release-request.yml', handlerWorkflow: 'release-handler.yml', recoveryWorkflow: 'recover-release.yml' } };
  write('release.config.json', config); write('metadata.json', { version: '1.2.3', code: 7 }); write('mirror.json', { version: '1.2.3' });
  write('package.json', { name: 'fixture', type: 'module', devDependencies: { '@mchartier/expo-release': `git+https://github.com/MChartier/expo-release-template.git#${revision}` } });
  write('package-lock.json', { packages: { 'node_modules/@mchartier/expo-release': { resolved: `git+https://github.com/MChartier/expo-release-template.git#${revision}` } } });
  write('.github/workflows/release-handler.yml', `# Fixture shared caller.\njobs:\n  release:\n    uses: MChartier/expo-release-template/.github/workflows/release-handler.yml@${revision}\n`);
  write('hook.mjs', `/** @file Fixture hook observes provided public input metadata only. */\nimport fs from 'node:fs'; const request=JSON.parse(fs.readFileSync(0,'utf8'));
    if (request.action==='validate') console.log(JSON.stringify({schemaVersion:1,validated:true}));
    else console.log(JSON.stringify({schemaVersion:1,observations:request.config.components.map(component=>({id:component.id,identity:component.id+'-input',
      runtime:'1.2.3',version:'1.2.3',versionCode:7,fingerprint:'d'.repeat(40),environmentHash:request.componentEnvironments?.[component.id]?.hash ?? request.environmentHash,
      sawCredential:Boolean(process.env.EXPO_TOKEN||process.env.GITHUB_TOKEN||process.env.GH_TOKEN)}))}));`);
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim();
  git(['init', '--quiet']); git(['add', '.']); git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture']);
  const output = []; const reads = []; const envReads = [];
  const api = async (route, options = {}) => { reads.push(route); assert.equal(options.method, undefined, 'read-only command attempted a mutation'); throw new Error(`unexpected route ${route}`); };
  api.pages = async route => { reads.push(route); assert.equal(route, '/releases'); return []; };
  const eas = { async project(value) { assert.equal(value.projectId, config.expo.projectId); }, async environment(projectId, environment) {
    envReads.push(environment); return []; } };
  return { root, write, config, git, output, reads, envReads, options: { root, environment: { GH_TOKEN: 'fixture-secret' }, api, providers: { eas }, output: value => output.push(value) } };
}

test('planning freezes provider destinations, preserves protected unknown inputs, and never dispatches a request', async t => {
  const { options, output, envReads, reads, root } = fixture(t);
  await main(['plan'], options);
  const plan = output[0].plan;
  assert.deepEqual(envReads, ['production']); assert.deepEqual(reads, ['/releases']);
  assert.equal(plan.origin.kind, 'local'); assert.equal(plan.source.workflowCommit, undefined);
  assert.deepEqual(plan.providerConfiguration.destinations.android, { track: 'internal', releaseStatus: 'draft' });
  const protectedTarget = plan.components.find(value => value.id === 'android.ota');
  assert.equal(protectedTarget.observation.environmentHash, null); assert.equal(protectedTarget.observation.environmentDeferred, true);
  assert.ok(plan.components.every(value => value.observation.sawCredential === false));
  assert.ok(!JSON.stringify(plan).includes('fixture-secret'));
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, '.release/plan.json'))).digest, plan.digest);
});

test('an explicitly protected target is planned without reading any EAS environment', async t => {
  const { options, envReads, output } = fixture(t);
  await main(['plan', '--operation', 'ota', '--targets', 'android.ota'], options);
  assert.deepEqual(envReads, []); assert.deepEqual(output[0].plan.selection.selected, ['android.ota']);
});

test('offline planning needs an explicit baseline and performs no provider or ledger reads', async t => {
  const { options, root, reads, envReads, output } = fixture(t);
  await assert.rejects(main(['plan', '--offline'], options), /explicit --baseline/);
  fs.writeFileSync(path.join(root, 'baseline.json'), '{}');
  await main(['plan', '--offline', '--baseline', 'baseline.json'], options);
  assert.deepEqual(reads, []); assert.deepEqual(envReads, []); assert.equal(output[0].plan.providerConfiguration.expo.projectId, '11111111-1111-4111-8111-111111111111');
  assert.equal(output[0].plan.components[0].observation.environmentHash, hashIdentity([]));
});

test('validate checks mirrored versions and exact package/workflow pins without provider access', async t => {
  const { options, write, reads, envReads, output } = fixture(t);
  await main(['validate', '--source'], options); assert.equal(output[0].valid, true);
  assert.deepEqual(reads, []); assert.deepEqual(envReads, []);
  write('mirror.json', { version: '9.9.9' }); await assert.rejects(main(['validate'], options), /mirror differs/);
  write('mirror.json', { version: '1.2.3' });
  write('.github/workflows/release-handler.yml', 'uses: MChartier/expo-release-template/.github/workflows/release-handler.yml@main');
  await assert.rejects(main(['validate'], options), /workflow pin differs/);
});

test('status and recovery inspection expose retained operations without requesting mutation', async t => {
  const value = fixture(t); const assets = [{ name: 'original.json', size: 12 }];
  const release = { id: 42, tag_name: 'legacy/42', draft: true, body: '{}' };
  const api = async (route, options = {}) => { assert.equal(options.method, undefined); assert.equal(route, '/releases/42'); return release; };
  api.pages = async route => { assert.equal(route, '/releases/42/assets'); return assets; };
  const readers = [{ matches: () => true, read: async () => ({ legacy: true, release, origin: { kind: 'original' },
    summary: { status: 'pending' }, inventory: assets, recovery: { providerIds: ['original-id'] } }) }];
  for (const command of ['status', 'recover']) await main([command, '--release-id', '42'], { ...value.options, api, readers });
  assert.ok(value.output.every(result => result.recovery.providerIds[0] === 'original-id' && result.pending));
});

test('command options reject duplicate, misplaced, incomplete and ambiguous target requests', () => {
  for (const args of [['status', '--resume'], ['plan', '--targets', 'android,android'], ['plan', '--targets', 'android,'],
    ['plan', '--profile'], ['validate', '--source', '--source'], ['status', '--local']]) assert.throws(() => parseArguments(args));
  assert.deepEqual(parseArguments(['plan', '--operation', 'ota', '--targets', 'android.ota']).options, { operation: 'ota', targets: 'android.ota' });
});

test('published schema and runtime validator keep explicit runtime policy modes consistent', t => {
  const { config } = fixture(t);
  const schema = JSON.parse(fs.readFileSync(new URL('../schemas/release.config.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(schema.definitions.component.properties.runtimeBinding.enum, ['native', 'source']);
  assert.deepEqual(schema.definitions.component.properties.runtimeCompatibility.enum, ['exact', 'fingerprint']);
  assert.throws(() => validateConfig({ ...config, components: config.components.map(value => value.kind === 'native' ? { ...value, runtimeCompatibility: 'fingerprint' } : value) }), /requires fingerprint runtime/);
  assert.throws(() => validateConfig({ ...config, components: config.components.map(value => value.kind === 'ota' ? { ...value, runtimeBinding: 'source' } : value) }), /requires fingerprint native/);
  assert.throws(() => validateConfig({ ...config, components: config.components.map(value => value.kind === 'ota' ? { ...value, runtimeBinding: 'invented' } : value) }), /binding policy/);
  const supported = { ...config, components: config.components.map(value => value.kind === 'native' ? { ...value, runtimePolicy: 'fingerprint' } : { ...value, runtimeBinding: 'source' }) };
  assert.equal(validateConfig(supported), supported);
});
