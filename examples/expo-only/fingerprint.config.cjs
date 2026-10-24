/** @file Use the same native compatibility policy locally and in EAS cloud builds. */
module.exports = {
  sourceSkips: ['ExpoConfigVersions', 'ExpoConfigRuntimeVersionIfString'],
  fileHookTransform: require('@mchartier/expo-release/expo').fingerprintTransform
};
