/** @file Minimal serverless native app used to validate the Expo release contract. */
import React from 'react';
import { Text } from 'react-native';
import { registerRootComponent } from 'expo';
/** Render one bundle-owned value so OTA exports have executable application content. */
function App() { return React.createElement(Text, null, 'Serverless release fixture'); }
registerRootComponent(App);
