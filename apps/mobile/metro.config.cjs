const { getDefaultConfig } = require('expo/metro-config');
// Expo detects the pnpm workspace and resolves each app's own React version.
module.exports = getDefaultConfig(__dirname);
