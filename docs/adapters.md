# Source hooks, providers and recovery

The installed package owns the pipeline. Consumer hooks compute application facts and run application commands; they do not select stages, allocate versions, poll providers or define another release ledger.

## Source-hook protocol

Configure argument arrays under `hooks` in `release.config.json`. A hook receives one JSON document on stdin containing `schemaVersion: 1`, `action`, `root`, `config` and phase inputs. It writes one JSON result with `schemaVersion: 1` to stdout. Send tool logs to stderr. Commands execute without shell string interpolation and receive a restricted process environment plus declared public values.

| Hook | Responsibility | Result |
| --- | --- | --- |
| `inspect` | Calculate effective inputs, actual runtime/full fingerprint and public Expo config for each target | `observations` with one unique configured target ID each |
| `prepare` (optional) | Apply application-specific generated metadata after shared version mappings | Application transformation evidence |
| `validate` | Run the application's required checks and service tests | Validation result or a failing process |
| `build` | Build a native/server artifact or export the assigned OTA runtime and directory | `artifact` with exact directory, runtime and inert metadata |
| `verify` | Check app IDs, versions, runtime and application contract against the assigned artifact | `verified: true` only after those checks |

An input identity measures shipped behavior, not changed filenames. Include actual dependency closures, resolved public configuration and deletions; exclude tests/docs and normalize only allocated bookkeeping. Keep full native fingerprint proof separate from normalized selection identity. Version preparation occurs before the final candidate runtime is frozen.

Retained appVersion exports receive `runtimeOverrides` containing original version fields. Apply only those fields in the source phase; preserve current application/project/server/channel identity. Android-only and iOS-only consumers do not invent another platform's counter. Generated native directories and compiler caches must not change their own source fingerprints.

## Provider and artifact boundaries

Only shared providers receive credentials for their operation. Source hooks are never imported by a source-free publisher. The package resolves its pinned EAS transport from the external cache populated by `expo-release setup`; consumers need no global CLI or copied toolchain.

Artifacts retain exact file inventories, hashes, source, producer and toolkit identities. Reject path traversal, symlinks, missing/unexpected files and changed bytes. Preserve raw retained manifests and the original artifact producer through recovery. A current recovery run may produce new evidence but cannot pretend to have produced an older artifact.

OTA exports are enumerated per compatible supported runtime. Each retained binding includes runtime, full fingerprint, public environment, source and payload. Publishers rehash the retained export and downloaded provider bytes without rebundling Hermes. Different runtime bindings have independent durable operations, so partial publication does not replay already completed runtime groups.

Native artifacts must be successful before submission. Exact verified queue acceptance completes a handoff stage; submission completion remains separate. Application-specific tracks/form factors come from sealed configuration, not guessed aliases. A changed destination is not a retry of an immutable request.

At most one server component is supported. Its optional `smoke` configuration declares a port, health path, timeout, public environment and disposable companion services by alias/image/environment. Source-only Docker checks run before merge and signing; the application `verify` hook receives the tested `artifact.baseUrl`. These checks do not publish an image or require registry credentials.

Callers use `ANDROID_KEYSTORE_BASE64`, `ANDROID_STORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD`. Consumers can map existing repository secrets to those inputs; protected signing environments must provide the standardized names. Application-specific Gradle variable names remain configured in `signing.variables`.

Local profiles may explicitly permit Android internal-track submissions through `local.submissions[target].track`. The shared implementation verifies a retained local build receipt and exact AAB bytes, records intents and provider results in a local-only GitHub Release, and preserves target ordering. A service-account file remains outside the source checkout. Local records never attest an Actions producer, authorize protected hosted publication or advance hosted baselines. An ambiguous upload blocks a second upload until exact track/version/hash/marker readback resolves it.

An explicit `localBuilder` changes only local execution; the sealed plan retains its original hosted `builder`. Local command builds call the `build` hook with `phase: "prepare"` before reading external credentials, then `phase: "compile"` with only the configured Android signing variables. Verification/inspection hooks receive no signing or publication credentials. `localBuilder: "eas"` supports iOS on macOS through a fixed toolkit invocation; only that EAS process receives Expo authentication. It does not load Android settings. Both paths use canonical artifact receipts and recheck full native fingerprints. `local.settingsDirectory`/`settingsFile` locate external current-format settings. Reconfigure existing external keys once at cutover; old settings and receipt formats are not read.

## Retained operations

`retainedOperationRequest` reads a finalized hosted release and seals its original artifact inventory together with the current configuration. `prepareRetainedOperation` revalidates that proposal under a new protected Actions run. Its source commit identifies the original artifact source; its workflow/toolkit authority and operation journal identify the new run. It allocates no versions and never advances a source or runtime baseline. Submitting already completed submissions is rejected; a new destination needs a declared promotion.

Native `promotions` policies name `targets`, per-target `tracks` with exact `source` and `destination`, one `approvalEnvironment`, and `credentials.accessToken` and/or `credentials.serviceAccountBase64`. Credential values are secret names; only those names are resolved, with no fallback to another promotion's credentials. Optional `sourceMarkerPrefix` requires an existing producer marker such as `cal-p@COMMIT`; omit it for EAS submissions that did not promise that marker. Promotion verifies the completed original submissions and exact Play bundle version/hash. Targets sharing an application ID commit in one edit, and separate applications use separate stages. Partial existing cohorts, pending Console changes, newer destination versions and ambiguous commit outcomes block another write.

`createStageProvider` and `executeStage` in the private execution module serve normal publication, retained operations and recovery. Construction restores and verifies the original artifacts without starting a provider request; execution records intents and IDs through the common reducer. Callers dispose publisher workspaces and own the restored files. Standalone image promotion verifies protected version/tag policy before moving an alias; deployment uses only the configured deployment transport. Neither stage evaluates application configuration with publisher credentials.

Component `approvalEnvironment` accepts a string or a profile-to-environment map. For example, production native submission can require `play-internal` while a local build declares an empty approval. Named promotion approvals remain explicit strings and are independent of native build/submission approval.

## Recovery contracts

`inspectRecovery` returns the immutable original plan, graph status and every durable provider operation, including build-provider and per-runtime suboperations. `recoverRelease` validates explicit `resume`, `retry`, `reconcile`, `complete` or `abandon` actions. Resume returns the unchanged plan and remaining stages for fixed shared workers; it does not replan from the latest branch.

Reconciliation reads exact provider IDs or a uniquely verified original response and records the result. It never calls provider `start`. Missing search results do not prove absence. An existing failed operation retains its ID, evidence and history; an explicit retry refreshes provider identity, destination, artifact and safe retry transport immediately before mutation. Ambiguous operations block abandonment even when their canonical graph stage appears complete.

Candidate recovery before merge inspects the original candidate and protection state. Prepared release recovery retains the original source/configuration authority even after the default branch advances. Source validation, signing, publication and protected production work continue through their fixed capability boundaries.

An interrupted OTA with no accepted provider ID requires a reviewed `absence` object before an explicit retry. It contains `confirmed: true`, `outcome: "not-published"`, `noPublishedUpdate: true`, `noInFlightRequest: true`, the exact `projectId`, `applicationId`, `target`, `platform`, `runtime`, `channel`, `environment`, `branch`, `source`, `marker`, `payload`, `planDigest`, `operationKey` and original numeric `attempt`, plus `observedAt` and a specific 20–2000 character `evidence` explanation. This is an operator audit of provider history and request state, recorded as `operator-provider-reconciliation`; an empty search is never sufficient. The provider also rechecks channel mapping, retained bytes and bounded live history (at most 1,000 groups), rejects any matching publication, and refreshes the proof before retry intent and immediately before publication. Known IDs require exact provider reconciliation instead.

## Deployment

The shared WireGuard/HTTPS webhook transport retains existing endpoint, Compose and health behavior. It adds no SSH prerequisite or new homelab endpoint. A healthy webhook response is health evidence; it does not attest the exact deployed image digest. Application runtime/API compatibility checks remain source-hook responsibilities.

This webhook has no query endpoint. An ambiguous attempt requires explicit operator inspection of service logs before recovery. The JSON file passed to `recover --reconcile FILE` contains `confirmed: true`, the exact `stage`, and either `health` or `absence`. That nested evidence contains `confirmed: true`, `outcome: "healthy"` or `"not-started"`, the configured `service`, original `planDigest`, `operationKey`, numeric `attempt`, an ISO `observedAt`, and a specific `evidence` explanation of 20–2000 characters. Healthy evidence also includes `body: { "service": "SERVICE", "status": "succeeded", "healthy": true }`; absence must omit `body`. `verifyDeploymentReconciliation` binds this operator assertion to the exact request attempt and records `evidenceKind: "operator-service-log-reconciliation"`. It does not manufacture provider readback or an image digest. Verified absence permits a separately requested retry; health resolves the existing attempt without another POST.
