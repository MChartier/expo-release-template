# Consumer configuration and migration

Both applications install the same `@mchartier/expo-release` Git package and pin its reusable workflows to that exact commit. `release.config.json` declares policy; application hooks report source/build facts. Generic selection, versions, orchestration, providers, recovery and deployment live upstream.

| Concern | Little Say | Calibrate | Shared capability |
| --- | --- | --- | --- |
| Native targets | Independently selected Android and iOS | Paired Android phone/Wear | Optional native groups and target dependencies |
| Hosted builders | EAS cloud builds | Configured native command builders | Common source/build/retention boundaries |
| Native versions | Requested semantic increment; independent selected-platform counters | Shared patch; globally reserved odd/even phone/Wear codes | Declarative mappings, mirrors and code lanes |
| Runtime policy | Existing appVersion policy and exact native fingerprints | Existing fingerprint policy | Explicit policy, full native proof and retained-runtime history |
| OTA | Per profile/platform and all supported compatible runtimes | Internal source-validated behavior; production exact native binding | Explicit per-target runtime binding policy |
| Store destinations | Existing internal/draft Android and explicit iOS app | Explicit phone and Wear track IDs | Exact artifact/build association and destination verification |
| Sequencing | Verified selected native handoff before dependent OTA | Phone completion before Wear submission | Shared graph dependencies, independent monitoring |
| Server | Global server history; server/OTA deployment prerequisite | Native metadata can select server; server-only deployment policy | Global image baseline, generated metadata dependency, declarative deployment policy |
| Protection | Existing distribution and secret boundaries | Existing Android signing, production OTA and promotion protections | Named secrets, environment approvals and fixed shared jobs |

Consumer implementations retain app input calculation, runtime/API contract checks, binary verification and any platform commands not yet represented by a shared builder. They must not rebuild graphs, poll providers, rewrite generic ledgers or reproduce the shared workflow topology.

The repository's held releases and protected environments remain operator controlled. Migration does not dispatch recovery, change a destination, merge a candidate, deploy a server, submit a binary or publish OTA. Validation distinguishes synthetic/provider fixtures from live provider readback and physical-device checks.

## Third consumer

The [Expo-only starter](../examples/expo-only/README.md) uses a real declarative config and source-hook protocol with the canonical `planRelease` API. Its Android app has no server, Wear, deployment, signing-key download or store requirement. Tests cover first release, no-op, JavaScript-only change, native change, environment change, version allocation and an original Android-only appVersion runtime overlay. No application-name conditional exists in the shared planner.

Add components or approval environments only when the application's contract requires them. A consumer changing from appVersion to fingerprint runtimes needs a separately reviewed native migration and explicit supported/retired history; changing the string cannot make an installed binary compatible.

## Adoption acceptance

Compare authored release implementation/configuration and YAML against the pre-adoption consumer baseline. Include relocated files, tests and documentation; report generated npm lockfiles separately. Removing a copied engine alone does not demonstrate that orchestration moved upstream. Preserve application behavior with actual source-input fixtures, old/new planner comparisons, successful independent-stage recovery, exact retained bytes, and clean installed-package tests.
