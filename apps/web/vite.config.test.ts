import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Vite configuration", () => {
  it("isolates optimized dependency caches for concurrent server ports", () => {
    const caches = ["15174", "15175"].map(port => JSON.parse(execFileSync(process.execPath,
      ["--input-type=module", "--eval", [
        'import { loadConfigFromFile } from "vite";',
        'const result = await loadConfigFromFile({ command: "serve", mode: "test" }, "./vite.config.ts");',
        'console.log(JSON.stringify(result?.config.cacheDir));'
      ].join("\n")], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, WEB_PORT: port } })));

    expect(caches).toEqual(["node_modules/.vite-15174", "node_modules/.vite-15175"]);
  });

  it("loads VITE flags from the repository root while preserving the web config", () => {
    const config = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", [
      'import { loadConfigFromFile } from "vite";',
      'const result = await loadConfigFromFile({ command: "serve", mode: "test" }, "./vite.config.ts");',
      'console.log(JSON.stringify({ envDir: result?.config.envDir, hasApiProxy: Boolean(result?.config.server?.proxy?.["/api"]), testEnvironment: result?.config.test?.environment, testExclude: result?.config.test?.exclude }));'
    ].join("\n")], { cwd: process.cwd(), encoding: "utf8" }));

    expect(config).toMatchObject({
      envDir: "../..",
      hasApiProxy: true,
      testEnvironment: "jsdom",
      testExclude: expect.arrayContaining(["scripts/**/*.test.mjs"])
    });
  });
});
