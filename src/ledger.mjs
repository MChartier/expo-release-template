/** @file Append-only release records and exact artifact retention; local caches never become hosted publication authority. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { hashIdentity, invariant, verifyPlan, summarizeRelease } from '../packages/release-engine/index.mjs';
import { completedBaseline } from './planner.mjs';
import { githubClient, verifyProducer } from './github.mjs';
import { repositoryPath } from './config.mjs';
import { compareSemver } from './semver.mjs';

/** Persist immutable common plans and ordered events in run-scoped draft GitHub releases. */
export class GitHubLedger {
  constructor({ config, api, token, request, origin, workflowCommit, legacyReaders = [] }) {
    this.config = config;
    this.api = api ?? githubClient({ repository: config.repository, token, request });
    this.origin = origin;
    this.workflowCommit = workflowCommit;
    this.legacyReaders = legacyReaders;
  }

  /** Find all new and configured legacy journals; unfinished history blocks another release. */
  async list() {
    const prefixes = ['expo-release-', 'expo-local-', ...(this.config.legacy?.prefixes ?? ['release-run-'])];
    return (await this.api.pages('/releases')).filter(release => prefixes.some(prefix => release.tag_name.startsWith(prefix)))
      .sort((a, b) => b.id - a.id);
  }

  /** Verify the immutable record and each event's original producer before exposing outcomes. */
  async read(id) {
    invariant(/^[1-9]\d*$/.test(String(id)), 'A numeric release ID is required.');
    const release = await this.api(`/releases/${id}`);
    let record = null;
    try { record = JSON.parse(release.body); } catch { /* Historical ledgers may keep their plan in an immutable asset. */ }
    const assets = await this.api.pages(`/releases/${id}/assets`);
    if (record?.kind !== 'expo-release-plan') {
      const reader = this.legacyReaders.find(item => item.matches(record, release, this.config));
      invariant(reader, 'Unsupported historical release record.');
      return reader.read({ release, record, assets, api: this.api, config: this.config });
    }
    const reservation = verifyPlan(record, { repository: this.config.repository });
    if (reservation.origin.kind === 'local') {
      const { readLocalPlan } = await import('./local-ledger.mjs');
      return readLocalPlan({ release, record, assets, api: this.api });
    }
    let plan = reservation;
    invariant(release.tag_name === `expo-release-${plan.runId}`, 'Release tag and plan identity differ.');
    await verifyProducer(this.api, this.config, plan.origin, plan.source.workflowCommit);
    const events = [];
    const runs = new Set();
    for (const asset of assets.filter(item => /^event-[\w-]+\.json$/.test(item.name)).sort((a, b) => a.id - b.id)) {
      invariant(asset.size < 1024 * 1024 && asset.uploader?.login === 'github-actions[bot]', 'Untrusted or oversized release event.');
      const event = JSON.parse(await this.api(`/releases/assets/${asset.id}`, { raw: true }));
      invariant(event.schemaVersion === 1 && event.planDigest === reservation.digest, 'Release event belongs to another plan.');
      const producerKey = hashIdentity({ origin: event.origin, workflowCommit: event.workflowCommit });
      if (!runs.has(producerKey)) await verifyProducer(this.api, this.config, event.origin, event.workflowCommit);
      runs.add(producerKey);
      if (event.type === 'prepared') {
        const prepared = verifyPlan(event.plan, { repository: plan.source.repository, workflowCommit: reservation.source.workflowCommit, toolkitCommit: reservation.source.toolkitCommit });
        invariant(prepared.prepared === true && prepared.reservationDigest === reservation.digest
          && hashIdentity(prepared.config) === hashIdentity(reservation.config), 'Prepared evidence changed its reservation/configuration.');
        invariant(plan === reservation || plan.digest === prepared.digest, 'Conflicting prepared source evidence.');
        plan = prepared;
      }
      events.push({ ...event, assetId: asset.id });
    }
    return { release, plan, reservation, events, assets };
  }

  /** Reserve only the exact plan authorized by this hosted run; callers serialize release writers. */
  async begin(plan) {
    verifyPlan(plan, { repository: this.config.repository });
    invariant(plan.origin.kind === 'github' && String(plan.origin.runId) === String(this.origin?.runId)
      && plan.source.workflowCommit === this.workflowCommit, 'Only the producing hosted run may reserve a release.');
    await verifyProducer(this.api, this.config, this.origin, this.workflowCommit);
    const existing = await this.list();
    const tag = `expo-release-${plan.runId}`;
    for (const release of existing.filter(value => value.draft && value.tag_name !== tag)) {
      const previous = await this.read(release.id);
      invariant(previous.local || previous.legacy && previous.resolved === true, 'An unfinished release must be resolved before reserving another.');
    }
    const same = existing.find(release => release.tag_name === tag);
    if (same) {
      invariant((await this.read(same.id)).plan.digest === plan.digest, 'Cannot replace a reserved plan.');
      return same;
    }
    return this.api('/releases', { method: 'POST', body: { tag_name: tag, target_commitish: plan.source.commit,
      name: `Release ${plan.runId}`, body: JSON.stringify(plan), draft: true, prerelease: false } });
  }

  /** Append one durable event before continuing an external side effect. */
  async append(id, event) {
    const state = await this.read(id);
    invariant(!state.local && state.release.draft, 'Hosted operations cannot append to local or finalized history.');
    await verifyProducer(this.api, this.config, this.origin, this.workflowCommit);
    const value = { ...event, schemaVersion: 1, planDigest: state.plan.digest,
      origin: this.origin, workflowCommit: this.workflowCommit };
    value.planDigest = state.reservation?.digest ?? state.plan.digest;
    return this.upload(id, `event-${randomUUID()}.json`, Buffer.from(`${JSON.stringify(value)}\n`));
  }

  /** Close a fully observed release or an explicitly abandoned, unambiguous attempt; reservations always survive. */
  async finish(id, { abandon = false } = {}) {
    const state = await this.read(id);
    invariant(!state.legacy, 'Historical completion must use its compatibility contract.');
    if (!state.release.draft) {
      const previous = state.events.findLast(event => event.type === 'completion')?.completion;
      invariant(previous?.planDigest === state.plan.digest && (abandon ? previous.status === 'abandoned' : ['complete', 'noop'].includes(previous.status)),
        'Finalized release differs from the requested completion.');
      return previous;
    }
    const receipts = state.events.filter(event => state.plan.stages[event.stage]);
    const summary = summarizeRelease(state.plan.graph, receipts);
    if (abandon) {
      invariant(state.release.draft, 'Only pending releases may be abandoned.');
      for (const stage of summary.remaining) {
        const current = receipts.findLast(event => event.stage === stage);
        invariant(!['intent', 'accepted', 'unknown'].includes(current?.status), `Reconcile ${stage} before abandonment.`);
      }
      invariant(!state.events.some(event => event.type === 'prepared') || !state.plan.components.some(component => component.selected && component.kind === 'server'
        && !summary.completedComponents.includes(component.id)), 'Publish the merged server release before abandonment.');
    } else invariant(['complete', 'noop'].includes(summary.status), `Release remains ${summary.status}: ${summary.remaining.join(', ')}.`);
    const completion = { schemaVersion: 1, kind: 'expo-release-completion', status: abandon ? 'abandoned' : summary.status,
      planDigest: state.plan.digest, origin: state.plan.origin, summary,
      baseline: state.local ? { components: {}, runtimes: {}, reservations: state.plan.reservations } : completedBaseline(state.plan, receipts) };
    await this.append(id, { type: 'completion', completion });
    await this.api(`/releases/${id}`, { method: 'PATCH', body: { draft: false, target_commitish: state.plan.source.commit, make_latest: 'false' } });
    return completion;
  }

  /** Read the newest resolved ledger baseline; a pending record is never silently skipped. */
  async baseline() {
    const records = await this.list();
    const baseline = { components: {}, runtimes: {}, reservations: {} };
    for (const record of [...records].reverse()) {
      const state = await this.read(record.id);
      const completion = state.events?.findLast(event => event.type === 'completion')?.completion;
      const resolved = state.local || (state.legacy ? state.resolved === true : !record.draft && completion && ['complete', 'noop', 'abandoned'].includes(completion.status));
      invariant(resolved, 'An unfinished release must be recovered before planning another release.');
      const previous = state.local ? { reservations: state.plan.reservations } : state.legacy ? state.baseline : completion.baseline;
      invariant(previous, 'Historical baseline is unavailable.');
      Object.assign(baseline.components, previous.components ?? {});
      Object.assign(baseline.runtimes, previous.runtimes ?? {});
      for (const [id, reservation] of Object.entries(previous.reservations ?? {})) {
        const current = baseline.reservations[id] ?? {};
        const codes = { ...current.codes };
        for (const [target, code] of Object.entries(reservation.codes ?? {})) codes[target] = Math.max(codes[target] ?? 0, code);
        baseline.reservations[id] = { ...current, ...reservation, codes,
          ...(current.version && reservation.version ? { version: compareSemver(current.version, reservation.version) > 0 ? current.version : reservation.version } : {}) };
      }
    }
    return baseline;
  }

  /** Retain immutable bytes and reject a conflicting retry under the same name. */
  async upload(id, name, bytes) {
    invariant(/^[A-Za-z0-9][A-Za-z0-9._-]{0,180}$/.test(name), 'Invalid retained artifact name.');
    const assets = await this.api.pages(`/releases/${id}/assets`);
    const existing = assets.find(asset => asset.name === name);
    if (existing) {
      const retained = await this.api(`/releases/assets/${existing.id}`, { raw: true });
      invariant(Buffer.compare(retained, bytes) === 0, 'Retained artifact already exists with different bytes.');
      return existing;
    }
    return this.api(`/releases/${id}/assets?name=${encodeURIComponent(name)}`, { method: 'POST', upload: true, body: bytes });
  }

  /** Restore one exact artifact after hash verification, without executing any artifact contents. */
  async download(asset, digest, destination) {
    const bytes = await this.api(`/releases/assets/${asset.id}`, { raw: true });
    invariant(/^[a-f0-9]{64}$/.test(digest) && createHash('sha256').update(bytes).digest('hex') === digest, 'Retained artifact hash differs.');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
  }
}

/** Record local build evidence in an ignored cache with an explicit, non-hosted origin. */
export function writeLocalReceipt(root, plan, artifacts) {
  verifyPlan(plan);
  invariant(plan.origin.kind === 'local', 'Local receipts cannot claim hosted provenance.');
  const receipt = { schemaVersion: 1, kind: 'expo-local-artifacts', origin: plan.origin,
    source: plan.source, planDigest: plan.digest, plan, artifacts };
  const file = repositoryPath(root, `.release/artifacts-${plan.digest}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`);
  return { file, receipt };
}
