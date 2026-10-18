/** @file Bounded GitHub transport shared by release records, trusted requests and protected candidate publication. */
import { invariant } from '../packages/release-engine/index.mjs';

/** Create a repository-scoped API client that never forwards credentials to asset-download redirects. */
export function githubClient({ repository, token = process.env.GITHUB_TOKEN, request = fetch }) {
  invariant(/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') && token, 'GitHub repository and token are required.');
  const api = async (route, { method = 'GET', body, raw = false, upload = false } = {}) => {
    invariant(route.startsWith('/') && !/(?:^|\/)\.\.(?:\/|$)/.test(route) && !route.includes('://'), 'Invalid GitHub repository route.');
    const base = upload ? 'https://uploads.github.com' : 'https://api.github.com';
    let response = await request(`${base}/repos/${repository}${route}`, {
      method, redirect: 'manual', signal: AbortSignal.timeout(120000),
      headers: { Authorization: `Bearer ${token}`, Accept: raw ? 'application/octet-stream' : 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28', 'Content-Type': upload ? 'application/octet-stream' : 'application/json' },
      body: body === undefined ? undefined : upload ? body : JSON.stringify(body)
    });
    if (raw && method === 'GET' && response.status === 302) {
      const destination = new URL(response.headers.get('location'));
      invariant(destination.protocol === 'https:' && !destination.username && !destination.password
        && ['release-assets.githubusercontent.com', 'objects.githubusercontent.com'].includes(destination.hostname), 'Unexpected artifact download origin.');
      response = await request(destination.href, { redirect: 'error', signal: AbortSignal.timeout(120000) });
    }
    if (!response.ok) {
      const error = new Error(`GitHub ${method} ${route.split('?')[0]} failed (${response.status}).`);
      error.status = response.status;
      throw error;
    }
    return response.status === 204 ? null : raw ? Buffer.from(await response.arrayBuffer()) : response.json();
  };
  api.pages = async route => {
    const values = [];
    for (let page = 1; page <= 100; page += 1) {
      const result = await api(`${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      invariant(Array.isArray(result), 'Expected a paginated GitHub array.');
      values.push(...result);
      if (result.length < 100) return values;
    }
    throw new Error('GitHub pagination exceeded the bounded lookup limit.');
  };
  return api;
}

/** Authorize an originating Actions run separately from application and shared-toolkit commit identities. */
export async function verifyProducer(api, config, origin, workflowCommit) {
  invariant(origin?.kind === 'github' && /^[1-9]\d*$/.test(String(origin.runId)), 'Hosted producer evidence is required.');
  const run = await api(`/actions/runs/${origin.runId}`);
  const allowed = [config.github?.handlerWorkflow].filter(Boolean).map(file => `.github/workflows/${file}`);
  invariant(run.repository?.full_name === config.repository && run.head_branch === config.defaultBranch
    && run.head_sha === workflowCommit && allowed.includes(run.path) && run.event === 'workflow_run'
    && Number.isSafeInteger(Number(origin.runAttempt)) && Number(origin.runAttempt) > 0
    && Number(origin.runAttempt) <= run.run_attempt, 'Release evidence does not belong to an authorized producer.');
  return run;
}
