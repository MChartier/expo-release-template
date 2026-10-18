/** @file Data-only candidate publication, exact-run validation and protected pull-request finalization. */
import { invariant, hashIdentity, verifyPlan } from '../packages/release-engine/index.mjs';
import { verifyProducer } from './github.mjs';
import { validateArtifactPath } from '../packages/release-engine/artifacts.mjs';

const sha = value => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

/** Remove only an explicitly abandoned, unmerged, unchanged candidate after fresh exact-ref inspection. */
export async function abandonCandidate({ api, ledger, state }) {
  const candidate = state.events.findLast(event => event.type === 'candidate');
  if (!candidate?.branch) return;
  invariant(!state.plan.prepared && !state.events.some(event => event.type === 'prepared' || event.type === 'merged'), 'A merged candidate cannot be abandoned.');
  const pull = await api(`/pulls/${candidate.pullNumber}`);
  const unchanged = value => !value.merged && !value.merged_at && value.head.sha === candidate.commit && value.head.ref === candidate.branch
    && value.head.repo?.full_name === state.plan.source.repository && value.base.ref === state.plan.config.defaultBranch;
  invariant(unchanged(pull), 'Candidate was merged or moved; cleanup is blocked.');
  let reference;
  try { reference = await api(`/git/ref/heads/${candidate.branch}`); } catch (error) { if (error.status !== 404) throw error; }
  invariant(!reference || reference.object.sha === candidate.commit, 'Candidate branch moved; cleanup is blocked.');
  await ledger.append(state.release.id, { type: 'candidate-cleanup', candidate: candidate.commit, branch: candidate.branch, pullNumber: candidate.pullNumber });
  if (pull.state === 'open') await api(`/pulls/${candidate.pullNumber}`, { method: 'PATCH', body: { state: 'closed' } });
  if (reference) {
    invariant(unchanged(await api(`/pulls/${candidate.pullNumber}`))
      && (await api(`/git/ref/heads/${candidate.branch}`)).object.sha === candidate.commit, 'Candidate changed during cleanup.');
    await api(`/git/refs/heads/${candidate.branch}`, { method: 'DELETE' });
  }
}

/** Read protected source afresh before every candidate mutation; never overwrite a retained stale candidate. */
export async function requireCurrentSource(api, config, source) {
  const branch = await api(`/branches/${encodeURIComponent(config.defaultBranch)}`);
  invariant(branch.protected === true && branch.commit?.sha === source, 'Protected source advanced or lost protection; reconcile the retained candidate.');
  return branch;
}

/** Validate only declared metadata files before writing a Git tree; no application code runs with write credentials. */
export function validateCandidateBundle(plan, bundle) {
  verifyPlan(plan);
  invariant(bundle?.schemaVersion === 1 && bundle.kind === 'expo-release-candidate' && bundle.planDigest === plan.digest
    && bundle.source === plan.source.commit && Array.isArray(bundle.files), 'Candidate does not belong to its reservation.');
  const allowed = new Set(plan.config.metadataFiles ?? []);
  for (const component of plan.components) {
    if (component.version) { allowed.add(component.version.file); for (const mirror of component.version.mirrors ?? []) allowed.add(mirror.file); }
  }
  for (const group of plan.config.versionGroups ?? []) {
    if (group.version) { allowed.add(group.version.file); for (const mirror of group.version.mirrors ?? []) allowed.add(mirror.file); }
  }
  const seen = new Set();
  for (const file of bundle.files) {
    validateArtifactPath(file.path);
    invariant(allowed.has(file.path) && !seen.has(file.path) && typeof file.content === 'string'
      && file.content.length < 20 * 1024 * 1024 && ['100644', '100755'].includes(file.mode), 'Candidate changed an undeclared metadata path.');
    invariant(!file.path.startsWith('.github/') && !file.path.startsWith('.git/'), 'Candidate cannot change its publication authority.');
    seen.add(file.path);
  }
  invariant(bundle.files.length <= 100, 'Candidate has too many metadata files.');
  return bundle;
}

/** Publish a new version-only branch or reuse the exact immutable candidate; never force a ref or push the default branch. */
export async function publishCandidate({ api, plan, bundle, ledger, releaseId }) {
  validateCandidateBundle(plan, bundle);
  const state = await ledger.read(releaseId);
  invariant(state.reservation.digest === plan.digest && state.release.draft, 'Candidate reservation is not pending.');
  await requireCurrentSource(api, plan.config, plan.source.commit);
  const existing = state.events.findLast(event => event.type === 'candidate');
  const bundleDigest = hashIdentity(bundle);
  if (existing) {
    invariant(existing.bundleDigest === bundleDigest, 'Cannot replace a retained candidate.');
    if (existing.branch) {
      const reference = await api(`/git/ref/heads/${existing.branch}`);
      invariant(reference.object.sha === existing.commit, 'Retained candidate branch moved.');
    }
    return existing;
  }
  if (!bundle.files.length) {
    const candidate = { type: 'candidate', commit: plan.source.commit, branch: '', pullNumber: null, bundleDigest };
    await ledger.append(releaseId, candidate);
    return candidate;
  }
  const parent = await api(`/git/commits/${plan.source.commit}`);
  const tree = [];
  for (const file of bundle.files) {
    const blob = await api('/git/blobs', { method: 'POST', body: { content: file.content, encoding: 'utf-8' } });
    tree.push({ path: file.path, mode: file.mode, type: 'blob', sha: blob.sha });
  }
  const result = await api('/git/trees', { method: 'POST', body: { base_tree: parent.tree.sha, tree } });
  const identity = { name: 'github-actions[bot]', email: '41898282+github-actions[bot]@users.noreply.github.com', date: parent.committer.date };
  const commit = await api('/git/commits', { method: 'POST', body: { message: `Prepare release ${plan.runId}`, tree: result.sha,
    parents: [plan.source.commit], author: identity, committer: identity } });
  const branch = `release/expo-${plan.runId}`;
  await requireCurrentSource(api, plan.config, plan.source.commit);
  let reference;
  try { reference = await api(`/git/ref/heads/${branch}`); } catch (error) { if (error.status !== 404) throw error; }
  invariant(!reference || reference.object.sha === commit.sha, 'Candidate branch already exists with different bytes.');
  if (!reference) await api('/git/refs', { method: 'POST', body: { ref: `refs/heads/${branch}`, sha: commit.sha } });
  const pulls = await api.pages(`/pulls?head=${encodeURIComponent(`${plan.source.repository.split('/')[0]}:${branch}`)}&base=${encodeURIComponent(plan.config.defaultBranch)}&state=all`);
  invariant(!pulls.some(pull => pull.merged_at || pull.head.sha !== commit.sha), 'Candidate pull request was merged or moved.');
  let pull = pulls.find(value => value.state === 'open');
  if (!pull) pull = await api('/pulls', { method: 'POST', body: { head: branch, base: plan.config.defaultBranch,
    title: `Prepare release ${plan.runId}`, body: 'Synchronize the reserved application version metadata. The shared release workflow validates this exact candidate and original source before requesting a protected merge.' } });
  const evidence = { type: 'candidate', commit: commit.sha, tree: result.sha, branch, pullNumber: pull.number, bundleDigest };
  await ledger.append(releaseId, evidence);
  return evidence;
}

/** Require the exact fixed shared validation jobs from the current attempt, including both original source and candidate. */
export async function verifyCandidateChecks({ api, plan, candidate, origin, workflowCommit = plan.source.workflowCommit,
  toolkitCommit = plan.source.toolkitCommit, allowCompleted = false }) {
  const run = await verifyProducer(api, plan.config, origin, workflowCommit);
  invariant((run.status === 'in_progress' || allowCompleted && run.status === 'completed') && String(run.id) === String(origin.runId)
    && run.run_attempt === Number(origin.runAttempt), 'Validation must belong to the exact trusted run attempt.');
  const reference = (run.referenced_workflows ?? []).find(workflow => workflow.path?.startsWith('MChartier/expo-release-template/.github/workflows/release-handler.yml@'));
  invariant(reference?.sha === toolkitCommit, 'Trusted run does not reference the validated toolkit revision.');
  const inventory = []; const seen = new Set(); let total;
  for (let page = 1; page <= 100; page++) {
    const response = await api(`/actions/runs/${origin.runId}/jobs?filter=latest&per_page=100&page=${page}`);
    total ??= response.total_count;
    invariant(Number.isSafeInteger(total) && total >= 0 && total <= 10000 && response.total_count === total
      && Array.isArray(response.jobs) && response.jobs.length <= 100, 'Invalid or changing validation job inventory.');
    for (const job of response.jobs) {
      invariant(Number.isSafeInteger(job.id) && !seen.has(job.id), 'Repeated or invalid validation job identity.');
      seen.add(job.id); inventory.push(job);
    }
    if (inventory.length === total) break;
    invariant(inventory.length < total && response.jobs.length === 100, 'Incomplete validation job inventory.');
  }
  invariant(inventory.length === total, 'Validation job inventory exceeds its bound.');
  const required = ['source', 'candidate'].map(role => `Release validation (${role})`);
  for (const name of required) {
    const jobs = inventory.filter(job => job.name === name || job.name.endsWith(` / ${name}`));
    invariant(jobs.length === 1 && jobs[0].status === 'completed' && jobs[0].conclusion === 'success'
      && Number(jobs[0].run_attempt) > 0 && Number(jobs[0].run_attempt) <= Number(origin.runAttempt), `Exact ${name} validation did not succeed.`);
  }
  if (candidate.branch) {
    const current = await api(`/git/commits/${candidate.commit}`);
    invariant(current.parents.length === 1 && current.parents[0].sha === plan.source.commit && current.tree.sha === candidate.tree, 'Validated candidate ancestry or tree changed.');
  } else invariant(candidate.commit === plan.source.commit, 'Unmodified candidate differs from the requested source.');
  return { candidateAttempt: inventory.find(job => job.name === 'Release validation (candidate)' || job.name.endsWith(' / Release validation (candidate)')).run_attempt };
}

/** Merge only through the protected PR API with exact-head locking and pre/post merge-parent/tree verification. */
export async function finalizeCandidate({ api, plan, candidate, origin, ledger, releaseId,
  workflowCommit = plan.source.workflowCommit, toolkitCommit = plan.source.toolkitCommit }) {
  const validation = { api, plan, candidate, origin, workflowCommit, toolkitCommit };
  if (!candidate.branch) {
    await requireCurrentSource(api, plan.config, plan.source.commit);
    await verifyCandidateChecks(validation);
    return candidate.commit;
  }
  const pull = await api(`/pulls/${candidate.pullNumber}`);
  const matches = value => value.parents.length === 2 && value.parents[0].sha === plan.source.commit
    && value.parents[1].sha === candidate.commit && value.tree.sha === candidate.tree;
  if (pull.merged) {
    const state = await ledger.read(releaseId);
    const intent = state.events.findLast(event => event.type === 'merge-intent' && event.candidate === candidate.commit && event.tree === candidate.tree);
    invariant(intent && pull.head.sha === candidate.commit && pull.head.ref === candidate.branch
      && pull.base.ref === plan.config.defaultBranch && pull.head.repo?.full_name === plan.source.repository
      && sha(pull.merge_commit_sha), 'Merged candidate has no original exact validated merge intent.');
    await verifyCandidateChecks({ ...validation, origin: intent.validation.origin, workflowCommit: intent.validation.workflowCommit,
      toolkitCommit: intent.validation.toolkitCommit, allowCompleted: true });
    invariant(matches(await api(`/git/commits/${pull.merge_commit_sha}`)), 'Recovered merge ancestry/tree differs.');
    const branch = await api(`/branches/${encodeURIComponent(plan.config.defaultBranch)}`);
    const ancestry = await api(`/compare/${pull.merge_commit_sha}...${branch.commit.sha}`);
    invariant(branch.protected === true && ['ahead', 'identical'].includes(ancestry.status)
      && ancestry.merge_base_commit?.sha === pull.merge_commit_sha, 'Recovered merge left protected branch history.');
    return pull.merge_commit_sha;
  }
  await requireCurrentSource(api, plan.config, plan.source.commit);
  invariant(pull.state === 'open' && !pull.draft && pull.head.repo?.full_name === plan.source.repository
    && pull.head.ref === candidate.branch && pull.head.sha === candidate.commit && pull.base.ref === plan.config.defaultBranch
    && pull.base.sha === plan.source.commit && sha(pull.merge_commit_sha), 'Candidate PR no longer identifies the validated source.');
  const preparedMerge = await api(`/git/commits/${pull.merge_commit_sha}`);
  invariant(matches(preparedMerge), 'Prepared merge parents/tree differ from validation.');
  await verifyCandidateChecks(validation);
  await ledger.append(releaseId, { type: 'merge-intent', candidate: candidate.commit, tree: candidate.tree,
    validation: { origin, workflowCommit, toolkitCommit } });
  await requireCurrentSource(api, plan.config, plan.source.commit);
  const merged = await api(`/pulls/${candidate.pullNumber}/merge`, { method: 'PUT', body: { sha: candidate.commit, merge_method: 'merge' } });
  invariant(merged.merged === true && sha(merged.sha), 'Protected candidate merge was refused.');
  invariant(matches(await api(`/git/commits/${merged.sha}`)), 'Merged ancestry/tree differs; publication is blocked.');
  await ledger.append(releaseId, { type: 'merged', candidate: candidate.commit, mergeCommit: merged.sha, tree: candidate.tree });
  return merged.sha;
}
