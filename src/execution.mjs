/** @file One source-free provider factory and stage executor for new releases, retained artifacts and recovery. */
import path from 'node:path';
import { invariant } from '../packages/release-engine/index.mjs';
import { stageRoute, stageContext, runProviderStage } from './stages.mjs';
import { retainedSource } from './retained-operations.mjs';
import { restoreVerifiedArtifact } from './retention.mjs';
import { createEasStage, createCloudObserver } from './eas-stages.mjs';
import { createGhcrProvider, createGhcrTransport } from './providers/ghcr.mjs';
import { createDeploymentProvider } from './providers/deploy.mjs';
import { createPlayCohortPromotionProvider } from './providers/play-cohort.mjs';
import { createGooglePlayPublisher, resolvePromotionToken } from './providers/play-transport.mjs';
import { verifyOtaExports, publishOta } from './ota.mjs';
import { finalizeServer } from './server-release.mjs';
import { latestOperation } from './operations.mjs';

/** Bind original artifacts to the current authorized operation; construction never mutates a provider. */
export async function createStageProvider({ ledger, state, stage, directory, environment = process.env,
  restore = restoreVerifiedArtifact, easTransport, registry, deploy, token = resolvePromotionToken,
  publisherFactory = createGooglePlayPublisher }) {
  const plan = state.plan;
  const route = stageRoute(plan, stage);
  const source = plan.retainedOperation ? await retainedSource(ledger, plan) : state;
  const component = source.plan.components.find(value => value.id === route.target);
  const artifacts = new Map();
  const load = async target => {
    if (!artifacts.has(target)) artifacts.set(target, await restore({ ledger, state: source, target, directory: path.join(directory, target) }));
    return artifacts.get(target);
  };
  let workspace;
  try {
    let provider; let artifact; let transport;
    if (route.action === 'build-provider') {
      workspace = await createCloudObserver({ plan: source.plan, component, transport: easTransport, providerEnvironment: environment });
      provider = workspace.provider;
    } else if (route.provider === 'deploy') {
      provider = createDeploymentProvider(plan.config.deployment, { environment, ...(deploy ? { transport: deploy } : {}) });
    } else if (route.provider === 'play') {
      const spec = plan.stages[stage]; const policy = plan.config.promotions[spec.promotion]; const targets = [];
      for (const target of spec.targets) {
        const retained = await load(target); const selected = source.plan.components.find(value => value.id === target); const tracks = policy.tracks[target];
        const files = retained.receipt?.manifest.files.filter(value => value.path.endsWith('.aab'));
        invariant(retained.file || files?.length === 1, 'Promotion needs one original AAB per target.');
        if (retained.receipt) invariant(retained.receipt.metadata.kind === 'native'
          && Number(retained.receipt.metadata.native?.versionCode ?? retained.receipt.metadata.versionCode) === selected.observation.versionCode,
        'Promotion version differs from original native artifact metadata.');
        const marker = `${tracks.sourceMarkerPrefix || `expo-${target}`}@${source.plan.source.commit}`;
        targets.push({ target, applicationId: spec.applicationId, sourceTrack: tracks.source, destination: tracks.destination,
          versionCode: selected.observation.versionCode, sha256: retained.sha256 || files[0].sha256, marker,
          ...(tracks.sourceMarkerPrefix ? { sourceMarker: marker } : {}), sourceProof: retained.sourceProof });
      }
      provider = createPlayCohortPromotionProvider({ applicationId: spec.applicationId, source: source.plan.source.commit,
        repository: source.plan.source.repository, targets }, publisherFactory({ applicationId: spec.applicationId, accessToken: await token(policy.credentials, environment) }));
    } else {
      artifact = await load(route.target);
      if (route.provider === 'image') {
        const image = component.image; const version = component.observation.version;
        transport = registry || createGhcrTransport({ image, username: environment.GITHUB_ACTOR, token: environment.GHCR_TOKEN });
        if (route.action === 'publish') {
          invariant(/^\d+\.\d+\.\d+$/.test(version), 'Server publication requires an exact semantic version.');
          provider = createGhcrProvider({ image, source: source.plan.source.commit, target: route.target, sourceProof: artifact.sourceProof,
            file: path.join(artifact.directory, 'image.oci.tar'), oci: artifact.receipt.metadata.oci,
            aliases: [`v${version}`, `sha-${source.plan.source.commit}`] }, transport);
        }
      } else {
        let binding;
        if (component.kind === 'ota') {
          await verifyOtaExports({ plan: source.plan, component, directory: artifact.directory, metadata: artifact.receipt.metadata });
          if (route.runtime) {
            binding = artifact.receipt.metadata.bindings.find(value => value.key === route.runtime);
            invariant(binding, 'Reconcile the exact retained OTA runtime operation.');
          }
        }
        if (component.kind !== 'ota' || binding) {
          workspace = await createEasStage({ action: route.action === 'handoff' ? 'submit' : route.action,
            plan: source.plan, component, artifact, binding, sourceProof: artifact.sourceProof, transport: easTransport,
            providerEnvironment: environment, operation: latestOperation(state.events, route.operationStage) });
          provider = workspace.provider;
        }
      }
    }
    return { route, provider, artifact, transport, source, component,
      /** Dispose only the inert provider workspace; retained artifact ownership stays with the caller. */
      dispose() { workspace?.dispose(); } };
  } catch (error) { workspace?.dispose(); throw error; }
}

/** Execute one canonical stage. Recovery supplies the same plan; retained plans reference their original artifacts. */
export async function executeStage(options) {
  const { ledger, releaseId, stage, retry = false, retryStage, wait = true, environment = process.env } = options;
  const state = await ledger.read(releaseId); const route = stageRoute(state.plan, stage);
  invariant(!route.runtime && route.action !== 'build-provider', 'Provider suboperations are observed through recovery, not independently dispatched.');
  const context = await stageContext(ledger, releaseId, route.target, route.action);
  if (context.complete) return { route, complete: true };
  const built = await createStageProvider({ ...options, state, environment });
  try {
    if (route.action === 'finalize') {
      await finalizeServer({ ledger, releaseId, target: route.target, api: ledger.api,
        artifact: { ...built.artifact, file: path.join(built.artifact.directory, 'image.oci.tar') }, transport: built.transport });
      return { route, complete: true };
    }
    if (built.component.kind === 'ota' && route.action === 'publish') {
      await publishOta({ ledger, releaseId, plan: state.plan, component: built.component, artifact: built.artifact,
        providerEnvironment: environment, retry, retryStage, stageFactory: async ({ binding }) => createStageProvider({ ...options, state, environment,
          stage: `${stage}:runtime-${binding.key}`, restore: async () => built.artifact }) });
      return { route, complete: true };
    }
    const request = state.plan.retainedOperation ? { retainedReleaseId: state.plan.retainedOperation.releaseId, retainedPlanDigest: state.plan.retainedOperation.planDigest }
      : route.provider === 'deploy' ? { service: state.plan.config.deployment.service }
      : route.provider === 'image' ? { image: built.component.image, aliases: [`v${built.component.observation.version}`, `sha-${state.plan.source.commit}`] } : {};
    const operation = await runProviderStage({ ledger, releaseId, target: route.target,
      action: route.action === 'handoff' ? 'submit' : route.action, handoff: route.action === 'handoff',
      provider: built.provider, retry: retryStage ? retryStage === route.operationStage : retry, wait, request });
    return { route, complete: route.action === 'handoff' || operation.status === 'complete', operation };
  } finally { built.dispose(); }
}
