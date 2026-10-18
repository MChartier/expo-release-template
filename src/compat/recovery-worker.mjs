/** @file Fixed historical-format recovery routing keeps original evidence and provider credentials in their own workers. */
import { hashIdentity, invariant } from '../../packages/release-engine/index.mjs';
import { configuredComponents } from '../planner.mjs';
import { routeCalibrateRecovery, continueCalibrateRelease } from './calibrate-recovery.mjs';
import { routeLittleSayRecovery, continueLittleSayRelease } from './little-say-continuation.mjs';
import { createLittleSayRecoveryAdapter } from './little-say-recovery.mjs';

/** Choose one supported provider/approval boundary using only the authenticated original record and current configuration. */
export function routeLegacyRecovery(state, request, config) {
  invariant(state.legacy && !state.resolved && state.release.draft && (!request.planDigest || request.planDigest === hashIdentity(state.legacyPlan)),
    'Historical recovery requires its exact unresolved original plan.');
  if (state.recovery.format === 'calibrate-v1') return routeCalibrateRecovery(state, request, config);
  invariant(state.recovery.format === 'little-say', 'Unsupported original recovery contract.');
  if (['resume', 'retry'].includes(request.action)) return routeLittleSayRecovery(state, request, config);
  invariant(['reconcile', 'complete', 'abandon'].includes(request.action), 'Unsupported historical action.');
  const approvals = [...new Set(configuredComponents(config, state.legacyPlan.profile).map(value => value.approvalEnvironment).filter(Boolean))];
  invariant(approvals.length <= 1, 'Inspect stages under their individual approvals before finalizing this original release.');
  return { provider: 'audit', approval: approvals[0] ?? '', stage: request.stage ?? '' };
}

/** Execute exactly the routed legacy action; authorization alone never constitutes successful recovery. */
export async function executeLegacyRecovery({ ledger, releaseId, request, provider, approval, environment = process.env }) {
  const state = await ledger.read(releaseId); const route = routeLegacyRecovery(state, request, ledger.config);
  invariant(route.provider === provider && route.approval === approval, 'Historical worker credential/approval boundary differs from its request.');
  if (state.recovery.format === 'calibrate-v1') return continueCalibrateRelease({ ledger, releaseId, request, environment });
  if (['resume', 'retry'].includes(request.action)) return continueLittleSayRelease({ ledger, releaseId, stage: request.stage,
    retry: request.action === 'retry', environment });
  return createLittleSayRecoveryAdapter().recover({ ledger, state, request });
}
