import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

describe("Vite configuration", () => {
  it("loads VITE flags from the repository root while preserving the web config", () => {
    const config = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", [
      'import { loadConfigFromFile } from "vite";',
      'const result = await loadConfigFromFile({ command: "serve", mode: "test" }, "./vite.config.ts");',
      'console.log(JSON.stringify({ envDir: result?.config.envDir, hasApiProxy: Boolean(result?.config.server?.proxy?.["/api"]), testEnvironment: result?.config.test?.environment }));'
    ].join("\n")], { cwd: process.cwd(), encoding: "utf8" }));

    expect(config).toMatchObject({ envDir: "../..", hasApiProxy: true, testEnvironment: "jsdom" });
  });
});
