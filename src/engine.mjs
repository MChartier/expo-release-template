/** @file Dependency-free release selection and version arithmetic; no filesystem or provider access. */

/** Require a release invariant before returning a decision. */
export function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Parse the stable numeric versions used by this deliberately small release contract. */
export function versionParts(version) {
  assert(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version), `Invalid release version: ${version}`);
  const parts = version.split('.').map(Number);
  assert(parts.every(Number.isSafeInteger), 'Release version exceeds the safe integer range.');
  return parts;
}

/** Compare stable versions numerically rather than lexically. */
export function compareVersions(left, right) {
  const a = versionParts(left), b = versionParts(right);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Allocate the next major, minor, or patch; failed reservations remain in the input floor. */
export function increment(version, kind) {
  const [major, minor, patch] = versionParts(version);
  const next = kind === 'major' ? [major + 1, 0, 0] : kind === 'minor' ? [major, minor + 1, 0] : [major, minor, patch + 1];
  versionParts(next.join('.'));
  return next.join('.');
}

/** Allocate Calibrate's next odd phone/even watch pair above every reserved or seeded code. */
export function nextPair(floor) {
  assert(Number.isSafeInteger(floor) && floor >= 0 && floor < 2100000000 - 2, 'Invalid Android build-number floor.');
  const phone = floor % 2 ? floor + 2 : floor + 1;
  return [phone, phone + 1];
}

/**
 * Select three fixed paths from successful target baselines and immutable reservations.
 * A repository has one mobile version; profiles retain their own delivery baselines.
 * Native compatibility follows the latest reserved family, not submission or workflow success.
 */
export function selectRelease(config, profile, observation, history = {}, rebuild = false) {
  assert(config.profiles[profile], 'Unknown release profile.');
  const baselines = history.baselines ?? {};
  const floor = (kind, configured) => [configured, history[kind]?.version ?? configured].sort(compareVersions).at(-1);
  const mobileFloor = config.mobile && floor('mobile', config.mobile.versionFloor);
  const serverFloor = config.server && floor('server', config.server.versionFloor);
  const breaking = !!config.mobile && (!history.mobile || history.mobile.family !== observation.family);
  const runtime = config.mobile ? String(versionParts(breaking ? increment(mobileFloor, 'major') : mobileFloor)[0]) : null;
  const compatible = target => {
    const previous = baselines[`${profile}/build/${target.id}`];
    return previous?.runtime === runtime && previous.fingerprint === observation.fingerprints[profile][target.platform];
  };
  const native = !!config.mobile && (breaking || rebuild || config.mobile.targets.some(target => !compatible(target)));
  const changedPlatforms = config.mobile?.platforms.filter(platform =>
    baselines[`${profile}/js/${platform}`]?.input !== observation.js[platform]) ?? [];
  const mobileChanged = native || changedPlatforms.length > 0;
  const bump = !mobileChanged ? null : breaking ? 'major' : native ? 'minor' : 'patch';
  const mobileVersion = config.mobile ? (bump ? increment(mobileFloor, bump) : mobileFloor) : null;
  const ota = !breaking && config.mobile?.targets.every(compatible)
    ? config.mobile.platforms.filter(platform => native || changedPlatforms.includes(platform)) : [];
  const server = !!config.server && (baselines[`${profile}/deploy/server`]?.input !== observation.server
    || (native && config.server.metadataOnNative === true));
  const pair = native && config.mobile.pairCodeFloor !== undefined
    ? nextPair(Math.max(config.mobile.pairCodeFloor, history.mobile?.pairCodeFloor ?? 0)) : null;
  const operations = [
    ...(server ? ['publish/server', 'deploy/server'] : []),
    ...(native ? config.mobile.targets.flatMap(t => [`build/${t.id}`, ...(config.profiles[profile].submit ? [`submit/${t.id}`] : [])]) : []),
    ...ota.map(platform => `ota/${platform}`),
  ].map(key => `${profile}/${key}`);
  const operation = key => key.slice(key.indexOf('/') + 1);
  const unresolved = (history.pending ?? []).filter(key => operations.some(selected => operation(selected) === operation(key)));
  assert(!unresolved.length, `Resolve uncertain operations in GitHub/provider tools before continuing: ${unresolved.join(', ')}`);
  return {
    format: 3, profile, server, native, ota, bump, runtime, pair, operations,
    versions: { server: server ? increment(serverFloor, 'patch') : serverFloor ?? null, mobile: mobileVersion },
    observation, noop: !server && !mobileChanged,
  };
}

/** Reject a publication that tries to reuse a runtime for different native compatibility. */
export function assertCompatible(expected, actual) {
  assert(expected.runtime === actual.runtime && expected.fingerprint === actual.fingerprint,
    'OTA runtime or native compatibility changed after planning.');
}
