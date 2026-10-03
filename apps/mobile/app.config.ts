import type { ConfigContext, ExpoConfig } from 'expo/config';

export default ({ config }: ConfigContext): ExpoConfig => {
  const development = process.env.APP_VARIANT === 'development';
  return {
    ...config,
    name: development ? 'LED 관제 개발' : 'LED 관제',
    slug: 'led-control-mobile',
    platforms: ['android', 'ios'],
    version: '0.1.0',
    orientation: 'default',
    userInterfaceStyle: 'light',
    scheme: 'led-control',
    backgroundColor: '#f5f7fb',
    ios: {
      bundleIdentifier: development ? 'com.ledcontrol.mobile.development' : 'com.ledcontrol.mobile',
      supportsTablet: true,
      infoPlist: { NSAppTransportSecurity: { NSAllowsArbitraryLoads: development } }
    },
    android: {
      package: development ? 'com.ledcontrol.mobile.development' : 'com.ledcontrol.mobile',
      softwareKeyboardLayoutMode: 'resize',
      allowBackup: false,
      permissions: ['android.permission.ACCESS_NETWORK_STATE'],
      blockedPermissions: ['android.permission.RECORD_AUDIO', 'android.permission.CAMERA', 'android.permission.READ_MEDIA_IMAGES', 'android.permission.READ_MEDIA_VIDEO', 'android.permission.READ_EXTERNAL_STORAGE', 'android.permission.WRITE_EXTERNAL_STORAGE', 'android.permission.SYSTEM_ALERT_WINDOW']
    },
    plugins: [
      ['expo-build-properties', { android: { minSdkVersion: 24, usesCleartextTraffic: development }, ios: { deploymentTarget: '16.4' } }]
    ]
  };
};
