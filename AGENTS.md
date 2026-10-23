# Release engine maintenance

This repository owns the shared release contract consumed by Expo application repositories.

- Preserve immutable current-format plans and provider receipts. Legacy records are intentionally unsupported after cutover. Never make an unknown remote outcome authorize a duplicate request.
- Keep component selection independent of GitHub workflow success, and keep native runtime compatibility separate from store submission status.
- Keep the pure engine dependency-free. Ship the complete CLI as executable JavaScript for Windows and Linux with Node 22.14 or later.
- Document every authored code file with a file-level comment, and every public callable with useful JSDoc. Use native comments for YAML and scripts. JSON and generated snapshots are exempt.
- Add meaningful tests for changed selection, stage ordering, recovery, identity, or artifact-validation behavior.
- Consumers install the root package through a full-SHA Git dependency and pin reusable workflows/actions to the same SHA. Do not copy engine source, tests or generic orchestration into consumers.
- Keep source validation and artifact production free of publishing credentials. Shared workers own signing, approval and provenance boundaries; EAS cloud build configuration evaluation retains its explicitly documented authentication boundary.
- Never dispatch a live release as a side effect of testing the engine.
