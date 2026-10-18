# Expo release pipeline

`@mchartier/expo-release` owns release planning, version reservations, protected candidate preparation, provider operations, retained artifacts, deployment and recovery. Consumer repositories provide declarative configuration and short source hooks for application inputs, builds and verification. They install one package and call fixed reusable workflows; they do not copy the engine or maintain a second release orchestrator.

The package is executable ESM with TypeScript declarations and a lightweight CommonJS Expo helper. Node 24 is the tested runtime; Node 22.14 or newer is required. EAS CLI 22.4.0 and the patched runtime dependency graph are recorded in `npm-shrinkwrap.json` and bundled in the installed distribution. Installation needs no TypeScript build or other package lifecycle compilation.

On the first full-SHA Git fetch, npm installs this package's locked dependencies in its temporary checkout before packing the bundled toolchain. A `prepare` script only verifies the existing runtime graph; it downloads or compiles nothing. Bundling makes the cached tarball larger, but prevents npm from dropping dependency-package overrides in a consumer install. Consumers need no matching overrides, extra tooling manifest or bootstrap script.

The [generated provider archives](vendor/README.md) preserve original executable bytes and patch dependency metadata. The approximately 3 MB EAS archive fixes its transitive resolutions; an optional DTrace archive selects the existing JavaScript fallback instead of compiling native instrumentation. Source integrity receipts and a reproducible generator document those changes.

## Adopt the pipeline

Pin the package and every reusable workflow to the **same full reviewed Git commit**:

```sh
npm install --save-dev 'git+https://github.com/MChartier/expo-release-template.git#FULL_40_CHARACTER_COMMIT'
```

Add `"release": "expo-release"` to the application's npm scripts. Create `release.config.json` with its repository, components, profiles, version mappings, public environment names, application hooks, and any deployment or approval policy. The [schema](schemas/release.config.schema.json) and [serverless example](examples/expo-only/README.md) describe the boundary.

Consumers keep small `workflow_dispatch` request and recovery callers, and a `workflow_run` handler. Both request callers delegate to `.github/workflows/release-request.yml`; the handler delegates to `.github/workflows/release-handler.yml`. Pass only named secrets needed by the configured targets. Package pin validation rejects a missing or different workflow SHA. Public Git package and workflow references need no cross-repository PAT or dedicated GitHub App.

```sh
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
| Local machine paths and signing inputs | Journaling, retry/reconciliation, baseline import and historical compatibility |
| Existing self-hosted endpoint configuration | WireGuard/webhook deployment and health readback |

Source install, inspect, validation and export run without publication credentials. Privileged publishers consume exact verified retained files and fixed toolkit code. EAS cloud enqueue necessarily evaluates authenticated application configuration; that existing boundary remains explicit. Store queue acceptance is a handoff, not final success. An independent OTA success survives later submission failure, while the whole release remains incomplete.

Deployments are policy driven: a consumer may require deployment for server changes only, or for server/OTA work. Serverless configurations have no deploy stage or dummy deployment secrets. Runtime policy remains application owned: existing `appVersion` installations are not silently relabeled as fingerprint runtimes.

Local `appVersion` builds keep a fingerprint collision guard beside the external machine settings: changed native inputs require a new native version, including across worktrees. Explicitly mapped original local receipts participate only in this rejection check. This local memory is not a publication ledger, a hosted baseline, or permission to promote local evidence; GitHub Releases and verified hosted receipts retain those roles.

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

For a rejected Play request sent to a different track, reconciliation may include `destination: {confirmed: true, operationId, artifactSha256, from, to, reason}`. The shared adapter verifies the exact failed provider ID and archive bytes, and `to` must equal the plan's already authorized track. It appends evidence without uploading; a separate explicit retry rechecks rejection before submitting identical bytes. This cannot change a sealed plan to a new destination or bypass its approval environment. Historical readers additionally enforce their original destination contracts.

Compatibility readers preserve original Little Say and Calibrate journals and producing runs. Recovery evidence has its own verified producer and cannot rewrite original successful evidence. Old missing fingerprint or exported-payload proof remains blocking; the toolkit does not synthesize it from a URL or a provider status. A completed release requires the original contract's evidence, including its deployment prerequisite. See [recovery and hook contracts](docs/adapters.md).

## Maintain and validate

```sh
npm ci
npm test
node examples/expo-only.mjs
```

Set `EXPO_RELEASE_DISTRIBUTION_TEST=1` for `npm test` to additionally install a clean tarball consumer and fresh full-SHA Git consumers with normal and ignored scripts. Checks cover the complete installed runtime graph, absence of lifecycle compilation, pinned EAS executable, ESM API and CommonJS Expo helper. These tests download npm packages but perform no provider writes. Default tests use temporary Git/artifact fixtures and synthetic provider responses.

`src/` contains shared orchestration and provider modules; `packages/release-engine/` contains pure state/graph primitives; `.github/workflows/` contains the fixed capability boundaries. Toolkit tests, fixtures, examples and old synchronization utilities are excluded from the installed package; bundled third-party dependencies retain their own distributions. Changes are reviewed upstream, then consumers update their Git dependency/lock and workflow pins together. Review and testing do not merge a consumer PR or authorize a live release.
