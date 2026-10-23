/** @file Source-free artifact authorization and publication workers; application code is confined to explicit build commands. */
import fs from 'node:fs';
import path from 'node:path';
import { invariant, hashIdentity, verifyArtifactManifest, verifyPlan } from '../packages/release-engine/index.mjs';
import { githubClient, verifyProducer } from './github.mjs';
import { repositoryJson } from './trusted.mjs';
import { GitHubLedger } from './ledger.mjs';
import { repositoryPath } from './config.mjs';
import { verifyRetainedArtifact } from './artifacts.mjs';
import { verifyReceiptAttestation } from './attestation.mjs';
import { retainArtifact, restoreArtifact, retentionRecovery } from './retention.mjs';
import { stageContext, completeStage, runProviderStage } from './stages.mjs';
import { buildApplication, prepareBuild } from './build.mjs';
import { readReleaseEnvironment } from './environment.mjs';
import { workflowOutputs } from './worker.mjs';
import { inspectOciArchive, createGhcrProvider, createGhcrTransport } from './providers/ghcr.mjs';
import { createDeploymentProvider } from './providers/deploy.mjs';
import { createEasTransport } from './providers/eas.mjs';
import { verifyOtaExports, publishOta } from './ota.mjs';
import { finalizeServer } from './server-release.mjs';
import { latestOperation } from './operations.mjs';

/** Route signing secrets only to an explicitly configured command Android builder. */
export function signingSecretNames(component) {
  const enabled = component.kind === 'native' && component.builder === 'command' && component.platform === 'android' && component.signing?.variables;
  return { signing_keystore_secret: enabled ? 'ANDROID_KEYSTORE_BASE64' : '',
    signing_store_secret: enabled ? 'ANDROID_STORE_PASSWORD' : '',
    signing_alias_secret: enabled ? 'ANDROID_KEY_ALIAS' : '',
    signing_key_secret: enabled ? 'ANDROID_KEY_PASSWORD' : '' };
}

/** Reject altered provenance before the isolated signer can attest a staged source artifact. */
export async function verifyStagedReceipt({ plan, receipt, directory, origin, workflowCommit, toolkitCommit }) {
  invariant(receipt.kind === 'expo-release-artifact' && receipt.schemaVersion === 1 && receipt.planDigest === plan.digest
    && receipt.configuration === hashIdentity(plan.config) && hashIdentity(receipt.source) === hashIdentity(plan.source)
    && hashIdentity(receipt.origin) === hashIdentity(origin) && hashIdentity(receipt.producer) === hashIdentity({ origin, workflowCommit, toolkitCommit }),
  'Staged artifact differs from this producing run, plan, application source or toolkit.');
  const component = plan.components.find(value => value.id === receipt.target && value.selected);
  invariant(component && receipt.metadata?.kind === component.kind, 'Staged artifact target is not selected.');
  invariant(hashIdentity(receipt.metadata.expo) === hashIdentity(plan.providerConfiguration.expo ?? null)
    && hashIdentity(receipt.metadata.destination) === hashIdentity(plan.providerConfiguration.destinations?.[component.id] ?? null),
  'Staged provider identity or destination differs from trusted configuration.');
  await verifyArtifactManifest(directory, receipt.manifest);
  if (component.kind === 'server') {
    invariant(receipt.metadata.image === component.image, 'Image repository differs from the plan.');
    invariant(hashIdentity(await inspectOciArchive(path.join(directory, 'image.oci.tar'))) === hashIdentity(receipt.metadata.oci), 'OCI metadata differs from retained bytes.');
  } else if (component.kind === 'ota') {
    await verifyOtaExports({ plan, component, directory, metadata: receipt.metadata });
  } else {
    invariant(receipt.metadata.runtime === component.observation.runtime && receipt.metadata.version === component.observation.version,
      'Staged runtime or application version differs from the prepared source.');
    if (component.kind === 'native') invariant(receipt.metadata.versionCode === component.observation.versionCode, 'Staged native code differs from its reservation.');
  }
  return true;
}

/** Execute one supported artifact phase. Publication restores only retained inert bytes and never checks out application source. */
export async function artifactWorker(command, environment = process.env) {
  const stateRoot = path.resolve(environment.RELEASE_STATE ?? '.release-state');
  const outputRoot = path.resolve(environment.RELEASE_ARTIFACTS ?? '.release-artifacts');
  const appRoot = path.resolve(environment.RELEASE_SOURCE ?? '.app');
  const origin = { kind: 'github', runId: environment.GITHUB_RUN_ID, runAttempt: Number(environment.GITHUB_RUN_ATTEMPT) };
  const workflowCommit = environment.CONSUMER_WORKFLOW_COMMIT; const toolkitCommit = environment.TOOLKIT_COMMIT;
  const read = file => JSON.parse(fs.readFileSync(repositoryPath(stateRoot, file), 'utf8'));
  const write = (file, value) => { fs.mkdirSync(stateRoot, { recursive: true }); fs.writeFileSync(repositoryPath(stateRoot, file), `${JSON.stringify(value, null, 2)}\n`); };
  if (['source-prepare', 'source-build', 'cloud-enqueue'].includes(command)) {
    const { plan, target } = read('context.json'); const inputs = read('target-environment.json');
    if (command === 'source-prepare') return prepareBuild({ plan, target, root: appRoot, inputs });
    if (command === 'cloud-enqueue') {
      const { enqueueCloudBuild } = await import('./cloud-build.mjs');
      return enqueueCloudBuild({ plan, target, root: appRoot, inputs, lease: read('cloud-intent.json').lease, origin,
        handoffFile: repositoryPath(stateRoot, 'cloud-accepted.json'), providerEnvironment: environment });
    }
    return buildApplication({ plan, target, root: appRoot, outputRoot, inputs, origin, workflowCommit, toolkitCommit,
      signingDirectory: path.resolve(environment.RUNNER_TEMP ?? stateRoot, 'release-signing'), environment });
  }
  const api = githubClient({ repository: environment.GITHUB_REPOSITORY, token: environment.GITHUB_TOKEN });
  const config = await repositoryJson(api, 'release.config.json', workflowCommit);
  const ledger = new GitHubLedger({ config, api, origin, workflowCommit });
  const releaseId = environment.RELEASE_ID; const target = environment.RELEASE_TARGET; const action = environment.RELEASE_ACTION;
  let context;
  if (command === 'verify-staged') {
    // The isolated signer consumes the source-free context job's immutable Actions artifact.
    // Draft Release API access requires Contents write, which this signer intentionally lacks.
    const authorized = read('context.json'); const plan = verifyPlan(authorized.plan, { repository: config.repository });
    invariant(authorized.target === target && authorized.action === action && plan.prepared && plan.origin.kind === 'github',
      'Signer context differs from the authorized artifact phase.');
    context = { plan, component: plan.components.find(value => value.selected && value.id === target) };
    invariant(context.component, 'Signer target is not selected.');
  } else context = await stageContext(ledger, releaseId, target, action);
  const { plan, component } = context;
  const verifier = (receipt, directory, file) => verifyRetainedArtifact({ plan, target: receipt.target, directory, receipt,
    verifyProducer: async value => Boolean(await verifyProducer(api, config, value.producer.origin, value.producer.workflowCommit)),
    verifyAttestation: value => verifyReceiptAttestation({ api, config, receipt: value, file }) });
  if (command === 'context') {
    const targets = plan.components.filter(value => value.selected && (value.id === target || component.buildGroup && value.buildGroup === component.buildGroup)).map(value => value.id);
    const complete = targets.every(id => !context.summary.remaining.includes(`${id}:${action}`));
    const retained = complete ? null : retentionRecovery(context.state, targets);
    write('context.json', { plan, target, action });
    workflowOutputs({ source: plan.source.commit, complete, builder: component.builder ?? '', kind: component.kind, targets,
      retention_run: retained?.runId ?? '', retention_attempt: retained?.runAttempt ?? '', retention_name: retained?.name ?? '',
      app_directory: component.appDirectory ?? '.', source_attempt: origin.runAttempt });
    workflowOutputs(signingSecretNames(component));
    return;
  }
  if (context.complete && !['verify-staged', 'retain'].includes(command)) return;
  if (command === 'cloud-begin') {
    const { beginCloudBuild } = await import('./cloud-build.mjs');
    const intent = await beginCloudBuild({ ledger, releaseId, target, origin, providerEnvironment: environment,
      retry: environment.RELEASE_RETRY_STAGE === `${target}:build-provider` });
    write('cloud-intent.json', intent);
    const producer = (intent.lease ?? intent.operation.request).origin;
    workflowOutputs({ mode: intent.mode, producer_attempt: producer.runAttempt, producer_run: producer.runId });
    return;
  }
  if (command === 'cloud-monitor') {
    const { monitorCloudBuild } = await import('./cloud-build.mjs');
    return monitorCloudBuild({ ledger, releaseId, target, inputs: read('target-environment.json'), outputRoot,
      origin, workflowCommit, toolkitCommit, providerEnvironment: environment,
      ...(fs.existsSync(path.join(stateRoot, 'cloud-accepted.json')) ? { accepted: read('cloud-accepted.json') } : {}) });
  }
  if (command === 'target-environment') {
    const resolvedConfig = { ...plan.config, expo: plan.providerConfiguration.expo,
      components: plan.config.components.map(value => ({ ...value, ...(plan.providerConfiguration.destinations?.[value.id] ? { submission: plan.providerConfiguration.destinations[value.id] } : {}) })) };
    const inputs = await readReleaseEnvironment(resolvedConfig, { root: stateRoot, profile: plan.profile, targets: [target] });
    if (component.kind === 'ota') inputs.components[target].branch = await createEasTransport({ env: environment })
      .channel({ projectId: inputs.expo.projectId, channel: component.channel });
    write('target-environment.json', inputs);
    return;
  }
  if (command === 'verify-staged' || command === 'retain') {
    const targets = JSON.parse(environment.RELEASE_TARGETS ?? JSON.stringify([target]));
    invariant(Array.isArray(targets) && targets.length && targets.every(id => plan.components.some(value => value.selected && value.id === id
      && (id === target || component.buildGroup && value.buildGroup === component.buildGroup))), 'Invalid retained build cohort.');
    const files = [];
    for (const id of targets) {
      const receiptFile = repositoryPath(outputRoot, `${id}/receipt.json`);
      const directory = repositoryPath(outputRoot, `${id}/files`);
      const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8'));
      if (command === 'verify-staged') {
        const producingOrigin = { ...origin, runAttempt: Number(environment.ARTIFACT_RUN_ATTEMPT) };
        invariant(Number.isSafeInteger(producingOrigin.runAttempt) && producingOrigin.runAttempt > 0
          && producingOrigin.runAttempt <= origin.runAttempt, 'Invalid original artifact attempt.');
        await verifyProducer(api, config, producingOrigin, workflowCommit);
        await verifyStagedReceipt({ plan, receipt, directory, origin: producingOrigin, workflowCommit, toolkitCommit });
      }
      else {
        const evidence = await retainArtifact({ ledger, releaseId, receipt, directory, verify: value => verifier(value, directory, receiptFile),
          staging: { runId: environment.ARTIFACT_RUN_ID ?? origin.runId, runAttempt: Number(environment.ARTIFACT_RUN_ATTEMPT), name: environment.ARTIFACT_NAME } });
        await completeStage({ ledger, releaseId, target: id, action: component.kind === 'ota' ? 'export' : 'build',
          receipt: { artifact: evidence.receiptAsset, manifest: receipt.manifest.digest } });
      }
      files.push(receiptFile);
    }
    if (environment.GITHUB_OUTPUT) fs.appendFileSync(environment.GITHUB_OUTPUT, `receipt_files<<RECEIPTS\n${files.join('\n')}\nRECEIPTS\n`);
    return;
  }
  if (command === 'publish') {
    if (action === 'deploy') {
      const provider = createDeploymentProvider(plan.config.deployment, { environment });
      return runProviderStage({ ledger, releaseId, target, action, provider, request: { service: plan.config.deployment.service },
        retry: environment.RELEASE_RETRY_STAGE === `${target}:deploy` });
    }
    const artifact = await restoreArtifact({ ledger, releaseId, target, directory: repositoryPath(outputRoot, `${target}/restored`), verify: verifier });
    if (component.kind === 'server') {
      const image = component.image; const version = component.observation.version;
      const transport = createGhcrTransport({ image, username: environment.GITHUB_ACTOR, token: environment.GHCR_TOKEN });
      if (action === 'finalize') return finalizeServer({ ledger, releaseId, target, api, artifact: {
        ...artifact, file: path.join(artifact.directory, 'image.oci.tar') }, transport });
      invariant(/^\d+\.\d+\.\d+$/.test(version), 'Server publication requires an exact semantic version.');
      const aliases = [`v${version}`, `sha-${plan.source.commit}`];
      const provider = createGhcrProvider({ image, source: plan.source.commit, target, sourceProof: artifact.sourceProof,
        file: path.join(artifact.directory, 'image.oci.tar'), oci: artifact.receipt.metadata.oci, aliases },
      transport);
      return runProviderStage({ ledger, releaseId, target, action, provider, request: { image, aliases }, retry: environment.RELEASE_RETRY_STAGE === `${target}:${action}` });
    }
    if (component.kind === 'ota') return publishOta({ ledger, releaseId, plan, component, artifact,
      providerEnvironment: environment, retryStage: environment.RELEASE_RETRY_STAGE });
    const { createEasStage } = await import('./eas-stages.mjs');
    const built = await createEasStage({ action: component.kind === 'ota' ? 'publish' : action, plan, component, artifact,
      sourceProof: artifact.sourceProof, providerEnvironment: environment,
      operation: latestOperation((await ledger.read(releaseId)).events, `${target}:submit`) });
    try { return await runProviderStage({ ledger, releaseId, target, action: component.kind === 'ota' ? 'publish' : 'submit',
      provider: built.provider, handoff: action === 'handoff', retry: environment.RELEASE_RETRY_STAGE === `${target}:submit` }); }
    finally { built.dispose?.(); }
  }
  throw new Error(`Unknown artifact worker command ${command}.`);
}
