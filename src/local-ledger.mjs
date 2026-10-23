/** @file Explicitly local publication history in GitHub Releases; it can reserve used codes but never supply hosted provenance. */
import { randomUUID } from 'node:crypto';
import { invariant, verifyPlan } from '../packages/release-engine/index.mjs';
import { GitHubLedger } from './ledger.mjs';

/** Read local records under their own original uploader identity, without inventing an Actions producer. */
export async function readLocalPlan({ release, record, assets, api }) {
  const plan = verifyPlan(record);
  invariant(plan.origin.kind === 'local' && !plan.source.workflowCommit && release.tag_name === `expo-local-${plan.digest}`
    && release.author?.login, 'Invalid local publication ledger.');
  const events = [];
  for (const asset of assets.filter(item => /^event-[\w-]+\.json$/.test(item.name)).sort((a, b) => a.id - b.id)) {
    invariant(asset.size < 1024 * 1024 && asset.uploader?.login === release.author.login, 'Local event uploader differs from its original operator.');
    const event = JSON.parse(await api(`/releases/assets/${asset.id}`, { raw: true }));
    invariant(event.schemaVersion === 1 && event.origin?.kind === 'local' && !event.workflowCommit && event.planDigest === plan.digest,
      'Local evidence cannot claim a hosted producer or another plan.');
    events.push({ ...event, assetId: asset.id });
  }
  return { local: true, release, plan, reservation: plan, events, assets };
}

/** Retain local provider operations durably; this implementation intentionally has no artifact-attestation capability. */
export class LocalLedger extends GitHubLedger {
  async begin(plan) {
    verifyPlan(plan, { repository: this.config.repository });
    invariant(plan.origin.kind === 'local' && plan.operation === 'submit' && plan.localBuild, 'Local ledger accepts only an explicit retained local submission.');
    const tag = `expo-local-${plan.digest}`;
    const existing = (await this.list()).find(value => value.tag_name === tag);
    if (existing) { invariant((await this.read(existing.id)).plan.digest === plan.digest, 'Local publication plan changed.'); return existing; }
    return this.api('/releases', { method: 'POST', body: { tag_name: tag, target_commitish: plan.source.commit,
      name: `Local internal submission ${plan.source.commit.slice(0, 12)}`, body: JSON.stringify(plan), draft: true, prerelease: true } });
  }

  async append(id, event) {
    const state = await this.read(id);
    invariant(state.local && state.release.draft, 'Local operations cannot append to hosted or finalized history.');
    const value = { ...event, schemaVersion: 1, planDigest: state.plan.digest, origin: { kind: 'local' } };
    invariant(!value.workflowCommit, 'Local events cannot claim a producing workflow.');
    return this.upload(id, `event-${randomUUID()}.json`, Buffer.from(`${JSON.stringify(value)}\n`));
  }
}
