/** @file Recreate observers from frozen plans and retained artifacts without checking out application source. */
import path from 'node:path';
import { invariant } from '../packages/release-engine/index.mjs';
import { repositoryPath } from './config.mjs';
import { verifyRetainedArtifact } from './artifacts.mjs';
import { verifyReceiptAttestation } from './attestation.mjs';
import { verifyProducer } from './github.mjs';
import { restoreArtifact } from './retention.mjs';
import { createEasStage } from './eas-stages.mjs';
import { createEasBuildProvider } from './providers/eas.mjs';
import { createEasPublisherWorkspace } from './providers/eas-workspace.mjs';
import { createGhcrProvider, createGhcrTransport } from './providers/ghcr.mjs';
import { createDeploymentProvider } from './providers/deploy.mjs';
import { verifyOtaExports } from './ota.mjs';
import { retainedOperationProvider } from './retained-operations.mjs';
import { latestOperation } from './operations.mjs';

/** Identify one configured target without splitting identifiers that may themselves contain colons. */
export function recoveryTarget(plan, stage) {
  const component = plan.components.find(value => value.selected && (stage === `${value.id}:build-provider`
    || Object.keys(plan.stages).some(key => plan.stages[key].target === value.id && (stage === key || stage.startsWith(`${key}:runtime-`)))));
  invariant(component, 'Recovery stage does not identify a selected provider target.');
  return component;
}

/** Caller disposes the generated data-only provider workspace after observation. */
export async function recoveryProvider({ ledger, state, stage, directory, environment = process.env }) {
  if (state.plan.retainedOperation) return retainedOperationProvider({ ledger, state, stage, directory, environment });
  const { plan } = state; const component = recoveryTarget(plan, stage);
  const target = component.id; const api = ledger.api; const config = ledger.config;
  if (stage === `${target}:build-provider`) {
    const built = await createEasStage({ action: 'build', plan, component, transport: {} });
    const workspace = createEasPublisherWorkspace({ ...built.spec, expoConfig: component.observation.expoConfig }, { env: environment });
    return { provider: createEasBuildProvider(built.spec, workspace.transport), dispose: () => workspace.dispose() };
  }
  if (stage === `${target}:deploy`) return { provider: createDeploymentProvider(plan.config.deployment, { environment }) };
  const artifact = await restoreArtifact({ ledger, releaseId: state.release.id, target,
    directory: repositoryPath(directory, `${target}/restored`), verify: (receipt, folder, file) => verifyRetainedArtifact({ plan, target, receipt, directory: folder,
      verifyProducer: async value => Boolean(await verifyProducer(api, config, value.producer.origin, value.producer.workflowCommit)),
      verifyAttestation: value => verifyReceiptAttestation({ api, config, receipt: value, file }) }) });
  if (component.kind === 'server') {
    invariant(stage === `${target}:publish`, 'Only the image publication is a provider operation.');
    const image = component.image;
    return { provider: createGhcrProvider({ image, source: plan.source.commit, target, sourceProof: artifact.sourceProof,
      file: path.join(artifact.directory, 'image.oci.tar'), oci: artifact.receipt.metadata.oci,
      aliases: [`v${component.observation.version}`, `sha-${plan.source.commit}`] },
    createGhcrTransport({ image, username: environment.GITHUB_ACTOR, token: environment.GHCR_TOKEN })) };
  }
  let binding;
  if (component.kind === 'ota') {
    await verifyOtaExports({ plan, component, directory: artifact.directory, metadata: artifact.receipt.metadata });
    binding = artifact.receipt.metadata.bindings.find(value => stage === `${target}:publish:runtime-${value.key}`);
    invariant(binding, 'Reconcile the exact retained OTA runtime operation.');
  } else invariant(stage === `${target}:submit`, 'Reconcile the native submission operation.');
  return createEasStage({ action: component.kind === 'ota' ? 'publish' : 'submit', plan, component, artifact,
    binding, sourceProof: artifact.sourceProof, providerEnvironment: environment, operation: latestOperation(state.events, stage) });
}
