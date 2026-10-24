/** @file Fixed GitHub job entrypoints; the workflow, not a dynamic stage engine, defines execution order. */
import fs from 'node:fs';
import path from 'node:path';
import { assert } from './engine.mjs';
import { loadConfig, verifyPins, verifyPlan } from './config.mjs';
import { git, run, readJson, writeJson, sourceEnvironment, seal, verify, hash } from './io.mjs';
import { prepare, hook, exportBundle } from './source.mjs';
import { github, loadHistory, reserve, begin, complete } from './github.mjs';
import { eas, publisher, readEnvironments, verifyBuildFloors, cloudBuild, verifyBuild, submit, update } from './eas.mjs';
import { buildServer, commandBuild } from './build.mjs';
import { connectAndDeploy } from './deploy.mjs';

/** Write one fixed workflow output without allowing multiline workflow-command injection. */
export function output(key, value) {
  const text = typeof value === 'object' ? JSON.stringify(value) : String(value ?? '');
  assert(!/[\r\n]/.test(text), 'Invalid workflow output.');
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `${key}=${text}\n`);
}

/** Require an immutable default-branch workflow invocation before accepting any publishing context. */
export function hostedIdentity(config, env = process.env) {
  assert(env.GITHUB_EVENT_NAME === 'workflow_dispatch' && env.GITHUB_REF === `refs/heads/${config.defaultBranch}`
    && env.GITHUB_REPOSITORY === config.repository && /^[a-f0-9]{40}$/.test(env.GITHUB_SHA ?? '')
    && /^[a-f0-9]{40}$/.test(env.TOOLKIT_SHA ?? '') && /^\d+$/.test(env.GITHUB_RUN_ID ?? '') && env.GITHUB_RUN_ATTEMPT === '1',
    'Release requires a fresh default-branch dispatch; job retries and other events cannot publish.');
  return { repository: config.repository, source: env.GITHUB_SHA, toolkit: env.TOOLKIT_SHA, run: env.GITHUB_RUN_ID };
}

/** Execute a single internal workflow phase with an explicit checkout and artifact directory. */
export async function worker(phase, root, state) {
  const config = loadConfig(root), identity = hostedIdentity(config);
  const client = github(config.repository), contextFile = path.join(state, 'context.json'), planFile = path.join(state, 'plan.json');
  const profile = process.env.RELEASE_PROFILE, targetId = process.env.RELEASE_TARGET;
  const artifacts = path.resolve('artifacts');
  if (phase === 'context') {
    verifyPins(root, identity.toolkit);
    assert(config.profiles[profile], 'Unknown profile.');
    const selected = config.profiles[profile];
    writeJson(contextFile, { ...identity, history: await loadHistory(client), config });
    for (const [key, value] of Object.entries({ mobile: !!config.mobile, approval: selected.approvalEnvironment,
      signing: selected.signingEnvironment || selected.approvalEnvironment, submit_environment: selected.submitEnvironment || selected.approvalEnvironment,
      deploy_environment: selected.deployEnvironment, builder: config.mobile?.builder ?? 'eas' })) output(key, value);
    return;
  }
  if (phase === 'environment') {
    verifyBuildFloors(config);
    const context = readJson(contextFile); context.environments = readEnvironments(config); writeJson(contextFile, context); return;
  }
  if (phase === 'install') {
    for (const command of config.install) run(command[0], command.slice(1), { cwd: root, env: sourceEnvironment(), stdio: 'inherit' });
    return;
  }
  if (phase === 'prepare') {
    const plan = prepare(root, config, readJson(contextFile), profile, process.env.RELEASE_REBUILD === 'true');
    if (!plan.noop) {
      if (config.mobile) {
        const easConfig = readJson(path.join(root, config.mobile.directory, 'eas.json'));
        const buildProfile = easConfig.build[config.profiles[profile].easProfile];
        assert(buildProfile?.channel === config.profiles[profile].channel && buildProfile.environment === config.profiles[profile].environment,
          'EAS build profile channel/environment differs from release configuration.');
        assert(Object.entries(buildProfile.env ?? {}).every(([key, value]) => plan.environments[profile][key] === value),
          'EAS profile env values must be declared in the same public source environment.');
        if (config.mobile.builder !== 'command') assert(easConfig.cli?.appVersionSource === 'remote' && buildProfile.autoIncrement === true,
          'Ordinary EAS builds require remote managed counters with autoIncrement enabled.');
        plan.submitProfiles = easConfig.submit ?? {};
        if (plan.native && config.profiles[profile].submit) for (const target of config.mobile.targets) {
          const destination = plan.submitProfiles[target.submitProfile ?? config.profiles[profile].easProfile]?.[target.platform];
          assert(destination && (target.platform === 'android' ? destination.track : destination.ascAppId), 'Configure each exact EAS submission destination before release.');
        }
      }
      git(root, ['update-ref', 'refs/heads/expo-release-build', plan.build]);
      git(root, ['bundle', 'create', path.resolve(state, 'build.bundle'), 'refs/heads/expo-release-build', `^${plan.source}`]);
    }
    writeJson(planFile, plan);
    const nativeMatrix = !plan.native ? [] : config.mobile.builder === 'command' ? [{ id: 'pair', platform: 'android' }] : config.mobile.targets;
    for (const [key, value] of Object.entries({ noop: plan.noop, server: plan.server, native: plan.native, ota: plan.ota,
      native_matrix: nativeMatrix, build: plan.build, submit: plan.native && config.profiles[profile].submit === true })) output(key, value);
    return;
  }
  const plan = readJson(planFile);
  verifyPlan(plan, config, identity);
  const selected = config.profiles[plan.profile], target = config.mobile?.targets.find(t => t.id === targetId);
  if (phase === 'reserve') {
    git(root, ['fetch', path.resolve(state, 'build.bundle'), 'refs/heads/expo-release-build']);
    assert(git(root, ['rev-parse', `${plan.build}^`]) === plan.source, 'Build commit has an unexpected parent.');
    assert(git(root, ['diff', '--name-only', plan.source, plan.build]).split(/\r?\n/).filter(Boolean).every(file => config.metadataFiles.includes(file)), 'Build commit changed non-metadata files.');
    const authorization = Buffer.from(`x-access-token:${process.env.GITHUB_TOKEN}`).toString('base64');
    run('git', ['push', `https://github.com/${config.repository}.git`, `${plan.build}:refs/tags/expo-release/v3/build/${plan.run}`],
      { cwd: root, env: { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${authorization}` } });
    await reserve(client, plan); return;
  }
  if (phase === 'native-start') {
    const intents = {};
    for (const value of config.mobile.targets) intents[value.id] = await begin(client, plan, `build/${value.id}`);
    writeJson(path.join(state, 'native-intents.json'), intents); return;
  }
  if (phase === 'native-prebuild') { hook(root, config, 'buildPrepare', { plan }, plan.environments[plan.profile]); return; }
  if (phase === 'native-command') { commandBuild(root, plan, artifacts); return; }
  if (phase === 'native-cloud') {
    assert(target, 'Unknown native target.');
    const result = await cloudBuild(root, plan, target);
    const directory = path.join(artifacts, target.id);
    writeJson(path.join(directory, 'build.json'), result); seal(directory, plan, target.id); return;
  }
  if (phase === 'native-record' || phase === 'native-submit') {
    const intents = readJson(path.join(state, 'native-intents.json'));
    for (const value of config.mobile.targets) {
      const directory = path.join(artifacts, value.id);
      if (phase === 'native-record' && !fs.existsSync(directory)) continue;
      verify(directory, plan, value.id);
      let result = config.mobile.builder === 'command' ? { artifact: 'native.aab', digest: hash(fs.readFileSync(path.join(directory, 'native.aab'))) } : null;
      if (config.mobile.builder !== 'command') {
        const saved = readJson(path.join(directory, 'build.json')), inert = publisher(config, plan.profile);
        try { result = verifyBuild(eas(['build:view', saved.id, '--json'], inert), plan, value); }
        finally { fs.rmSync(inert, { recursive: true, force: true }); }
      }
      if (phase === 'native-record') await complete(client, plan, `build/${value.id}`, intents[value.id], result);
      else {
        const id = await begin(client, plan, `submit/${value.id}`);
        const submission = submit(plan, value, config.mobile.builder === 'command' ? { file: path.join(directory, 'native.aab') } : { buildId: result.id }, plan.submitProfiles);
        await complete(client, plan, `submit/${value.id}`, id, submission);
      }
    }
    return;
  }
  if (phase === 'server-build') { await buildServer(root, plan, path.join(artifacts, 'server')); return; }
  if (phase === 'ota-export') { const directory = path.join(artifacts, `ota-${targetId}`); exportBundle(root, plan, targetId, directory); seal(directory, plan, `ota-${targetId}`); return; }
  const operation = phase === 'server-publish' ? 'publish/server' : phase === 'server-deploy' ? 'deploy/server' : phase === 'ota-publish' ? `ota/${targetId}` : null;
  assert(operation && plan.operations.includes(`${plan.profile}/${operation}`), 'Unknown or unselected release phase.');
  if (phase === 'server-publish') verify(path.join(artifacts, 'server'), plan, 'server');
  if (phase === 'ota-publish') verify(path.join(artifacts, `ota-${targetId}`), plan, `ota-${targetId}`);
  const id = await begin(client, plan, operation);
  let result;
  if (phase === 'server-publish') {
    const image = config.server.image, tag = `${image}:v${plan.versions.server}`, auth = path.join(osTemporary(), 'auth.json');
    try {
      run('skopeo', ['login', '--authfile', auth, '--username', process.env.GITHUB_ACTOR, '--password-stdin', 'ghcr.io'], { input: process.env.GHCR_TOKEN });
      run('skopeo', ['copy', '--all', '--authfile', auth, `oci-archive:${path.join(artifacts, 'server/image.tar')}`, `docker://${tag}`]);
      const digest = run('skopeo', ['inspect', '--authfile', auth, '--format', '{{.Digest}}', `docker://${tag}`]).trim();
      assert(/^sha256:[a-f0-9]{64}$/.test(digest), 'Registry returned no image digest.');
      for (const alias of [`sha-${plan.source}`, 'latest']) run('skopeo', ['copy', '--all', '--authfile', auth, `docker://${image}@${digest}`, `docker://${image}:${alias}`]);
      result = { image, digest, version: plan.versions.server };
    } finally { fs.rmSync(path.dirname(auth), { recursive: true, force: true }); }
  } else if (phase === 'server-deploy') result = connectAndDeploy(config.server.deployment);
  else result = update(plan, targetId, path.join(artifacts, `ota-${targetId}`));
  await complete(client, plan, operation, id, result);
}

/** Create a private directory for short-lived registry credentials. */
function osTemporary() { return fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || process.env.TEMP || '/tmp', 'release-auth-')); }
