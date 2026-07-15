module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/src", "<rootDir>/test"],
  testMatch: ["**/?(*.)+(spec|test).[tj]s?(x)", "**/*.e2e-spec.ts"],
  moduleFileExtensions: ["ts", "js", "json"]
};
