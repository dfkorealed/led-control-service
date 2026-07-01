module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  moduleNameMapper: {
    "^react-native$": "<rootDir>/src/test/react-native-mock.tsx",
    "^react-native-webview$": "<rootDir>/src/test/webview-mock.tsx"
  }
};
