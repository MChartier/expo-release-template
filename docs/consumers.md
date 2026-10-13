# Consumer configuration and migration

The engine standardizes decisions and recovery contracts. Repository adapters retain platform-specific builders, publication transports, environment protections, and historical receipt readers.

| Concern | Little Say | Calibrate | Shared contract |
| --- | --- | --- | --- |
| Native targets | Android and iOS; independently selected | Android phone and Wear; selected together | Explicit targets and optional native groups |
| Native allocation | Selected semantic increment and platform build numbers | Shared automatic patch; globally reserved odd phone/even Wear codes | Monotonic allocation, reused candidate reservations, no allocation on no-op |
| Server | Container release and existing self-hosted webhook | Server/web container, existing webhook, runtime contract guard | Compare a verified server baseline; deploy only when selected |
| Native/server dependency | Repository's effective input identity decides | Paired version metadata changes shipped server diagnostics | Declare real artifact dependencies; do not hide shipped metadata |
| OTA destinations | Per profile, platform, and supported compatible runtime | Independently tracked internal and production phone OTA | Fingerprint compatibility plus a separate bundle/environment baseline |
| Store sequencing | Exact selected Android/iOS builds for store distribution | Verified phone enqueue, phone completion, then Wear submission | Successful native artifact before enqueue; verified enqueue before OTA; completion required before final success |
| Android testing destinations | Existing `internal` track with draft release status | Owner-confirmed `internal` and `wear:internal` IDs | Read back exact configured IDs; never infer API aliases from display labels |
| Production protection | Repository's distribution and credential configuration | Existing protected production OTA approval and explicit store promotion | Keep approval and credential policy in repository adapters |
| Publication transport | Existing hosted EAS command jobs; source subprocess environments exclude publication tokens | Credential-free export jobs and separate trusted artifact publishers | Provider adapters own credentials; engine code requires none |
| Recovery storage | Append-only assets in run-scoped draft GitHub Releases | Run-scoped retained artifacts and append-only checkpoints | Original immutable plan, exact bytes, provider IDs, explicit unknown-outcome reconciliation |
| Historical records | Legacy appVersion and local/cloud baseline readers | Historical image signer/provenance and release readers | New schemas do not rewrite or reinterpret old evidence |

Little Say's application configuration remains in `release.json`, `native-release.json`, `release-policy.json`, and its EAS profiles. Its adapter is `scripts/release/`. Calibrate's shared-engine configuration is `scripts/release-engine.config.mjs`; its adapter is `scripts/release-engine.mjs`, with application versions, destinations, and protections supplied by the existing release configuration.

Both consumers vendor the exact engine bytes under `tools/release-engine/`, record their source revision in `release-engine.lock.json`, and use a commit-pinned verification action and reusable contract-test workflow. This keeps privileged and sparse-checkout workers reproducible without a registry token. A toolkit update is an explicit reviewed consumer change, not a floating dependency.

The shared library does not create a credential boundary by itself. Little Say retains its hosted EAS transport, including export and publication in the same job; excluding tokens from source subprocess environments is not equivalent to Calibrate's separate export and publisher runners. New adapters should use the separated artifact-worker model in the adapter contract.

Calibrate's rollout exposed adapter requirements now included in the shared contract: stable fingerprints after compiler-generated files appear, exact named-artifact extraction paths, original-run recovery after interrupted retention, isolated draft-release inspection, and explicit reconciliation of a rejected request before correcting its destination. These checks preserve completed server work and retained native binaries while publication remains paused. Repository rollout records, rather than this template, own the current source, version reservations, provider IDs, and historical signer allowlist.

## Add another Expo app

Start with the serverless `examples/expo-only.mjs` and its tests. Add a server, store handoff, native group, or production approval only when the new application's release contract needs it. Keep app identifiers, store tracks, environment names, build commands, and credentials out of the shared engine.

Before enabling publication, implement provider adapters that prove the selected source, destination, and artifact identity. Test an unchanged cut, OTA-only change, native-only input change, server-only change if applicable, and interrupted publication with a lost response. A new native runtime must have a matching OTA target even if its JavaScript source has not changed. A later store failure must leave successful OTA evidence intact while the overall release remains incomplete.

Migrating an installed app from `appVersion` to fingerprint runtimes requires a new native installation. Retain the historical records and apply the application's explicit supported/retired runtime policy; changing a runtime string cannot make an existing binary compatible.
