/** @file Small Expo helpers for major-only runtime labels and allocation-free native fingerprints. */

/** Derive an OTA runtime from the major of a stable mobile release version. */
function runtimeVersion(version) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) throw new Error('Expected a stable mobile release version.');
  return version.split('.')[0];
}

/** Remove generated versions only; preserve native identities, permissions, plugins and environment. */
function fingerprintTransform(source, chunk) {
  if (source.type !== 'contents' || !chunk) return chunk;
  if (source.id === 'expoConfig') {
    const value = JSON.parse(String(chunk));
    delete value.version; delete value.runtimeVersion;
    if (value.android) delete value.android.versionCode;
    if (value.ios) delete value.ios.buildNumber;
    if (value.extra) delete value.extra.releaseVersion;
    return JSON.stringify(value);
  }
  return chunk;
}

module.exports = { runtimeVersion, fingerprintTransform };
