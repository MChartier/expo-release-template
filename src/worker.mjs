/** @file Shared workflow commands with separate source-only and source-free publication phases. */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { invariant, hashIdentity, verifyPlan, summarizeRelease } from '../packages/release-engine/index.mjs';
import { githubClient, verifyProducer } from './github.mjs';
import { GitHubLedger } from './ledger.mjs';
import { legacyReaders } from './compat/index.mjs';
import { authorizeRequest, validateRequest, repositoryJson } from './trusted.mjs';
import { readReleaseEnvironment, resolveConfigurationValue } from './environment.mjs';
import { inspectSource, prepareSource, sourceGit, verifyToolkitPins } from './source.mjs';
import { planRelease, finalizePlan, bindMergedPlan } from './planner.mjs';
import { runHook, sourceEnvironment } from './hooks.mjs';
import { repositoryPath } from './config.mjs';
import { publishCandidate, finalizeCandidate, validateCandidateBundle, verifyCandidateChecks, requireCurrentSource } from './candidate.mjs';
import { recoverRelease } from './recovery.mjs';
import { recoveryProvider, recoveryTarget } from './recovery-providers.mjs';
import { buildServer } from './build.mjs';
import { smokeImage } from './image-smoke.mjs';
import { hydrateBaselines } from './compat/imports.mjs';
import { routeLegacyRecovery, executeLegacyRecovery } from './compat/recovery-worker.mjs';
import { prepareRetainedOperation, routeRetainedOperation, executeRetainedOperation } from './retained-operations.mjs';
import { prepareCalibrateOta, calibrateOtaLedger } from './compat/calibrate-ota.mjs';

/** Export single-line JSON/scalars without evaluating any source-provided shell syntax. */
export function workflowOutputs(values, environment = process.env) {
  if (!environment.GITHUB_OUTPUT) return;
  for (const [key, value] of Object.entries(values)) {
    const text = typeof value === 'object' ? JSON.stringify(value) : String(value);
    invariant(/^[a-z][a-z_]*$/.test(key) && !/[\r\n]/.test(text), 'Unsafe workflow output.');
    fs.appendFileSync(environment.GITHUB_OUTPUT, `${key}=${text}\n`);
  }
}

/** Derive fixed supported phase matrices from the canonical plan; callers cannot provide a second graph. */
export function phaseMatrices(plan, remaining = Object.keys(plan.stages)) {
  verifyPlan(plan);
  const active = plan.components.filter(component => component.selected);
  const natives = active.filter(component => component.kind === 'native');
  const pending = (component, actions) => actions.some(action => remaining.includes(`${component.id}:${action}`));
  const groups = new Map();
  for (const target of natives.filter(value => natives.some(other => (other.buildGroup ?? other.id) === (value.buildGroup ?? value.id) && pending(other, ['build'])))) {
    const group = target.buildGroup ?? target.id;
    if (!groups.has(group)) groups.set(group, { id: group, target: target.id, targets: [], builder: target.builder, approval: target.signingEnvironment ?? '' });
    const entry = groups.get(group);
    invariant(entry.builder === target.builder && entry.approval === (target.signingEnvironment ?? ''), 'Build group has conflicting builders or signing environments.');
    entry.targets.push(target.id);
  }
  const row = component => ({ target: component.id, approval: component.approvalEnvironment ?? '' });
  const first = component => !(component.after ?? []).some(id => active.some(value => value.id === id));
  const second = component => !first(component);
  for (const component of active) for (const previous of component.after ?? []) {
    const predecessor = active.find(value => value.id === previous);
    invariant(!predecessor || first(predecessor), 'Supported target ordering has at most two publication waves.');
  }
  return {
    server: active.filter(component => component.kind === 'server' && pending(component, ['build', 'publish'])).map(row),
    server_publish: active.filter(component => component.kind === 'server' && pending(component, ['publish'])).map(row),
    server_finalize: active.filter(component => component.kind === 'server' && component.publication && pending(component, ['finalize'])).map(row), native_builds: [...groups.values()],
    native_first: natives.filter(first).filter(component => component.submit !== false && pending(component, ['handoff', 'submit'])).map(row),
    native_second: natives.filter(second).filter(component => component.submit !== false && pending(component, ['handoff', 'submit'])).map(row),
    ota_first: active.filter(component => component.kind === 'ota' && first(component) && pending(component, ['export', 'publish'])).map(row),
    ota_second: active.filter(component => component.kind === 'ota' && second(component) && pending(component, ['export', 'publish'])).map(row),
    deployment: Object.entries(plan.stages).find(([id, spec]) => spec.action === 'deploy' && remaining.includes(id))?.[1].target ?? '',
    deployment_approval: plan.config.deployment?.environment ?? ''
  };
}

/** Retained operations use two fixed submission waves or independent provider stages, never a consumer-supplied workflow graph. */
export function operationMatrices(plan, remaining = Object.keys(plan.stages)) {
  verifyPlan(plan);
  const row = stage => {
    const route = routeRetainedOperation(plan, stage.id);
    return { ...route, access_token_secret: route.credentials?.accessToken ?? '', service_account_secret: route.credentials?.serviceAccountBase64 ?? '' };
  };
  const first = plan.graph.stages.filter(stage => stage.needs.length === 0);
  const second = plan.graph.stages.filter(stage => stage.needs.length > 0);
  invariant(second.every(stage => stage.needs.every(id => first.some(value => value.id === id))), 'Retained submissions support at most two configured waves.');
  return { first: first.filter(stage => remaining.includes(stage.id)).map(row), second: second.filter(stage => remaining.includes(stage.id)).map(row) };
}

/** Reuse the immutable authority of an earlier attempt in this run, without adopting another run's plan. */
export function verifyRunReservation(state, authorized, origin) {
  const plan = state.reservation ?? state.plan;
  verifyPlan(plan);
  invariant(!state.local && !state.legacy && String(plan.origin.runId) === String(origin.runId)
    && plan.origin.kind === 'github' && plan.origin.runAttempt <= origin.runAttempt
    && plan.source.workflowCommit === authorized.source.workflowCommit && plan.source.toolkitCommit === authorized.source.toolkitCommit
    && hashIdentity(plan.config) === hashIdentity(authorized.config), 'Rerun changed the original run or trusted configuration.');
  if (authorized.request.action === 'operation') invariant(hashIdentity(plan.retainedOperation) === hashIdentity(authorized.request.retained)
    && plan.source.commit === authorized.request.retained.original.source, 'Rerun changed its sealed retained operation.');
  else invariant(!plan.retainedOperation && plan.source.commit === authorized.source.commit && plan.profile === authorized.request.profile
    && plan.operation === authorized.request.operation && (plan.bump ?? 'patch') === (authorized.request.bump ?? 'patch')
    && hashIdentity([...(plan.targets ?? [])].sort()) === hashIdentity([...(authorized.request.targets ?? [])].sort()),
  'Rerun changed its original release selection.');
  return plan;
}

/** Install application dependencies only on a source runner with no publication credentials or workflow command-file capabilities. */
export function installSource(config, root) {
  for (const directory of config.packageDirectories ?? ['.']) {
    const cwd = directory === '.' ? root : repositoryPath(root, directory);
    const npmCli = process.env.npm_execpath;
    const command = npmCli ? process.execPath : process.platform === 'win32' ? 'npm.cmd' : 'npm';
    const args = [...(npmCli ? [npmCli] : []), 'ci', '--no-audit', '--no-fund'];
    execFileSync(command, args, { cwd, env: sourceEnvironment(), windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'] });
  }
}

/** Perform one workflow phase; only commands that need repository writes instantiate a writing ledger. */
export async function mainWorker(args = process.argv.slice(2), environment = process.env) {
  const [command] = args;
  const stateRoot = path.resolve(environment.RELEASE_STATE ?? '.release-state');
  const appRoot = path.resolve(environment.RELEASE_SOURCE ?? '.app');
  fs.mkdirSync(stateRoot, { recursive: true });
  const read = file => JSON.parse(fs.readFileSync(repositoryPath(stateRoot, file), 'utf8'));
  const write = (file, value) => fs.writeFileSync(repositoryPath(stateRoot, file), `${JSON.stringify(value, null, 2)}\n`);
  const repository = environment.GITHUB_REPOSITORY;
  const origin = { kind: 'github', runId: environment.GITHUB_RUN_ID, runAttempt: Number(environment.GITHUB_RUN_ATTEMPT) };
  const api = () => githubClient({ repository, token: environment.GITHUB_TOKEN });
  const ledger = config => new GitHubLedger({ config, api: api(), origin, workflowCommit: environment.CONSUMER_WORKFLOW_COMMIT, legacyReaders });
  if (command === 'request') {
    write('request.json', validateRequest(JSON.parse(environment.RELEASE_REQUEST || '{"schemaVersion":1,"action":"release"}')));
    return;
  }
  if (command === 'gateway' || command === 'authorize') {
    const result = await authorizeRequest({ api: api(), event: JSON.parse(fs.readFileSync(environment.GITHUB_EVENT_PATH, 'utf8')),
      repository, consumerWorkflow: environment.CONSUMER_WORKFLOW_COMMIT, toolkitCommit: environment.TOOLKIT_COMMIT,
      ...(command === 'authorize' ? { request: read('request.json') } : {}) });
    workflowOutputs({ artifact_id: result.artifactId, request_run_id: result.requestRunId });
    if (command === 'authorize') {
      let authorization = { ...result, origin };
      workflowOutputs({ source: result.source.commit, action: result.request.action, release_id: result.request.releaseId ?? '', state_attempt: origin.runAttempt });
      if (result.request.action === 'release') {
        const store = ledger(result.config);
        const reserved = (await store.list()).find(value => value.tag_name === `expo-release-${origin.runId}`);
        if (reserved) {
          const retained = verifyRunReservation(await store.read(reserved.id), authorization, origin);
          authorization = { ...authorization, origin: retained.origin };
          write('baseline.json', retained.baseline);
        } else write('baseline.json', await store.baseline());
      }
      write('authorized.json', authorization);
    }
    return;
  }
  if (command === 'environment') {
    const authorized = read('authorized.json');
    // Resolve only explicitly referenced JSON documents; no consumer configuration is executed here.
    const files = new Set();
    const collect = value => { if (!value || typeof value !== 'object') return;
      if (typeof value.file === 'string' && typeof value.pointer === 'string') files.add(value.file);
      else Object.values(value).forEach(collect); };
    collect(authorized.config.expo); collect(authorized.config.components.map(value => value.submission));
    for (const file of files) {
      const destination = repositoryPath(appRoot, file);
      fs.mkdirSync(path.dirname(destination), { recursive: true });
      fs.writeFileSync(destination, JSON.stringify(await repositoryJson(api(), file, authorized.source.commit)));
    }
    const inputs = await readReleaseEnvironment(authorized.config, { root: appRoot, profile: authorized.request.profile,
      targets: authorized.request.targets, deferProtected: true });
    inputs.providerConfiguration = { expo: inputs.expo, destinations: Object.fromEntries(authorized.config.components
      .filter(component => component.submission).map(component => [component.id, resolveConfigurationValue(component.submission, appRoot)])) };
    const policy = authorized.config.policy?.runtimeSupportFile
      ? await repositoryJson(api(), authorized.config.policy.runtimeSupportFile, authorized.source.commit)
      : { schemaVersion: 1, importedBaselines: [] };
    inputs.baseline = await hydrateBaselines({ config: authorized.config, baseline: read('baseline.json'), root: appRoot,
      source: authorized.source, api: api(), profile: authorized.request.profile, policy, providers: { expo: inputs.expo } });
    write('environment.json', inputs);
    return;
  }
  if (command === 'operation-plan') {
    const authorized = read('authorized.json'); const store = ledger(authorized.config);
    let releaseId = environment.RELEASE_ID; let plan;
    if (releaseId) {
      invariant(['resume', 'retry'].includes(authorized.request.action) && String(authorized.request.releaseId) === releaseId, 'Retained recovery differs from its authorized request.');
      const state = await store.read(releaseId);
      invariant(state.release.draft && state.plan.retainedOperation, 'Resume requires an unresolved retained operation.');
      plan = state.plan;
      const remaining = summarizeRelease(plan.graph, state.events.filter(event => plan.stages[event.stage])).remaining;
      workflowOutputs({ release_id: releaseId, ...operationMatrices(plan, remaining) });
    } else {
      invariant(authorized.request.action === 'operation', 'Expected a retained operation request.');
      const request = authorized.request.retained;
      const previous = (await store.list()).find(value => value.tag_name === `expo-release-${origin.runId}`);
      if (previous) {
        const state = await store.read(previous.id);
        plan = verifyRunReservation(state, authorized, origin); releaseId = String(previous.id);
        const remaining = summarizeRelease(plan.graph, state.events.filter(event => plan.stages[event.stage])).remaining;
        invariant(state.release.draft || remaining.length === 0, 'Finalized retained operation is incomplete.');
        workflowOutputs({ release_id: releaseId, ...operationMatrices(plan, remaining) });
      } else {
        plan = prepareRetainedOperation({ state: await store.read(request.releaseId), request, config: authorized.config,
          source: authorized.source, origin });
        const release = await store.begin(plan); releaseId = String(release.id);
        workflowOutputs({ release_id: releaseId, ...operationMatrices(plan) });
      }
    }
    return;
  }
  if (command === 'operation-stage') {
    const config = await repositoryJson(api(), 'release.config.json', environment.CONSUMER_WORKFLOW_COMMIT); const store = ledger(config);
    const state = await store.read(environment.RELEASE_ID);
    const route = routeRetainedOperation(state.plan, environment.RELEASE_STAGE);
    invariant(route.provider === environment.RELEASE_PROVIDER && route.approval === (environment.RELEASE_APPROVAL ?? ''),
      'Retained operation worker differs from its configured provider/approval boundary.');
    const scoped = { ...environment };
    if (route.provider === 'play') {
      if (route.credentials.accessToken) scoped[route.credentials.accessToken] = environment.RELEASE_ACCESS_TOKEN;
      if (route.credentials.serviceAccountBase64) scoped[route.credentials.serviceAccountBase64] = environment.RELEASE_SERVICE_ACCOUNT;
    }
    if (environment.RELEASE_MODE === 'reconcile') {
      const request = read('authorized.json').request;
      invariant(request.action === 'reconcile' && String(request.releaseId) === String(environment.RELEASE_ID)
        && (request.stage ?? request.reconciliation?.stage) === route.stage, 'Retained reconciliation changed its authorized operation.');
      return mainWorker(['reconcile'], scoped);
    }
    const result = await executeRetainedOperation({ ledger: store, releaseId: environment.RELEASE_ID, stage: route.stage,
      directory: path.join(stateRoot, 'retained'), environment: scoped, retry: environment.RELEASE_RETRY_STAGE === route.stage });
    write('operation.json', result);
    if (environment.GITHUB_STEP_SUMMARY) fs.appendFileSync(environment.GITHUB_STEP_SUMMARY, `Retained operation ${environment.RELEASE_ID}, ${route.stage}: ${result.complete ? 'complete' : 'pending'}\n`);
    return;
  }
  if (command === 'install') {
    const config = fs.existsSync(path.join(stateRoot, 'authorized.json')) ? read('authorized.json').config
      : fs.existsSync(path.join(stateRoot, 'context.json')) ? read('context.json').plan.config : read('plan.json').config;
    installSource(config, appRoot);
    return;
  }
  if (command === 'plan') {
    const authorized = read('authorized.json'); const inputs = read('environment.json'); const baseline = inputs.baseline;
    invariant(sourceGit(appRoot, ['rev-parse', 'HEAD']) === authorized.source.commit, 'Source checkout differs from the authorized request.');
    verifyToolkitPins(appRoot, { expectedRevision: authorized.source.toolkitCommit });
    const observations = inspectSource(authorized.config, { root: appRoot, source: authorized.source, profile: authorized.request.profile,
      baseline, environment: inputs.environment, environmentHash: inputs.hash, componentEnvironments: inputs.components });
    const plan = planRelease({ ...authorized.request, config: authorized.config, source: authorized.source, origin: authorized.origin,
      observations, baseline, providerConfiguration: inputs.providerConfiguration });
    write('plan.json', plan);
    const prepared = prepareSource(plan, { root: appRoot, environment: inputs.environment });
    const files = prepared.files.map(file => ({ path: file, content: fs.readFileSync(repositoryPath(appRoot, file), 'utf8'),
      mode: sourceGit(appRoot, ['ls-files', '--stage', '--', file]).split(' ')[0] }));
    write('candidate-bundle.json', validateCandidateBundle(plan, { schemaVersion: 1, kind: 'expo-release-candidate', planDigest: plan.digest, source: plan.source.commit, files }));
    workflowOutputs({ noop: plan.selection.noop });
    return;
  }
  if (command === 'reserve') {
    const authorized = read('authorized.json'); const plan = verifyPlan(read('plan.json'), authorized.source);
    invariant(hashIdentity(plan.config) === hashIdentity(authorized.config) && hashIdentity(plan.origin) === hashIdentity(authorized.origin), 'Source phase changed its trusted authority.');
    const rebuilt = planRelease({ ...authorized.request, config: authorized.config, source: authorized.source, origin: authorized.origin,
      observations: plan.components.map(component => component.observation), baseline: read('environment.json').baseline, providerConfiguration: read('environment.json').providerConfiguration });
    invariant(rebuilt.digest === plan.digest, 'Source phase altered the canonical planner result.');
    const release = await ledger(plan.config).begin(plan);
    write('release.json', { id: String(release.id) }); workflowOutputs({ release_id: release.id });
    return;
  }
  if (command === 'candidate') {
    const plan = read('plan.json'); const releaseId = environment.RELEASE_ID;
    const candidate = await publishCandidate({ api: api(), plan, bundle: read('candidate-bundle.json'), ledger: ledger(plan.config), releaseId });
    write('candidate.json', candidate); workflowOutputs({ candidate: candidate.commit });
    return;
  }
  if (command === 'validate') {
    const plan = read('plan.json'); const candidate = read('candidate.json'); const inputs = read('environment.json');
    const revision = environment.VALIDATION_ROLE === 'candidate' ? candidate.commit : plan.source.commit;
    invariant(sourceGit(appRoot, ['rev-parse', 'HEAD']) === revision, 'Validation checkout differs from its exact source.');
    runHook(plan.config, 'validate', { source: { ...plan.source, commit: revision }, profile: plan.profile, plan,
      environment: plan.config.validation?.environment ?? {} }, { root: appRoot });
    let validated = plan;
    if (environment.VALIDATION_ROLE === 'candidate') {
      const source = { ...plan.source, commit: revision };
      const observations = inspectSource(plan.config, { root: appRoot, source, profile: plan.profile,
        baseline: plan.baseline, environment: inputs.environment, environmentHash: inputs.hash, componentEnvironments: inputs.components });
      validated = finalizePlan(plan, source, observations);
      write('prepared-plan.json', validated);
    }
    const server = validated.components.find(value => value.selected && value.kind === 'server');
    if (server) {
      const directory = path.resolve('.release-validation', server.id);
      const artifact = await buildServer({ plan: validated, component: server, root: appRoot, directory });
      if (server.smoke) await smokeImage({ plan: validated, component: server, root: appRoot, artifact });
      workflowOutputs({ image_archive: path.join(directory, 'image.oci.tar') });
    }
    invariant(!sourceGit(appRoot, ['status', '--porcelain', '--untracked-files=no']), 'Validation changed tracked source files.');
    return;
  }
  if (command === 'validation-artifact') {
    const evidence = await verifyCandidateChecks({ api: api(), plan: read('plan.json'), candidate: read('candidate.json'), origin });
    workflowOutputs({ prepared_attempt: evidence.candidateAttempt });
    return;
  }
  if (command === 'merge') {
    const plan = read('plan.json'); const candidate = read('candidate.json'); const store = ledger(plan.config);
    const validated = verifyPlan(read('prepared-plan.json'), { ...plan.source, commit: candidate.commit });
    await store.append(environment.RELEASE_ID, { type: 'validated-candidate', candidate, plan: validated });
    const source = await finalizeCandidate({ api: api(), plan, candidate, origin, ledger: store, releaseId: environment.RELEASE_ID });
    const prepared = bindMergedPlan(plan, validated, { ...plan.source, commit: source });
    invariant(prepared.reservationDigest === plan.digest && prepared.prepared, 'Prepared plan does not bind the validated candidate.');
    await store.append(environment.RELEASE_ID, { type: 'prepared', plan: prepared });
    write('plan.json', prepared);
    workflowOutputs({ ...phaseMatrices(prepared), source });
    return;
  }
  if (command === 'finish') {
    const config = await repositoryJson(api(), 'release.config.json', environment.CONSUMER_WORKFLOW_COMMIT);
    const completion = await ledger(config).finish(environment.RELEASE_ID);
    if (environment.GITHUB_STEP_SUMMARY) fs.appendFileSync(environment.GITHUB_STEP_SUMMARY, `Release ${environment.RELEASE_ID}: ${completion.status}\n`);
    return;
  }
  if (['recover', 'reconcile', 'legacy'].includes(command)) {
    const authorized = read('authorized.json'); const store = ledger(authorized.config);
    const request = { ...authorized.request, ...(authorized.request.reconciliation ?? {}) };
    let state = await store.read(request.releaseId);
    invariant(!state.local, 'Local records cannot enter protected hosted recovery.');
    if (state.legacy) {
      const route = routeLegacyRecovery(state, request, authorized.config);
      if (route.provider === 'ota') {
        if (command === 'recover' && ['resume', 'retry'].includes(request.action)) {
          const plan = await prepareCalibrateOta({ ledger: store, state, target: route.target, toolkitCommit: environment.TOOLKIT_COMMIT });
          const common = calibrateOtaLedger(store, route.target);
          await recoverRelease({ ledger: common, releaseId: request.releaseId,
            request: { ...request, planDigest: plan.digest, stage: request.stage === route.target ? undefined : request.stage } });
          workflowOutputs({ legacy_ota: true, release_id: request.releaseId, target: route.target, approval: route.approval,
            retry_stage: request.action === 'retry' ? request.stage : '', execute: false, reconcile: false });
        } else if (command === 'recover' && request.action === 'reconcile') {
          invariant(state.compatibilityViews?.[route.target], 'Original OTA export must be prepared before reconciling its provider operation.');
          workflowOutputs({ reconcile: true, execute: false, release_id: request.releaseId, provider: 'expo', approval: route.approval });
        } else {
          invariant(command === 'reconcile' && request.action === 'reconcile', 'Unsupported original OTA continuation action.');
          const common = calibrateOtaLedger(store, route.target); const view = await common.read(request.releaseId); const disposers = [];
          try {
            const result = await recoverRelease({ ledger: common, releaseId: request.releaseId, request: { ...request, planDigest: view.plan.digest },
              providerForStage: async input => {
                const built = await recoveryProvider({ ...input, ledger: common, directory: path.join(stateRoot, 'original-ota'), environment });
                if (built.dispose) disposers.push(built.dispose);
                return built.provider;
              } });
            write('recovery.json', result);
          } finally { for (const dispose of disposers) dispose(); }
        }
        return;
      }
      if (command === 'recover') {
        workflowOutputs({ legacy: true, provider: route.provider, approval: route.approval, release_id: request.releaseId, execute: false, reconcile: false });
      } else {
        invariant(command === 'legacy', 'Historical recovery requires its original-format worker.');
        const result = await executeLegacyRecovery({ ledger: store, releaseId: request.releaseId, request,
          provider: environment.RECOVERY_PROVIDER, approval: environment.RECOVERY_APPROVAL ?? '', environment });
        write('recovery.json', result);
        if (environment.GITHUB_STEP_SUMMARY) fs.appendFileSync(environment.GITHUB_STEP_SUMMARY,
          `Original release ${request.releaseId}: ${request.action} ${route.stage || ''} recorded. Inspect remaining stages before finalizing.\n`);
      }
      return;
    }
    if (!state.legacy && !state.plan.prepared && !state.plan.selection.noop && ['resume', 'retry'].includes(request.action)) {
      const validated = state.events.findLast(event => event.type === 'validated-candidate');
      const intent = state.events.findLast(event => event.type === 'merge-intent');
      if (validated && intent) {
        const pull = await api()(`/pulls/${validated.candidate.pullNumber}`);
        if (pull.merged) {
          const commit = await finalizeCandidate({ api: api(), plan: state.plan, candidate: validated.candidate,
            origin, ledger: store, releaseId: request.releaseId, workflowCommit: environment.CONSUMER_WORKFLOW_COMMIT,
            toolkitCommit: environment.TOOLKIT_COMMIT });
          const prepared = bindMergedPlan(state.reservation, validated.plan, { ...state.plan.source, commit });
          await store.append(request.releaseId, { type: 'prepared', plan: prepared });
          state = await store.read(request.releaseId);
          request.planDigest = prepared.digest;
        }
      }
      if (!state.plan.prepared) {
        invariant(request.action === 'resume', 'Candidate validation resumes its original workflow; it is not a provider retry.');
        await requireCurrentSource(api(), state.plan.config, state.plan.source.commit);
        const producer = await verifyProducer(api(), state.plan.config, state.plan.origin, state.plan.source.workflowCommit);
        invariant(producer.status === 'completed' && producer.conclusion !== 'success', 'Only a finished unsuccessful original candidate run may resume.');
        await store.append(request.releaseId, { type: 'recovery', action: 'resume-candidate', originalOrigin: state.plan.origin });
        workflowOutputs({ execute: false, reconcile: false, rerun_run_id: state.plan.origin.runId, release_id: request.releaseId });
        return;
      }
    }
    if (command === 'recover' && request.action === 'reconcile') {
      invariant(!state.legacy, 'Historical reconciliation requires its original compatibility worker.');
      if (state.plan.retainedOperation) {
        const route = routeRetainedOperation(state.plan, request.stage);
        invariant(route.provider !== 'image', 'Resume image finalization to verify its exact tag and alias state.');
        workflowOutputs({ retained_reconcile: true, reconcile: false, execute: false, release_id: request.releaseId,
          provider: route.provider, approval: route.approval, stage: route.stage,
          access_token_secret: route.credentials?.accessToken ?? '', service_account_secret: route.credentials?.serviceAccountBase64 ?? '' });
        return;
      }
      const target = recoveryTarget(state.plan, request.stage);
      const deployment = request.stage === `${target.id}:deploy`;
      workflowOutputs({ reconcile: true, approval: deployment ? state.plan.config.deployment.environment : target.approvalEnvironment ?? '',
        provider: deployment ? 'deploy' : target.kind === 'server' ? 'image' : 'expo',
        release_id: request.releaseId, execute: false });
      return;
    }
    const disposers = [];
    try {
      const result = await recoverRelease({ ledger: store, releaseId: request.releaseId, request,
        providerForStage: async input => {
          const built = await recoveryProvider({ ...input, ledger: store, directory: path.join(stateRoot, 'reconciled'), environment });
          if (built.dispose) disposers.push(built.dispose);
          return built.provider;
        } });
      write('recovery.json', result);
      const execute = ['resume', 'retry'].includes(request.action);
      invariant(!execute || !result.legacy && (result.prepared || result.plan.selection.noop),
        'Resume candidate preparation in the original producing workflow before running publication recovery.');
      const matrices = execute ? Object.fromEntries(Object.entries(phaseMatrices(result.plan, result.stages))
        .map(([key, value]) => [key, typeof value === 'object' ? JSON.stringify(value) : value])) : {};
      workflowOutputs({ release_id: request.releaseId, execute: execute && !result.plan.retainedOperation,
        retained: execute && Boolean(result.plan.retainedOperation), reconcile: false, matrices,
        retry_stage: request.action === 'retry' ? request.stage : '' });
    } finally { for (const dispose of disposers) dispose(); }
    return;
  }
  throw new Error(`Unknown shared worker phase ${command}.`);
}
