/** @file Lightweight CommonJS runtime-policy declarations for Expo configuration without loading provider dependencies. */
/** Preserve the selected runtime policy; changing policy requires a separately reviewed native migration. */
export function runtimeVersion(policy?: 'appVersion' | 'fingerprint'): { policy: 'appVersion' | 'fingerprint' };
