# Consumer interface

`release.config.json` is authoritative and validated against the package's JSON Schema. It declares repository/default branch, profiles, source input prefixes, application identity, version floors, metadata files, install commands and optional hooks. It does not describe an execution graph.

Hooks are argv arrays. They receive one JSON object on stdin and return one JSON object on stdout; send tool logs to stderr. Every request contains `root` and `action`. Their environment contains allowlisted host/tool paths and declared public values, never inherited provider credentials.

| Hook | Request and result |
| --- | --- |
| `inspect` | Receives `source` and `config`; optionally returns `server`, `js` by platform and `extraNative` identities |
| `prepare` | Receives `plan`; stamps only declared `metadataFiles` with allocated versions |
| `validate` | Receives `plan`; runs application source checks |
| `buildPrepare` | Command-builder exception; generates native source without signing/publication secrets |
| `build` | Command-builder exception; receives `plan`, absolute artifact `directory`, and only standard Android signing variables; writes each target's `native.aab`/`native.apk`, returns `targets` |
| `verify` | Receives `plan`, `target`, and `directory` for native files or `baseUrl` for the isolated server smoke container; checks application artifacts |

Standard signing variables are `ANDROID_KEYSTORE`, `ANDROID_STORE_PASSWORD`, `ANDROID_KEY_ALIAS` and `ANDROID_KEY_PASSWORD` in the exceptional build process. The workflow accepts `ANDROID_KEYSTORE_BASE64` and creates/deletes the private temporary key. Ordinary EAS builds use existing EAS-managed credentials and `EXPO_TOKEN`. No hook performs publication or writes lifecycle state.

The public package exports source hashing and environment helpers. `/engine` exposes dependency-free selection/version arithmetic. `/expo` exposes `runtimeVersion(version)` and `fingerprintTransform`. Provider implementation is private. Use Expo's fingerprint configuration to exclude only allocated metadata; retain native code, dependency versions, configuration and relevant environment inputs. Tests must prove version stamping leaves the fingerprint unchanged.

GitHub variables for WireGuard are `DEPLOY_HOST`, `DEPLOY_URL`, `DEPLOY_WG_ADDRESS`, `DEPLOY_WG_PUBLIC_KEY`. Secrets are `DEPLOY_WG_ENDPOINT`, `DEPLOY_WG_PRIVATE_KEY`, `DEPLOY_TOKEN`. Preserve each consumer's existing peer, service and credentials. Source environment values in EAS must be declared readable strings; hidden secrets and file variables are rejected because their native compatibility cannot be verified before a build.
