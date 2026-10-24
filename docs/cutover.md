# Fresh release cutover

1. Review and merge the toolkit, then merge consumers pinned to that exact full SHA. Install normally with `npm ci`; do not synchronize source snapshots.
2. Protect the default branch, the configured publication/signing/submission/deployment environments and the `expo-release/v3/**` tag namespace. Keep existing application IDs, upload/signing keys, EAS projects, channels and deployment destinations.
3. Read existing metadata and provider high-water marks. Set `versionFloor` values above already used semantic versions and Calibrate's `pairCodeFloor` at or above every used phone/watch code. Initialize ordinary EAS remote counters using `eas build:version:set`, preserving independent Android/iOS counters. Never reset a live counter downward.
4. Configure existing credentials through official EAS tools. For EAS Submit, configure the exact Android track or numeric iOS `ascAppId`; ensure existing remote submission credentials are assigned. Do not generate replacement signing keys.
5. Verify the public EAS inputs, protected environment secret names and unchanged WireGuard webhook configuration. Preview with `expo-release plan`; it is read-only.
6. A human dispatches the first release from the protected default branch. With no current-format history it creates a new mobile major, builds all enabled platforms and establishes fresh successful baselines. Old installed runtime strings are intentionally incompatible and need a binary upgrade.

Nothing imports old plans, receipts, pending requests, signer histories or runtime baselines. Existing releases are not recoverable through this toolkit. Subsequent OTA delivery reaches all installations sharing the new current major runtime. A later major retires automatic delivery to the previous runtime.

Keep reservation tags and evidence immutable. Blocked operations require investigation in provider/GitHub tooling. GitHub deployment payloads identify the affected target, source/build commit and run. Preserve operator evidence with the corresponding GitHub Release before recording a terminal status. A confirmed failed or never-accepted request permits a new dispatch; an unknown result does not. This deliberately trades automatic recovery for a smaller auditable workflow.
