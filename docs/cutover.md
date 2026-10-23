# Start a fresh release history

This version intentionally does not read legacy plans, receipts, imports, pending requests or local settings. Old records can remain archived in GitHub, but cannot be recovered, promoted or used as runtime baselines by this toolkit. Do not retry an old request as part of migration.

1. Install `@mchartier/expo-release` from a reviewed full Git SHA and pin every reusable workflow to that same SHA. Regenerate the consumer lock with npm.
2. Run `npm run release -- setup`. Official EAS CLI 22.4.0 installs from its own lockfile in an external cache under `LOCALAPPDATA` on Windows or `XDG_CACHE_HOME`/`~/.cache` elsewhere. `EXPO_RELEASE_TOOLCHAIN_CACHE` may select another external cache. Failed installations are discarded; a completed cache is reused. No package lifecycle build or patched vendor archive is required.
3. Set each version group's `minimumVersion` and `minimumCodes` to the greatest previously used/reserved identifiers from committed metadata and provider readback. These are numeric allocation floors, not release or compatibility evidence. Allocation exceeds the floors and every newer journal reservation. Keep paired Android lanes or independent platform allocation as configured.
4. Map repository secrets once to the standard workflow inputs. Protected signing environments must supply `ANDROID_KEYSTORE_BASE64`, `ANDROID_STORE_PASSWORD`, `ANDROID_KEY_ALIAS`, and `ANDROID_KEY_PASSWORD`; copy the existing key and values, without generating a new signing identity. Retain existing approval environments, Play destinations, Expo projects, application IDs and deployment endpoints.
5. Configure the existing external signing files in the new `expo-release.json` machine settings. Use `expo-release-credentials --target ID` to select the existing EAS identity, or the public `saveLocalCredentialPaths` helper to register existing absolute paths. Do not copy historical artifact/baseline caches. The current local runtime collision guard starts with the first successful new local build.
6. Review the first fresh native/server release through the normal candidate, validation, signing and approval flow. With no baseline, configured components are selected as a first release. OTA-only work still needs applicable new native evidence, except for a consumer's explicitly configured source-validated OTA policy. The migration itself does not publish anything.

Existing installations remain eligible for compatible OTA updates when their runtime matches a newly verified native release. No artificial runtime salt or forced native identity change is introduced. Subsequent releases retain multiple supported runtimes from the new history; `retiredRuntimes` continues to exclude explicitly retired entries. Historical imports are not supported.

Recovery, retained submission, promotion and deployment continue for **new** records. Original producing runs, artifact hashes, destinations and current signer revocations remain authoritative. Unknown outcomes require exact reconciliation before a separate retry. A missing response or an empty search never authorizes a second request.

## Provider and configuration dependencies

The outer toolkit uses Ajv for JSON Schema validation and the official scoped Google Android Publisher/auth clients. Generated configuration declarations are checked against the schema in CI. The pure planning engine remains dependency-free.

EAS publishes/builds through its supported CLI. `src/providers/eas-api.mjs` isolates read-only private evidence queries: the CLI's update JSON omits asset hashes, build JSON omits submission associations, and there is no equivalent submission reconciliation/signing inventory interface. These queries cannot enqueue or publish. Upgrading the pinned CLI requires the evidence-adapter and installation contract checks.
