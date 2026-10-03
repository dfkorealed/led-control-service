module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  moduleNameMapper: {
    "^expo-network$": "<rootDir>/src/test/network-mock.ts",
    "^(react-native-safe-area-context|expo-status-bar)$": "<rootDir>/src/test/react-native-mock.tsx",
    "^react-native$": "<rootDir>/src/test/react-native-mock.tsx",
    "^react-native-webview$": "<rootDir>/src/test/webview-mock.tsx"
  }
};
