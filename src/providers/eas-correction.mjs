/** @file Audited correction of rejected EAS destinations without changing sealed destinations or original artifact evidence. */
import { invariant } from '../../packages/release-engine/index.mjs';
import { createEasSubmissionProvider, verifyEasSubmission } from './eas.mjs';

/** Verify the rejected request and identical bytes; correction can only restore the already authorized Play destination. */
export async function verifyEasDestinationCorrection({ value, operation, spec, transport }) {
  invariant(spec.platform === 'android' && value?.confirmed === true && value.reason?.trim().length >= 20 && value.reason.length <= 2000
    && operation?.operationId && value.operationId === operation.operationId && value.artifactSha256 === spec.artifact.sha256
    && typeof value.from === 'string' && value.from.length > 0 && value.from !== value.to && value.to === spec.destination.track,
  'Correction must identify the rejected destination, provider ID, retained bytes and explicit no-publication evidence; its destination must remain the sealed destination.');
  const raw = await transport.getSubmission(operation.operationId);
  invariant(raw.id === operation.operationId, 'Rejected submission readback ID differs.');
  verifyEasSubmission(raw, { ...spec, destination: { ...spec.destination, track: value.from } });
  invariant(raw.status === 'ERRORED' && raw.archiveUrl
    && await transport.hashArtifact(raw.archiveUrl) === spec.artifact.sha256, 'Original rejection does not prove these exact retained bytes.');
  return { ...value, kind: 'destination-correction', providerStatus: raw.status };
}

/** Append-only reconciliation authorizes a separate explicit retry, with fresh rejection proof immediately before enqueue. */
export function createCorrectableEasSubmissionProvider({ spec, transport, operation }) {
  const base = createEasSubmissionProvider(spec, transport);
  const correction = operation?.proof?.kind === 'destination-correction' ? operation.proof : null;
  const verify = value => verifyEasDestinationCorrection({ value, operation, spec, transport });
  return { ...base,
    async reconcileDestination(value) { return verify(value); },
    ...(correction ? {
      async status(id) { return id === correction.operationId ? { id, status: 'failed', correction: true } : base.status(id); },
      async verify(value, context) { return value.correction ? verify(correction) : base.verify(value, context); },
      async prepareRetry(value, context) {
        return value.id === correction.operationId ? { mode: 'new-request', proof: await verify(correction) } : base.prepareRetry(value, context);
      },
      async start(context) {
        invariant(context.retry?.mode === 'new-request', 'A corrected upload requires its exact explicit retry.');
        await verify(correction);
        return base.start({ ...context, retry: undefined, previousIds: [...(context.previousIds ?? []), correction.operationId] });
      }
    } : {}) };
}
