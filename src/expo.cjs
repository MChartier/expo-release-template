/** @file Lightweight Expo runtime configuration helpers, independent of CLI/provider dependencies. */
'use strict';

/** Preserve appVersion installations until a separately reviewed native fingerprint migration. */
exports.runtimeVersion = function runtimeVersion(policy = 'appVersion') {
  if (!['appVersion', 'fingerprint'].includes(policy)) throw new Error('Unsupported native runtime policy.');
  return { policy };
};
