/** @file One consumer command surface; protected mutations always dispatch the trusted hosted request workflow. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { invariant, verifyPlan, hashIdentity } from '../packages/release-engine/index.mjs';
import { readConfig, readPointer, repositoryPath } from './config.mjs';
import { sourceGit, inspectSource, verifyToolkitPins } from './source.mjs';
import { runHook } from './hooks.mjs';
import { planRelease } from './planner.mjs';
import { GitHubLedger } from './ledger.mjs';
import { buildLocally } from './local-build.mjs';
import { githubClient } from './github.mjs';
import { legacyReaders } from './compat/index.mjs';
import { readReleaseEnvironment, resolveConfigurationValue, resolveExpoConfiguration } from './environment.mjs';
import { hydrateBaselines } from './compat/imports.mjs';
import { recoveryStatus } from './stages.mjs';
import { inspectRecovery } from './recovery.mjs';
import { verifyLocalBuild, localSubmissionPlan, submitLocally } from './local-submit.mjs';
import { retainedOperationRequest } from './retained-operations.mjs';

/** Parse bounded explicit options without shell interpolation or permissive duplicate flags. */
export function parseArguments(args) {
  const [command = 'help', ...rest] = args;
  invariant(['help', 'validate', 'plan', 'run', 'status', 'recover'].includes(command), 'Expected validate, plan, run, status, or recover.');
  const options = {};
  const flags = new Set(['source', 'offline', 'local', 'resume', 'retry', 'abandon', 'complete']);
  const values = new Set(['config', 'profile', 'bump', 'operation', 'targets', 'release-id', 'plan', 'baseline', 'output', 'reconcile', 'credentials-file', 'stage', 'reason', 'receipt', 'service-account-file', 'promotion']);
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index].replace(/^--/, '');
    invariant(rest[index].startsWith('--') && !Object.hasOwn(options, key), 'Invalid or duplicated command option.');
    if (flags.has(key)) options[key] = true;
    else {
      invariant(values.has(key) && rest[index + 1] && !rest[index + 1].startsWith('--'), `Unknown or incomplete option ${rest[index]}.`);
      options[key] = rest[++index];
    }
  }
  const permitted = { help: [], validate: ['config', 'profile', 'source'],
    plan: ['config', 'profile', 'offline', 'bump', 'operation', 'targets', 'release-id', 'baseline', 'output', 'receipt', 'promotion'],
    status: ['config', 'release-id'], recover: ['config', 'release-id', 'resume', 'retry', 'abandon', 'reconcile', 'complete', 'stage', 'reason', 'local', 'receipt', 'service-account-file'],
    run: ['config', 'plan', 'local', 'credentials-file', 'receipt', 'service-account-file'] };
  invariant(Object.keys(options).every(key => permitted[command].includes(key)), `Unsupported option for ${command}.`);
  if (options.targets) invariant(options.targets.split(',').every(value => /^[A-Za-z0-9][\w.:-]{0,191}$/.test(value))
    && new Set(options.targets.split(',')).size === options.targets.split(',').length, 'Targets must be unique configured identifiers.');
  return { command, options };
}

/** Validate configured mirrors without invoking application validation recursively. */
export function validateMirrors(config, root) {
  const json = mapping => readPointer(JSON.parse(fs.readFileSync(repositoryPath(root, mapping.file), 'utf8')), mapping.pointer);
  for (const group of config.versionGroups ?? []) {
    const mapping = group.version ?? config.components.find(component => group.targets.includes(component.id))?.version;
    if (!mapping) continue;
    const expected = json(mapping);
    invariant(/^\d+\.\d+\.\d+$/.test(expected), `Invalid version in ${mapping.file}.`);
    for (const mirror of mapping.mirrors ?? []) invariant(json(mirror) === expected, `Version mirror differs in ${mirror.file}.`);
    for (const component of config.components.filter(value => group.targets.includes(value.id))) {
      if (component.version) invariant(json(component.version) === expected, `Version group differs for ${component.id}.`);
      if (component.version?.codePointer) {
        const code = Number(json({ ...component.version, pointer: component.version.codePointer }));
        invariant(Number.isSafeInteger(code) && code > 0, `Invalid native code for ${component.id}.`);
        const lane = group.lanes?.[component.id];
        if (lane) invariant(code % lane.modulus === lane.residue, `Native code is outside ${component.id}'s reserved lane.`);
      }
    }
  }
  return true;
}

/** Read CLI authentication without exposing it in command arguments, output, plans, or source-hook environments. */
function cliToken(environment) {
  if (environment.GITHUB_TOKEN || environment.GH_TOKEN) return environment.GITHUB_TOKEN || environment.GH_TOKEN;
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
  catch { throw new Error('Authenticate GitHub CLI or set GH_TOKEN to inspect and dispatch releases.'); }
}

/** Keep status/inspection pure and require named recovery actions before dispatching any mutation. */
export async function main(args = process.argv.slice(2), { root = process.cwd(), environment = process.env, api: suppliedApi, providers = {},
  readers = legacyReaders, output = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`) } = {}) {
  const { command, options } = parseArguments(args);
  if (command === 'help') {
    output({ commands: ['validate [--source]', 'plan [--operation release|build|submit|ota|deploy|promote] [--targets id,id]',
      'plan --operation submit --receipt .release/artifacts-DIGEST.json',
      'run [--plan .release/plan.json] [--local] [--receipt FILE]', 'status [--release-id ID]', 'recover --release-id ID [--resume|--retry --stage ID|--abandon --reason TEXT|--reconcile FILE|--complete]'] });
    return;
  }
  const config = readConfig(root, options.config ?? 'release.config.json');
  const api = () => suppliedApi ?? githubClient({ repository: config.repository, token: cliToken(environment) });
  const ledger = () => new GitHubLedger({ config, api: api(), legacyReaders: readers });
  const profile = options.profile ?? config.defaultProfile ?? '';
  if (command === 'validate') {
    validateMirrors(config, root);
    const toolkitCommit = verifyToolkitPins(root);
    if (options.source) runHook(config, 'validate', { profile, environment: config.validation?.environment ?? {} }, { root });
    output({ valid: true, toolkitCommit, sourceValidated: Boolean(options.source) });
    return;
  }
  if (command === 'status' || command === 'recover') {
    const store = ledger();
    if (!options['release-id']) {
      invariant(command === 'status', 'Recovery requires --release-id.');
      output((await store.list()).map(({ id, tag_name, draft, html_url }) => ({ id, tag: tag_name, pending: draft, url: html_url })));
      return;
    }
    const state = await store.read(options['release-id']);
    const actions = ['resume', 'retry', 'abandon', 'reconcile', 'complete'].filter(key => options[key]);
    invariant(actions.length <= 1, 'Choose one explicit recovery action.');
    if (command === 'status' || actions.length === 0) {
      invariant(!options.stage && !options.reason, 'Stage and reason require an explicit recovery action.');
      output({ ...await inspectRecovery({ ledger: store, releaseId: state.release.id }), id: state.release.id, pending: state.release.draft });
      return;
    }
    invariant(state.release.draft, 'Only unfinished releases may be recovered.');
    const action = actions[0];
    if (state.local) {
      invariant(options.local && options.receipt && ['resume', 'abandon'].includes(action), 'Local recovery requires --local --receipt and --resume or --abandon.');
      output(await submitLocally({ config, root, api: api(), receiptFile: path.resolve(root, options.receipt), releaseId: state.release.id,
        action, reason: options.reason, environment, serviceAccountFile: options['service-account-file'] }));
      return;
    }
    invariant(!options.local && !options.receipt && !options['service-account-file'], 'Hosted recovery cannot accept local evidence or credentials.');
    invariant(action !== 'retry' || options.stage, 'Retry requires --stage for one provider operation.');
    invariant(action !== 'abandon' || options.reason?.trim().length >= 20, 'Abandonment requires --reason with at least 20 characters.');
    const reconciliation = options.reconcile ? JSON.parse(fs.readFileSync(path.resolve(root, options.reconcile), 'utf8')) : null;
    const request = { schemaVersion: 1, action, releaseId: String(state.release.id),
      planDigest: state.legacy ? hashIdentity(state.legacyPlan) : state.plan.digest,
      ...(options.stage ? { stage: options.stage } : {}), ...(options.reason ? { reason: options.reason } : {}),
      ...(reconciliation ? { reconciliation } : {}) };
    await api()(`/actions/workflows/${encodeURIComponent(config.github.recoveryWorkflow)}/dispatches`, {
      method: 'POST', body: { ref: config.defaultBranch, inputs: { request: JSON.stringify(request) } } });
    output({ dispatched: true, action, releaseId: state.release.id });
    return;
  }
  if (command === 'plan') {
    const operation = options.operation ?? 'release';
    invariant(!options.promotion || operation === 'promote', '--promotion applies only to a native promotion.');
    let plan;
    invariant(!options.receipt || operation === 'submit' && !options['release-id'] && !options.targets && !options.profile,
      '--receipt plans submit exactly the retained local build; omit target, profile and hosted release selectors.');
    if (options.receipt) {
      plan = localSubmissionPlan(await verifyLocalBuild(path.resolve(root, options.receipt)), config);
    } else if (['submit', 'deploy', 'promote'].includes(operation)) {
      invariant(options['release-id'], `${operation} plans require --release-id for verified retained inputs.`);
      const state = await ledger().read(options['release-id']);
      plan = retainedOperationRequest({ state, config, operation, targets: options.targets?.split(',') ?? [], promotion: options.promotion });
    } else {
      invariant(['release', 'build', 'ota'].includes(operation), 'Unsupported plan operation.');
      invariant(!options.baseline || options.offline, '--baseline is available only for explicit offline fixture inspection.');
      validateMirrors(config, root);
      const toolkitCommit = verifyToolkitPins(root);
      invariant(!sourceGit(root, ['status', '--porcelain', '--untracked-files=no']), 'Plan from a clean committed source.');
      const source = { repository: config.repository, commit: sourceGit(root, ['rev-parse', 'HEAD']), toolkitCommit, origin: 'local' };
      let baseline;
      if (options.offline) {
        invariant(options.baseline, '--offline requires an explicit --baseline fixture; it cannot infer a first release.');
        baseline = JSON.parse(fs.readFileSync(path.resolve(root, options.baseline), 'utf8'));
      } else if (operation === 'build' && config.profiles?.[profile]?.execution === 'local') {
        // A local build allocates no versions and does not alter or resume a held hosted release.
        baseline = { components: {}, runtimes: {}, reservations: {} };
      } else baseline = await ledger().baseline();
      const targets = options.targets?.split(',') ?? [];
      const inputs = options.offline ? { expo: resolveExpoConfiguration(config, root, profile), environment: config.inspection?.environment ?? {},
        hash: hashIdentity(Object.entries(config.inspection?.environment ?? {}).sort(([a], [b]) => a.localeCompare(b))), components: {} }
        : await readReleaseEnvironment(config, { root, profile, targets, deferProtected: true, transport: providers.eas });
      const providerConfiguration = { expo: inputs.expo, destinations: Object.fromEntries(config.components.filter(value => value.submission)
        .map(value => [value.id, resolveConfigurationValue(value.submission, root)])) };
      if (!options.offline && config.profiles?.[profile]?.execution !== 'local') baseline = await hydrateBaselines({ config, baseline, root, source, api: api(), profile,
        providers: { ...providers, expo: inputs.expo } });
      const observations = inspectSource(config, { root, source, profile, baseline, environment: inputs.environment,
        environmentHash: inputs.hash, componentEnvironments: inputs.components }).map(observation => {
        const resolved = inputs.components[observation.id];
        return { ...observation, environment: resolved?.environment ?? inputs.environment,
          ...(resolved?.deferred ? { environmentHash: null, environmentDeferred: true } : {}) };
      });
      plan = planRelease({ config, source, origin: { kind: 'local' }, observations, baseline, profile, operation,
        bump: options.bump ?? 'patch', targets, providerConfiguration });
    }
    const file = repositoryPath(root, options.output ?? '.release/plan.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`);
    output({ file, plan });
    return;
  }
  const plan = JSON.parse(fs.readFileSync(path.resolve(root, options.plan ?? '.release/plan.json'), 'utf8'));
  if (plan.kind === 'expo-release-operation') {
    invariant(!options.local && !options.receipt && !options['credentials-file'] && !options['service-account-file'], 'Retained publication operations run through protected Actions.');
    const expected = retainedOperationRequest({ state: await ledger().read(plan.releaseId), config, operation: plan.operation, targets: plan.targets, promotion: plan.promotion });
    invariant(hashIdentity(expected) === hashIdentity(plan), 'Retained operation changed after planning.');
    verifyToolkitPins(root);
    await api()(`/actions/workflows/${encodeURIComponent(config.github.requestWorkflow)}/dispatches`, {
      method: 'POST', body: { ref: config.defaultBranch, inputs: { request: JSON.stringify({ schemaVersion: 1, action: 'operation', retained: plan }) } } });
    output({ dispatched: true, operation: plan.operation, releaseId: plan.releaseId });
    return;
  }
  verifyPlan(plan, { repository: config.repository, ...(plan.localBuild ? {} : { commit: sourceGit(root, ['rev-parse', 'HEAD']) }), toolkitCommit: verifyToolkitPins(root) });
  invariant(hashIdentity(plan.config) === hashIdentity(config), 'Configuration changed after planning.');
  if (plan.localBuild) {
    invariant(options.local && options.receipt && !options['credentials-file'], 'Local submission requires run --local --receipt FILE.');
    const build = await verifyLocalBuild(path.resolve(root, options.receipt));
    invariant(localSubmissionPlan(build, config).digest === plan.digest, 'Retained local build differs from the prepared submission.');
    output(await submitLocally({ config, root, api: api(), receiptFile: path.resolve(root, options.receipt),
      environment, serviceAccountFile: options['service-account-file'] }));
    return;
  }
  invariant(!options.receipt && !options['service-account-file'], 'Local submission options require a local submission plan.');
  if (options.local) {
    output(await buildLocally({ plan, root, environment, credentialsFile: options['credentials-file'] }));
    return;
  }
  invariant(!options['credentials-file'], '--credentials-file is supported only for a local build.');
  invariant(config.profiles?.[plan.profile]?.execution !== 'local', 'This profile runs locally; use run --local.');
  const request = { schemaVersion: 1, action: 'release', source: plan.source.commit, toolkitCommit: plan.source.toolkitCommit,
    configuration: hashIdentity(config), profile: plan.profile, operation: plan.operation, bump: plan.bump, targets: plan.selection.selected };
  await api()(`/actions/workflows/${encodeURIComponent(config.github.requestWorkflow)}/dispatches`, {
    method: 'POST', body: { ref: config.defaultBranch, inputs: { request: JSON.stringify(request) } } });
  output({ dispatched: true, source: plan.source.commit, operation: plan.operation, workflow: config.github.requestWorkflow });
}
