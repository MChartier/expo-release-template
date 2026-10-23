/** @file Durable provider execution: intent precedes mutation and interrupted outcomes require verified reconciliation. */
import { invariant, reduceOperation } from '../packages/release-engine/index.mjs';

/** Return a stage's latest operation without falling back to earlier success. */
export function latestOperation(events, stage) {
  return events.findLast(event => event.stage === stage && event.operation)?.operation ?? null;
}

/** Read and verify one exact provider result for execution or explicit reconciliation; an empty search proves nothing. */
export async function observeProvider({ provider, operation, context, operationId = operation.operationId }) {
  invariant(operationId || provider.find, 'Provider has no automatic reconciliation transport.');
  const observed = operationId ? await provider.status(operationId, context)
    : await provider.find({ ...context, previousIds: (operation.history ?? []).map(item => item.operationId).filter(Boolean) });
  invariant(observed, 'No unique provider result; absence from a search does not authorize another request.');
  invariant(!operationId || observed.id === operationId, 'Provider observation differs from the retained operation ID.');
  const proof = await provider.verify(observed, { ...context, observe: true });
  invariant(proof && typeof proof === 'object' && Object.keys(proof).length, 'Provider verification returned no evidence.');
  return { observed, proof };
}

/** Translate verified readback into the same durable transitions for execution and recovery. */
export function observationTransitions(operation, observed, proof) {
  if (operation.status === 'failed') invariant(observed.status === 'failed', 'A terminal provider observation conflicts with the retained failure.');
  const events = operation.status === 'unknown' && observed.id ? [{ type: 'accepted', operationId: observed.id, proof }] : [];
  if (observed.status === 'complete') events.push({ type: 'complete', receipt: proof, proof });
  else if (observed.status === 'failed') events.push({ type: 'failed', definitive: true, reason: observed.reason ?? 'Provider reported terminal failure.', proof });
  else if (observed.status === 'unknown') events.push({ type: 'unknown', reason: 'Provider cannot establish the current operation outcome.' });
  else {
    invariant(observed.status === 'accepted', 'Unsupported provider observation status.');
    events.push({ type: 'observed', proof });
  }
  return events;
}

/** Execute or observe one operation; retries require an explicit request and fresh provider authorization. */
export async function executeOperation({ ledger, releaseId, stage, provider, context, retry = false }) {
  let operation = latestOperation((await ledger.read(releaseId)).events, stage);
  const save = async event => {
    operation = reduceOperation(operation, event);
    await ledger.append(releaseId, { stage, status: operation.status, operation, transition: event });
  };
  if (operation?.status === 'complete') return operation;
  let start = operation === null;
  let retryAuthorization;
  if (operation?.status === 'intent') await save({ type: 'unknown', reason: 'An earlier request was interrupted after durable intent.' });
  if (operation?.status === 'failed') {
    invariant(retry, 'A failed operation requires explicit retry and fresh provider evidence.');
    let proof;
    if (operation.operationId) {
      invariant(provider.prepareRetry, 'Provider cannot authorize retry.');
      const observed = await provider.status(operation.operationId, context);
      proof = await provider.verify(observed, { ...context, observe: true });
      retryAuthorization = await provider.prepareRetry(observed, context);
    } else {
      invariant(provider.verifyAbsence && (context.reconciliation || operation.proof), 'Retry requires fresh verified absence evidence.');
      proof = await provider.verifyAbsence(context.reconciliation ?? operation.proof,
        { ...context, operationKey: operation.operationKey, attempt: operation.attempt });
      retryAuthorization = { mode: 'new-request', proof };
    }
    invariant(retryAuthorization?.proof && ['provider-retry', 'new-request'].includes(retryAuthorization.mode), 'Provider did not authorize a safe retry transport.');
    await save({ type: 'failed', definitive: true, reason: 'Fresh provider verification confirmed the failed request.', proof });
    await save({ type: 'retry', proof: retryAuthorization.proof });
    start = true;
  }
  if (start) {
    if (!operation) await save({ type: 'intent', operationKey: stage, request: context });
    let accepted;
    try {
      accepted = await provider.start({ ...context, ...(retryAuthorization ? { retry: retryAuthorization } : {}) });
      invariant(typeof accepted?.id === 'string' && accepted.id.length > 0, 'Provider returned no operation ID.');
      // The returned ID is durable before readback, which can fail independently.
      await save({ type: 'accepted', operationId: accepted.id });
    } catch (error) {
      if (['intent', 'accepted'].includes(operation.status)) await save({ type: 'unknown', reason: 'Provider request outcome requires reconciliation.' });
      throw error;
    }
  }
  let { observed, proof } = await observeProvider({ provider, operation, context });
  if (observed.status === 'unknown' && retry && provider.resumeUnknown) {
    // The provider must reverify an idempotent continuation; generic enqueue retry remains forbidden.
    await ledger.append(releaseId, { stage, status: operation.status, operation, continuation: { proof, requested: true } });
    observed = await provider.resumeUnknown(context);
    proof = await provider.verify(observed, { ...context, observe: true });
    invariant(proof && Object.keys(proof).length, 'Continuation lacks fresh provider evidence.');
  }
  for (const event of observationTransitions(operation, observed, proof)) await save(event);
  return operation;
}

/** Reconcile verified absence through a provider-specific proof verifier, never from an empty search. */
export async function reconcileAbsence({ ledger, releaseId, stage, provider, context, evidence }) {
  const operation = latestOperation((await ledger.read(releaseId)).events, stage);
  invariant(operation && !operation.operationId && provider.verifyAbsence, 'Known provider IDs cannot be reconciled as absent.');
  const proof = await provider.verifyAbsence(evidence, context);
  const next = reduceOperation(operation, { type: 'reconciled-absent', proof });
  await ledger.append(releaseId, { stage, status: next.status, operation: next });
  return next;
}
