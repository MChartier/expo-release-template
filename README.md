# Expo release pipeline

`@mchartier/expo-release` owns release planning, version reservations, protected candidate preparation, provider operations, retained artifacts, deployment and recovery. Consumer repositories provide declarative configuration and short source hooks for application inputs, builds and verification. They install one package and call fixed reusable workflows; they do not copy the engine or maintain a second release orchestrator.

The package is executable ESM with TypeScript declarations and a lightweight CommonJS Expo helper. Node 24 is the tested runtime; Node 22.14 or newer is required. The pure engine remains dependency-free on Node 20+. `expo-release setup` installs official EAS CLI 22.4.0 from `toolchain/package-lock.json` into an external cache shared by local and hosted execution. Installation needs no TypeScript build or other package lifecycle compilation.

## Adopt the pipeline

Pin the package and every reusable workflow to the **same full reviewed Git commit**:

```sh
npm install --save-dev 'git+https://github.com/MChartier/expo-release-template.git#FULL_40_CHARACTER_COMMIT'
```

Add `"release": "expo-release"` to the application's npm scripts. Create `release.config.json` with its repository, components, profiles, version mappings, public environment names, application hooks, and any deployment or approval policy. The [schema](schemas/release.config.schema.json) and [serverless example](examples/expo-only/README.md) describe the boundary.

Consumers keep small `workflow_dispatch` request and recovery callers, and a `workflow_run` handler. Both request callers delegate to `.github/workflows/release-request.yml`; the handler delegates to `.github/workflows/release-handler.yml`. Pass only named secrets needed by the configured targets. Package pin validation rejects a missing or different workflow SHA. Public Git package and workflow references need no cross-repository PAT or dedicated GitHub App.

```sh
npm run release -- setup
npm run release -- validate
npm run release -- validate --source
npm run release -- plan --profile internal
npm run release -- run
npm run release -- status
```

`validate` checks configuration, version mirrors and installed toolkit pins; `--source` also runs the application's validation hook. `plan` reads verified history and approved public EAS inputs and writes `.release/plan.json`. `run` sends that request to the trusted workflow. A local plan never authorizes hosted publication by itself. Source fixes or changed release intent require a new plan.

For a local build, plan `--operation build` and the configured target/profile, then run `--local`. Local artifacts carry explicit local provenance. A local profile may opt individual Android targets into internal Play submission through `local.submissions`. Plan `--operation submit --receipt FILE`, then `run --local --receipt FILE`; credentials can be supplied with `--service-account-file FILE`. Recover that exact submission with `recover --local --receipt FILE --resume` or `--abandon --reason TEXT`. Its separate GitHub Releases history preserves used version codes but cannot become a hosted baseline. Other publication operations use their required protected hosted boundaries.

## Ownership and execution

Submission, deployment and promotion can also consume a finalized hosted release without rebuilding it:

```sh
npm run release -- plan --operation submit --release-id ID --targets android
npm run release -- plan --operation deploy --release-id ID --targets server
npm run release -- plan --operation promote --release-id ID --targets server
npm run release -- plan --operation promote --release-id ID --promotion closed
npm run release -- run
```

Each `plan` command writes a separate proposal; run the desired one before creating another. Native promotion uses a named `promotions` policy defining the complete target cohort, exact source/destination tracks, approval environment and credential names. Targets sharing an Android application ID are promoted in one Play edit. The new hosted operation references original artifacts and their original producer, retains its own provider history, allocates no new versions and does not advance build baselines. Local, unresolved, missing or changed evidence cannot authorize it. See the [retained-operation contract](docs/adapters.md#retained-operations).

| Consumer owns | Shared package and reusable workflows own |
| --- | --- |
| Application/project IDs, destinations, environment names and approval policy | Deterministic component comparison, selection and stage topology |
| Version fields, mirrors, native groups and code lanes as data | Monotonic reservation, candidate preparation and protected merge validation |
| Effective source input calculation and app contract checks | EAS/GHCR transports, exact IDs, artifact retention and attestation |
| Source validation and platform build/export commands | Submission handoff, independent monitoring, runtime enumeration and OTA publication |
| Local machine paths and signing inputs | Current-format journaling, retry/reconciliation and retained-artifact operations |
| Existing self-hosted endpoint configuration | WireGuard/webhook deployment and health readback |

Source install, inspect, validation and export run without publication credentials. Privileged publishers consume exact verified retained files and fixed toolkit code. EAS cloud enqueue necessarily evaluates authenticated application configuration; that existing boundary remains explicit. Store queue acceptance is a handoff, not final success. An independent OTA success survives later submission failure, while the whole release remains incomplete.

Deployments are policy driven: a consumer may require deployment for server changes only, or for server/OTA work. Serverless configurations have no deploy stage or dummy deployment secrets. Runtime policy remains application owned: existing `appVersion` installations are not silently relabeled as fingerprint runtimes.

The fixed workers support two native submission waves and two OTA publication waves. `after` sequences targets of the same kind; native handoff and deployment prerequisites come from the canonical stage model. Unsupported ordering is rejected during planning, before reserving or merging a candidate.

`src/execution.mjs` constructs providers and executes source-free stages for new releases, retained operations and recovery. Retained plans reference their original producer and artifacts; recovery observes the same provider and resumes only unfinished stages. One scheduler receives matrices from the sealed stage graph. The shared stage workflow keeps provider credentials, protected environments and read-only image reconciliation in separate jobs. Its setup action installs dependencies before credentials enter the execution step; only Expo work installs EAS.

Local `appVersion` builds keep a fingerprint collision guard beside the external machine settings: changed native inputs require a new native version, including across worktrees. This local memory is not a publication ledger, a hosted baseline, or permission to promote local evidence; GitHub Releases and verified hosted receipts retain those roles.

## Recovery

```sh
npm run release -- recover --release-id ID
npm run release -- recover --release-id ID --resume
npm run release -- recover --release-id ID --retry --stage android:submit
npm run release -- recover --release-id ID --reconcile reviewed-evidence.json
npm run release -- recover --release-id ID --complete
npm run release -- recover --release-id ID --abandon --reason 'A specific reason for retiring the remaining work.'
```

Inspection is read-only. Named mutations dispatch to the protected handler and reuse the original plan, reservations and provider IDs. Intent is durable before a request; the returned ID is durable before readback. An empty search or timeout does not prove absence. Provider retries require fresh verification of the original destination, artifact and retry eligibility. Abandonment checks cloud-build and individual-runtime operations as well as canonical stages.

For a rejected Play request sent to a different track, reconciliation may include `destination: {confirmed: true, operationId, artifactSha256, from, to, reason}`. The shared adapter verifies the exact failed provider ID and archive bytes, and `to` must equal the plan's already authorized track. It appends evidence without uploading; a separate explicit retry rechecks rejection before submitting identical bytes. This cannot change a sealed plan to a new destination or bypass its approval environment.

Legacy journals and imported baselines are intentionally unsupported. Start a fresh history using the [cutover instructions](docs/cutover.md). Recovery preserves immutable plans, producing runs and provider receipts created by this toolkit.

## Maintain and validate

```sh
npm ci
node bin/expo-release.mjs setup
npm test
node examples/expo-only.mjs
```

Set `EXPO_RELEASE_INSTALL_TEST=1` for clean tarball installation and external toolchain checks. Set `EXPO_RELEASE_TEST_SHA` to a pushed full SHA to also test Git installs with normal and ignored scripts. These checks download packages but never mutate a release provider. CI runs them on Windows and Linux and separately checks the pure engine on Node 20.

`src/` contains shared orchestration and provider modules; `packages/release-engine/` contains pure state/graph primitives; `.github/workflows/` contains the fixed capability boundaries. Only executable toolkit code, declarations, schemas and the provider installation manifest/lock are shipped. Provider internals are private; consumers use source-hook helpers and the common CLI. Changes are reviewed upstream, then consumers update their Git dependency/lock and workflow pins together. Review and testing do not merge a consumer PR or authorize a live release.
