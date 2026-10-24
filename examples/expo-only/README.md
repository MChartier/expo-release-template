# Serverless Expo application

Copy these configuration and metadata-hook examples into a normal Expo application. Set the real repository, owner, project ID and Android/iOS application identities. Add enabled targets and verified version floors. A `server` section is unnecessary.

Install the shared package from a reviewed full Git SHA, add `"release": "expo-release"`, and call the reusable workflow at the same SHA. Use Node 24.

Configure the matching EAS `internal` profile with channel `internal`, environment `preview`, distribution `internal`, `autoIncrement: true`, and CLI `appVersionSource: remote`. Initialize EAS build counters using official tooling. Preserve existing signing credentials.

The first release allocates a new major and produces a binary. Later JS/assets changes produce patch OTA updates for that major. `rebuild: true` produces a new minor binary plus same-runtime OTA. Tests exercise this configuration without server, WireGuard or store submission dependencies.
