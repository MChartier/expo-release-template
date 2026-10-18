# Minimal serverless consumer

This starter is an Android Expo app using EAS cloud internal builds and appVersion runtimes. It exercises the actual shared planner; there is no server, deployment secret, store submission or paired-device policy.

Copy `release.config.json`, `release-hooks.mjs` and `app.config.cjs` into an existing Expo app, preserving any app-specific config in its config function. Replace the example repository/project/owner/slug/application ID. Keep the app's `@expo/config` and `@expo/fingerprint` versions aligned with its Expo SDK. Set `app.json`'s version and `android.versionCode`, and configure the matching EAS internal profile with `channel: internal`, `environment: preview`, `distribution: internal`, `autoIncrement: false`, and remote credentials. Add a `check` npm script for the application's required validation.

Install `@mchartier/expo-release` at a reviewed full Git SHA, add `"release": "expo-release"`, and use the matching request/recovery/handler workflow pins described in the [root guide](../../README.md). Keep generated native directories, `.release/`, tests and local build outputs out of shipped input identity. Review the input path list in `release-hooks.mjs` when the app uses a different source layout.

The hook reports normalized native compatibility, the full native fingerprint, actual public Expo config and shipped bundle inputs. It applies original native version overlays for retained-runtime exports and sends child-tool logs to stderr. The package owns comparisons, version allocation, stage order, EAS operations, artifact retention and recovery.

`node examples/expo-only.mjs` runs a synthetic completed-baseline-to-JavaScript-change demonstration from the toolkit checkout. The adjacent tests also exercise first release, no-op, native and environment changes, and a retained Android-only runtime through shared verification. They do not claim a real Expo build or publication.
