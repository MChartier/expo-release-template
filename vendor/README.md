# Reproducible provider distribution

These generated npm archives keep EAS CLI 22.4.0 and its reviewed dependency patches upstream. A dependency package's npm overrides are not applied by a consuming project. The EAS archive therefore changes its own dependency declarations to minimatch 5.1.8, nanoid 3.3.18 and tar 7.5.21, and bundles those packages plus the logging dependency closure. Executable EAS files remain the original registry bytes.

The bundled Bunyan metadata omits optional DTrace instrumentation. Other EAS dependencies can also request Bunyan, so the root shrinkwrap resolves DTrace 0.8.8 to a separate archive whose only change selects its existing JavaScript fallback install script. This avoids `node-gyp` on the first Git dependency fetch. The fallback intentionally provides no native tracing; it does not affect release operations.

`eas-source.json` and `dtrace-source.json` identify the original registry archives. `eas-distribution.json` records every original package URL and SHA-512 integrity, metadata changes and generated archive SHA-256 hashes. The generator verifies each download before extraction and changes package metadata only. No upstream executable source is compiled or rewritten.

From a clean toolkit checkout:

```sh
npm ci --ignore-scripts
npm run package:eas
git diff --exit-code -- vendor
npm run verify:distribution
```

The checked-in source receipt fixes the inputs and archive layout for reproduction. Updating EAS or its dependency patches requires reviewing the generator, source receipts, archives and shrinkwrap together. Regenerate a clean lock when dependency metadata changes; an existing lock can retain an older same-version package. Run `EXPO_RELEASE_DISTRIBUTION_TEST=1 npm test` in a suitable shell after any distribution change.

The EAS source archive is about 3 MB. The installed toolkit bundles the full locked runtime graph, making npm's first Git fetch and cached tarball larger. Consumers need neither dependency overrides nor a second tooling installation. The toolkit `prepare` script verifies the installed graph and allowed lifecycle scripts; it performs no download, mutation or compilation. Tests cover clean tarball and full-SHA Git installations, including `--ignore-scripts`.
