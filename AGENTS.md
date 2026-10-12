# Release engine maintenance

This repository owns the shared release contract consumed by Expo application repositories.

- Preserve immutable historical plans and provider receipts. Never make an unknown remote outcome authorize a duplicate request.
- Keep component selection independent of GitHub workflow success, and keep native runtime compatibility separate from store submission status.
- Keep the engine dependency-free and usable on Windows and Linux with Node 20 or later.
- Document every authored code file with a file-level comment, and every public callable with useful JSDoc. Use native comments for YAML and scripts. JSON and generated snapshots are exempt.
- Add meaningful tests for changed selection, stage ordering, recovery, identity, or artifact-validation behavior.
- Update consumers through `scripts/sync-engine.mjs` from an immutable committed revision. Do not hand-edit generated consumer snapshots.
- Keep source validation and artifact production free of publishing credentials. Repository adapters retain their existing signing, approval, and provenance boundaries.
- Never dispatch a live release as a side effect of testing the engine.
