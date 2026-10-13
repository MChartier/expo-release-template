# Repository adapter contract

The engine contains policy and verification primitives. Repository adapters connect those primitives to existing build workers and provider transports without moving source execution into privileged publisher jobs.

## Selection

Give every enabled server, native, and OTA component an effective input identity and its last verified baseline identity. OTA identities are scoped to application, platform, runtime, channel, and environment. Use the resolved dependency closure and effective public configuration; hashing only changed filenames misses renames, deletions, shared packages, and dependency changes.

`selectComponents` compares identities, expands native groups, and follows explicit artifact dependencies. Its `force` field is for a proven dependency such as an introduced runtime, not an operator force-all bypass. Explain each forced decision in `reasons`. A disabled component cannot be pulled into a selected dependency silently.

Keep version allocation in repository configuration. Little Say can retain independent platform build numbers and its selected semantic bump. Calibrate reserves one shared native patch with globally unique odd/even phone/Wear codes. Reservations survive failure and abandonment. Reuse a valid reservation for the same immutable candidate instead of incrementing again.

After preparing versions, resolve the runtime from the actual candidate and expand any new artifact dependencies before freezing the plan. Do not normalize shipped contract or diagnostic metadata as if it were incidental bookkeeping.

Exclude transient compiler state, including Kotlin session directories, from native fingerprints even when it appears inside a discovered dependency or plugin. Keep real native source, configuration, and dependency identities covered. Test runtime identity before and after native compilation as well as managed prebuild; a build must not change its own compatibility identity merely by leaving temporary files behind.

## Provenance and schemas

Nest the shared immutable plan inside the repository's versioned plan when migrating existing schemas. Record application source commit, trusted caller workflow commit, and toolkit commit separately. Cross-repository workflow implementation commits need not equal application source commits.

An engine digest provides integrity, not authorization. The adapter must bind the record to a trusted producing run, verified source, destination, and current trust/revocation policy. Retain historical image verification identities when extracting workflows; do not use native-tag removal as a reason to weaken server provenance.

Persist the final plan before remote mutations. Recovery reuses it even if the default branch has advanced. A new plan is not a retry of the old plan.

## Stage graph

Construct the graph from selected stages only. Do not add disabled server/deploy stages requiring dummy credentials. Suggested stage boundaries are server publish, server deploy, native build per target, verified submission handoff, submission completion, and OTA publication per target.

Represent verified enqueue as a completed handoff stage and upload completion as a different stage. An `accepted` operation receipt is not a successful completion receipt. OTA depends on handoff; overall native completion depends on all required submissions. Play writers sharing an application use one concurrency domain across ordinary releases, recovery, and explicit promotions.

Provider observation and artifact verification precede any success checkpoint. A later independent failure does not erase an earlier successful OTA publication. A later failure for the same stage must not fall back to a stale earlier success.

## Operation recovery

Write intent before sending a mutating request. Persist the returned provider ID immediately, then verify it against the planned source/artifact/destination. If execution is interrupted after intent, observe or reconcile the provider before retrying.

`reduceOperation` validates state transitions and retains evidence. It cannot establish whether operator-provided evidence is true; adapters must verify that proof with the relevant provider. A timeout or empty search is not by itself proof that a request was never accepted.

Use exact provider IDs and retained artifacts. Never use the latest build, rebuild an accepted artifact under an old version code, or allocate another version during recovery. Finalization verifies the original uploaded bytes and records the complete journal.

A known rejected request still exists. Preserve its provider ID and verified evidence; do not label it absent. An error label alone does not establish whether a store committed an upload. Distinguish a provider-supported retry of that exact request from a new enqueue after a verified rejection. A provider retry can preserve the original destination, so it cannot silently correct a wrong track. Correcting a destination requires explicit reviewed configuration and reconciliation, proof that a new request is safe, and reuse of the retained artifact. Preserve all failed attempts in the operation history.

For operations with a known provider ID, `reduceOperation` requires fresh event proof for both a definitive `failed` event and a subsequent `retry`. It archives retry authorization as `history[].retryProof` alongside the failed ID and failure proof. Historical failed states remain readable but cannot authorize a retry by themselves. An adapter may refresh a failed state with another definitive failure event and fresh proof; the adapter must verify the current provider observation and authorize the chosen retry transport. The engine validates evidence structure, not provider facts.

Resolve store track identifiers from the application's actual provider configuration. Labels such as internal testing do not authorize substituting an assumed API alias. Validate the exact application, form factor, destination, and artifact on enqueue and readback. Existing immutable plans must not silently adopt a changed destination.

## Artifacts

`createArtifactManifest` and `verifyArtifactManifest` inventory the exact file set and SHA-256 digests. Archive and persist that manifest with the original files before publication intent. Reject links, path traversal, conflicting files, unexpected additions, and missing files. GitHub artifact transport checks supplement this verification rather than replacing it.

Retained OTA exports include their resolved runtime and public environment identity. An isolated publisher must use those values directly; recomputing an Expo fingerprint from a minimal publisher workspace changes its meaning. Different environments may need different immutable exports.

Verify the extraction layout at the adapter boundary. Downloading one named CI artifact may place its files directly in the requested destination; do not assume an extra artifact-name directory. Fail before publication if the exact expected inventory is missing. Include every verification helper in sparse trusted checkouts.

If a build finished before durable retention was interrupted, recover from that build's original producing run and attestation identity. The recovery run is not the artifact producer. Fetch the exact protected source history needed to verify ancestry and preserve the actual historical signer under the repository's allow/revoke policy. Reformatting an attested JSON document changes its bytes; restore it exactly.

## Deployment and compatibility

The current homelab adapter preserves WireGuard, HTTPS POST, Compose latest, and the existing health response. Do not add an SSH dependency, a new health endpoint, or an unrequested homelab configuration change.

Its receipt proves the service reported a healthy deployment; it does not attest the exact image digest. Preserve application runtime compatibility checks independently. Calibrate's guard requires equal contract majors and a client minor no newer than the server minor; patch drift is allowed.

## Credential boundaries

For new adapters, run build/export and candidate validation without publication credentials, and have separate privileged workers consume verified retained artifacts with trusted pinned tooling. Keep Android signing protection, production OTA approval, explicit production store promotion, and current image attestation verification. Existing consumer transport differences are recorded in [the consumer mapping](consumers.md); the shared engine does not itself isolate a runner or process.

Validate draft-release access with the actual workflow token. Calibrate's draft-record inspection requires a separate trusted job with `contents: write`; it emits only the bounded release metadata needed by credential-free source workers. Do not fix an inspection permission failure by granting those source workers publication credentials.

Do not recreate the removed signed-native-tag or dedicated GitHub-App prerequisite for OTA. Expo runtime compatibility and a verified selected build/submission handoff are the relevant integrated release prerequisites.

## Migration acceptance

Exercise no-op and each component independently, combined changes, first baselines, per-platform changes, channel/environment differences, native grouping, generated metadata dependencies, reserved versions, and contract-major changes. Exercise server failure, enqueue rejection, lost enqueue response, later submission failure after OTA success, partial OTA publication, production approval, and recovery from every durable checkpoint.

Validate a fingerprint on clean installs and before/after managed prebuild. Verify the built binary and its OTA export resolve the same runtime. Preserve legacy readers and make the first fingerprint installation explicit; do not relabel existing appVersion installations as fingerprint-compatible.

Include a retained partial-release fixture: server already healthy, native binaries retained, a rejected submission with a known ID, and OTA still pending. Recovery must skip the server, preserve versions/artifacts, require reviewed submission evidence, and keep OTA gated on a new verified handoff. Preparing or validating a migration does not authorize merging it or resuming that release.
