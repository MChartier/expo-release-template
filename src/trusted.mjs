/** @file Default-branch request authorization and independently pinned toolkit loading for privileged reusable workers. */
import { invariant, hashIdentity } from '../packages/release-engine/index.mjs';
import { validateConfig } from './config.mjs';

/** Decode one bounded GitHub contents response as inert data. */
export async function repositoryJson(api, file, ref) {
  const result = await api(`/contents/${file}?ref=${encodeURIComponent(ref)}`);
  invariant(result.type === 'file' && result.encoding === 'base64' && result.size <= 2 * 1024 * 1024, 'Trusted configuration is not a bounded data file.');
  return JSON.parse(Buffer.from(result.content, 'base64').toString('utf8'));
}

/** Validate the request's finite operation vocabulary before recording it in an unprivileged workflow. */
export function validateRequest(value) {
  invariant(value?.schemaVersion === 1 && ['release', 'operation', 'resume', 'retry', 'abandon', 'reconcile', 'complete'].includes(value.action), 'Unsupported release request.');
  invariant(JSON.stringify(value).length < 16384, 'Release request exceeds its bound.');
  const allowed = new Set(['schemaVersion', 'kind', 'action', 'source', 'toolkitCommit', 'configuration', 'profile', 'operation', 'bump',
    'targets', 'releaseId', 'planDigest', 'reconciliation', 'stage', 'reason', 'retained']);
  invariant(Object.keys(value).every(key => allowed.has(key)), 'Unknown release request fields.');
  if (value.action === 'release') {
    invariant(['release', 'build', 'ota'].includes(value.operation ?? 'release') && ['major', 'minor', 'patch'].includes(value.bump ?? 'patch'), 'Invalid requested release operation.');
    if (value.source) invariant(/^[a-f0-9]{40}$/.test(value.source), 'Release source must be an exact commit.');
  } else if (value.action === 'operation') {
    invariant(value.retained?.kind === 'expo-release-operation' && ['submit', 'deploy', 'promote'].includes(value.retained.operation)
      && /^[1-9]\d*$/.test(String(value.retained.releaseId)) && /^[a-f0-9]{64}$/.test(value.retained.digest), 'Invalid retained operation request.');
    invariant(Object.keys(value).every(key => ['schemaVersion', 'action', 'retained'].includes(key)), 'Retained operation authority must be contained in its sealed request.');
  } else invariant(/^[1-9]\d*$/.test(String(value.releaseId)), 'Recovery requires an existing numeric release ID.');
  invariant(!value.targets || Array.isArray(value.targets) && value.targets.length <= 32 && value.targets.every(id => /^[A-Za-z0-9][\w.:-]{0,191}$/.test(id)), 'Invalid target selection.');
  invariant(!value.profile || /^[A-Za-z0-9][\w.-]{0,64}$/.test(value.profile), 'Invalid release profile.');
  if (value.planDigest) invariant(/^[a-f0-9]{64}$/.test(value.planDigest), 'Invalid original plan digest.');
  if (value.stage) invariant(/^[A-Za-z0-9][\w.:-]{0,191}$/.test(value.stage), 'Invalid recovery stage.');
  if (value.action === 'retry') invariant(value.stage, 'Retry requires one exact provider stage.');
  if (value.action === 'abandon') invariant(typeof value.reason === 'string' && value.reason.trim().length >= 20 && value.reason.length <= 2000, 'Abandonment requires a specific bounded reason.');
  if (value.action === 'reconcile') {
    const evidence = value.reconciliation;
    invariant(evidence && evidence.confirmed === true && typeof evidence.stage === 'string'
      && /^[A-Za-z0-9][\w.:-]{0,191}$/.test(evidence.stage)
      && Object.keys(evidence).every(key => ['confirmed', 'stage', 'operationId', 'absence', 'destination', 'health'].includes(key)),
    'Reconciliation requires explicit confirmed evidence for one stage.');
    invariant(!value.stage || value.stage === evidence.stage, 'Conflicting reconciliation stage.');
  }
  return value;
}

/** Bind the request to an exact successful read-only dispatch and the current protected consumer/toolkit revisions. */
export async function authorizeRequest({ api, event, repository, consumerWorkflow, toolkitCommit, request }) {
  invariant(event?.workflow_run && /^[a-f0-9]{40}$/.test(consumerWorkflow) && /^[a-f0-9]{40}$/.test(toolkitCommit), 'Trusted handling requires workflow_run with independent exact revisions.');
  const run = await api(`/actions/runs/${event.workflow_run.id}`);
  const config = validateConfig(await repositoryJson(api, 'release.config.json', consumerWorkflow));
  invariant(config.repository === repository, 'Configuration belongs to another repository.');
  const branch = await api(`/branches/${encodeURIComponent(config.defaultBranch)}`);
  invariant(branch.protected === true && branch.commit?.sha === consumerWorkflow, 'Only the current protected consumer workflow may handle a request.');
  const workflows = [config.github.requestWorkflow, config.github.recoveryWorkflow].map(file => `.github/workflows/${file}`);
  invariant(run.repository?.full_name === repository && run.head_repository?.full_name === repository && run.head_branch === config.defaultBranch
    && run.head_sha === consumerWorkflow && run.event === 'workflow_dispatch' && run.status === 'completed' && run.conclusion === 'success'
    && workflows.includes(run.path) && Number(run.id) === Number(event.workflow_run.id), 'Request is not an exact successful default-branch dispatch.');
  const actor = run.triggering_actor?.login ?? run.actor?.login;
  const permission = await api(`/collaborators/${encodeURIComponent(actor)}/permission`);
  invariant(['admin', 'maintain', 'write'].includes(permission.permission) || permission.user?.permissions?.push === true, 'Release requester lacks repository write authority.');
  const packageJson = await repositoryJson(api, 'package.json', consumerWorkflow);
  const dependency = packageJson.dependencies?.['@mchartier/expo-release'] ?? packageJson.devDependencies?.['@mchartier/expo-release'];
  invariant(dependency === `git+https://github.com/MChartier/expo-release-template.git#${toolkitCommit}`, 'Workflow toolkit revision differs from the consumer package pin.');
  const artifacts = await api(`/actions/runs/${run.id}/artifacts?per_page=100`);
  const matches = artifacts.artifacts?.filter(artifact => artifact.name === 'expo-release-request' && !artifact.expired);
  invariant(artifacts.total_count <= 100 && matches?.length === 1 && matches[0].size_in_bytes <= 65536,
    'Request run must contain exactly one bounded request artifact.');
  if (!request) return { artifactId: String(matches[0].id), requestRunId: String(run.id), config };
  validateRequest(request);
  invariant(!request.source || request.source === consumerWorkflow, 'Requested source is no longer the current protected source.');
  invariant(!request.toolkitCommit || request.toolkitCommit === toolkitCommit, 'Requested toolkit differs.');
  invariant(!request.configuration || request.configuration === hashIdentity(config), 'Configuration changed after local planning.');
  return { request: { operation: 'release', bump: 'patch', profile: config.defaultProfile ?? '', targets: [], ...request },
    source: { repository, commit: consumerWorkflow, workflowCommit: consumerWorkflow, toolkitCommit }, config,
    requester: actor, requestRunId: String(run.id), artifactId: String(matches[0].id) };
}
