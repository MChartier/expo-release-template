# Expo release template

This repository owns a dependency-free release engine and pinned GitHub Actions contracts for Expo projects. A release selects server images, native binaries, and OTA targets independently, then records the selected operations without confusing a queued store submission with a completed release.

Application repositories keep their build commands and credential boundaries. The engine owns deterministic selection, dependency expansion, immutable plan identities, stage readiness, recovery transitions, version helpers, and artifact verification. The first consumers are Little Say (Android and iOS) and Calibrate (paired Android phone and Wear).

## Release contract

1. Pin the application source, trusted caller workflow, engine revision, configuration, destinations, and component baselines.
2. Compare effective inputs against each component's verified baseline. Documentation, tests, and irrelevant bookkeeping do not select application releases. Missing baselines select the applicable first release.
3. Apply configured native groups and real artifact dependencies. Calibrate native version metadata also changes its shipped server diagnostics. Version preparation must finish before resolving final runtime identities.
4. Prepare selected versions together through normal protected-branch validation. OTA-only and no-op cuts do not create empty version PRs.
5. Build selected artifacts. Persist exact per-target OTA exports before publication intent. Never recompile Hermes to verify an earlier publication.
6. Deploy and check health only when the server component is selected. Serverless and OTA-only configurations need no deployment credentials.
7. When native store submission is selected, verify the successful native artifacts, enqueue the exact artifact, and verify its submission identity before OTA. Monitor submission independently of OTA. Calibrate serializes phone completion before Wear submission.
8. Record every outcome, including successful operations from an incomplete run. Complete only after every required stage succeeds. Unknown remote outcomes require reconciliation before retry.

Native runtime identity, application versions, build numbers, OTA channel, EAS environment, and store track are distinct configuration values. Fingerprint runtimes prove native compatibility; they do not prove that JavaScript changed or that a store accepted the binary.

## Contents

- `packages/release-engine/`: zero-dependency ESM library, TypeScript declarations, and executable contract tests.
- `scripts/sync-engine.mjs`: installs a consumer snapshot from an exact committed revision.
- `action.yml`: checks a consumer snapshot against the exact upstream action revision.
- `.github/workflows/release-contract.yml`: reusable read-only contract tests for consumer repositories.
- `examples/expo-only.mjs`: working selection and ordering example without a server, Wear, deployment secrets, or store submission.
- `docs/adapters.md`: adapter responsibilities and migration rules.
- `docs/consumers.md`: Little Say/Calibrate policy differences and guidance for another Expo app.

## Start a new consumer

Use this repository as a GitHub template or add its engine to an existing Expo repository. Application build/publish adapters must be configured for that application's identity and credentials; creating a repository does not authorize or start publication.

Clone this repository at the reviewed revision, then install its snapshot into the consumer:

```powershell
node scripts/sync-engine.mjs --revision FULL_40_CHARACTER_COMMIT --target C:/path/to/app
```

The command writes `tools/release-engine/`, `tools/verify-release-engine.mjs`, `release-engine.lock.json`, and byte-preserving Git attributes. It reads committed blobs, not uncommitted files. A locally modified managed snapshot is rejected instead of overwritten.

Import the shared API from the consumer's `tools/release-engine/index.mjs`. Keep app-specific configuration and adapters outside that managed directory. The snapshot includes its tests and works offline on Windows and Linux without a package registry token.

Add the pinned verification action to consumer CI after checkout:

```yaml
# Verify the exact common engine before testing app-specific release adapters.
- uses: MChartier/expo-release-template@FULL_40_CHARACTER_COMMIT
```

Add the read-only shared contract job:

```yaml
# Run the same selection, recovery, and artifact contracts in every consumer.
release-engine:
  permissions:
    contents: read
  uses: MChartier/expo-release-template/.github/workflows/release-contract.yml@FULL_40_CHARACTER_COMMIT
```

Use the same full commit in the lock, action, and reusable workflow. This public template supports both public and private consumers without a cross-repository PAT or a new GitHub App.

The action verifies against its downloaded upstream code, not merely against a self-authored local lock. The reusable job checks local snapshot consistency and runs contract tests with read-only permissions and no publication secrets; use both jobs for authoritative verification. Existing application release workers retain job-scoped signing, attestation, publishing, and approval environments.

## Update an existing consumer

Review and test the engine change in this repository, commit it, and run the synchronization command using that new full SHA. Update both pinned workflow references to match the generated lock. Run the consumer's release contract tests and existing release/native/deployment checks before merging the update.

Keep historical plan and receipt readers. New policy does not rewrite an old plan or turn an old queued operation into a completed one. Template upgrades do not automatically cut a release, rebuild a native app, repoint an OTA channel, or deploy a server.

## Validate

```powershell
npm test
node examples/expo-only.mjs
```

The suite uses synthetic provider states and temporary artifact/Git fixtures; it does not contact Expo, stores, GitHub publishing APIs, or a deployment service. Application integration tests remain in their repositories. Live release validation is a separate operator action after the migration has passed review and CI.
