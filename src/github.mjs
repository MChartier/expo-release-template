/** @file GitHub's native tags, deployments and release assets provide the small durable release record. */
import { assert, compareVersions } from './engine.mjs';
const prefix = 'expo-release/v3/';

/** Create an authenticated GitHub client; writes are single-attempt and never automatically retried. */
export function github(repository, { token = process.env.GITHUB_TOKEN, fetcher = fetch } = {}) {
  const base = `https://api.github.com/repos/${repository}`;
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  const api = async (method, route, body) => {
    const response = await fetcher(`${base}/${route}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    assert(response.ok, `GitHub ${method} ${route.split('?')[0]} failed (${response.status}); do not repeat an uncertain write.`);
    return response.status === 204 ? null : response.json();
  };
  const pages = async route => {
    const values = [];
    for (let page = 1; page <= 1000; page++) {
      const batch = await api('GET', `${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      assert(Array.isArray(batch), 'GitHub list response is not an array.');
      values.push(...batch);
      if (batch.length < 100) return values;
    }
    throw new Error('Release history exceeds the supported GitHub pagination bound.');
  };
  return { api, pages,
    /** Upload a new evidence asset; duplicate names fail rather than replacing prior evidence. */
    async evidence(releaseId, name, value) {
      const response = await fetcher(`https://uploads.github.com/repos/${repository}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`,
        { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
      assert(response.ok, `Cannot retain release evidence (${response.status}); resolve before retrying.`);
      return response.json();
    },
  };
}

/** Reduce current-format records without making failed runs erase other targets' successes. */
export function historyFrom(records, deployments) {
  const history = { baselines: {}, pending: [] };
  const pairCodeFloor = Math.max(0, ...records.map(record => record.pairCodeFloor ?? 0));
  for (const record of records) {
    assert(record.format === 3 && record.source && record.run, 'Legacy or malformed release reservation.');
    for (const kind of ['server', 'mobile']) if (record.versions?.[kind]
      && (!history[kind] || compareVersions(record.versions[kind], history[kind].version) > 0)) {
      history[kind] = { version: record.versions[kind], family: record.family, pairCodeFloor: record.pairCodeFloor ?? 0 };
    }
  }
  if (history.mobile) history.mobile.pairCodeFloor = pairCodeFloor;
  // GitHub returns newest deployments first; never substitute a workflow conclusion for target status.
  for (const { payload, state } of deployments) {
    assert(payload?.format === 3 && typeof payload.key === 'string', 'Legacy or malformed deployment record.');
    if (!['success', 'failure'].includes(state)) history.pending.push(payload.key);
    if (state !== 'success' || history.baselines[payload.key]) continue;
    history.baselines[payload.key] = payload;
    if (payload.bundleKey && !history.baselines[payload.bundleKey]) history.baselines[payload.bundleKey] = { ...payload, input: payload.bundleInput };
    const jsKey = payload.bundleKey?.replace('/bundle/', '/js/') ?? (payload.key.includes('/ota/') ? payload.key.replace('/ota/', '/js/') : null);
    if (jsKey && !history.baselines[jsKey]) history.baselines[jsKey] = { ...payload, input: payload.bundleInput ?? payload.input };
  }
  return history;
}

/** Read immutable reservations and current deployment status using ordinary GitHub APIs. */
export async function loadHistory(client) {
  const refs = await client.api('GET', `git/matching-refs/tags/${prefix}run/`);
  const records = [];
  for (const ref of refs) {
    assert(ref.object.type === 'tag', 'Release reservations must be annotated tags.');
    const tag = await client.api('GET', `git/tags/${ref.object.sha}`);
    records.push(JSON.parse(tag.message));
  }
  const deployments = [];
  for (const deployment of await client.pages('deployments?task=expo-release-v3')) {
    const statuses = await client.api('GET', `deployments/${deployment.id}/statuses?per_page=1`);
    deployments.push({ ...deployment, state: statuses[0]?.state ?? 'pending' });
  }
  return historyFrom(records, deployments);
}

/** Reserve tags and an evidence container before any provider request; never replace existing refs. */
export async function reserve(client, plan) {
  const record = { format: 3, source: plan.source, build: plan.build, run: plan.run, toolkit: plan.toolkit,
    versions: plan.versions, family: plan.observation.family, pairCodeFloor: plan.pair?.[1] ?? 0 };
  const names = [`${prefix}run/${plan.run}`,
    ...(plan.bump ? [`${prefix}mobile/v${plan.versions.mobile}`] : []),
    ...(plan.server ? [`${prefix}server/v${plan.versions.server}`] : [])];
  for (const name of names) {
    const tag = await client.api('POST', 'git/tags', { tag: name, message: JSON.stringify(record), object: plan.build, type: 'commit' });
    await client.api('POST', 'git/refs', { ref: `refs/tags/${name}`, sha: tag.sha });
  }
  const release = await client.api('POST', 'releases', { tag_name: names[0], name: `Release ${plan.versions.mobile ?? plan.versions.server} · ${plan.profile}`,
    body: `Source: ${plan.source}\nBuild: ${plan.build}\nRun: https://github.com/${plan.repository}/actions/runs/${plan.run}`,
    draft: false, prerelease: true, make_latest: 'false' });
  await client.evidence(release.id, 'plan.json', plan);
  return release.id;
}

/** Describe one fixed operation, including enough input identity to advance only its own baseline. */
export function operationPayload(plan, operation) {
  const [kind, id] = operation.split('/');
  const target = plan.config.mobile?.targets.find(t => t.id === id);
  const platform = target?.platform ?? id;
  return { format: 3, key: `${plan.profile}/${operation}`, source: plan.source, build: plan.build, run: plan.run,
    toolkit: plan.toolkit, runtime: plan.runtime, version: target || kind === 'ota' ? plan.versions.mobile : plan.versions.server,
    input: id === 'server' ? plan.observation.server : plan.observation.js[platform],
    fingerprint: plan.observation.fingerprints[plan.profile]?.[platform] ?? null,
    ...(kind === 'build' ? { bundleKey: `${plan.profile}/bundle/${platform}`, bundleInput: plan.observation.js[platform] } : {}),
    destination: id === 'server' ? plan.config.server.image : target?.applicationId ?? plan.config.profiles[plan.profile].channel };
}

/** Record intent before calling a provider; any prior unresolved request requires operator resolution. */
export async function begin(client, plan, operation) {
  const payload = operationPayload(plan, operation);
  const previous = await client.pages(`deployments?task=expo-release-v3&environment=${encodeURIComponent(payload.key)}`);
  for (const deployment of previous) {
    const statuses = await client.api('GET', `deployments/${deployment.id}/statuses?per_page=1`);
    const state = statuses[0]?.state ?? 'pending';
    assert(['success', 'failure'].includes(state) && deployment.payload?.run !== plan.run,
      `Operation ${payload.key} was already attempted or is unresolved. Inspect GitHub and the provider; automatic retry is disabled.`);
  }
  const deployment = await client.api('POST', 'deployments', { ref: plan.build, task: 'expo-release-v3', auto_merge: false,
    required_contexts: [], environment: payload.key, production_environment: plan.config.profiles[plan.profile].environment === 'production', payload });
  assert(Number.isSafeInteger(deployment.id), 'GitHub did not return a deployment ID.');
  return deployment.id;
}

/** Retain evidence before marking success; a missing acknowledgement remains unresolved. */
export async function complete(client, plan, operation, deploymentId, result) {
  const release = await client.api('GET', `releases/tags/${prefix}run/${plan.run}`);
  await client.evidence(release.id, `${operation.replaceAll('/', '-')}.json`, { ...operationPayload(plan, operation), deploymentId, result });
  await client.api('POST', `deployments/${deploymentId}/statuses`, { state: 'success', auto_inactive: false,
    log_url: `https://github.com/${plan.repository}/actions/runs/${plan.run}`, description: 'Provider operation completed; immutable evidence retained.' });
}
