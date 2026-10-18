/** @file Keeps the starter's appVersion policy and applies only retained native version metadata for older-runtime exports. */
const { runtimeVersion } = require('@mchartier/expo-release/expo');

/** Resolve version overlays in the source phase without changing application identity or persistent metadata. */
module.exports = ({ config }) => {
  const metadata = JSON.parse(process.env.EXPO_ONLY_RUNTIME_METADATA || '{}');
  return { ...config, version: metadata.version || config.version, runtimeVersion: runtimeVersion('appVersion'),
    android: { ...config.android, versionCode: metadata.androidVersionCode || config.android.versionCode } };
};
