import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

async function readPackageJson(relativePath) {
  return JSON.parse(await readFile(path.join(repositoryRoot, relativePath), "utf8"));
}

test("canonical root checks enter one workspace gate and wire every production contract once", async () => {
  const rootPackage = await readPackageJson("package.json");

  for (const operation of ["lint", "typecheck", "test", "build"]) {
    assert.equal(rootPackage.scripts[operation], `node scripts/workspace-gate.mjs ${operation}`);
  }

  const unitCommand = rootPackage.scripts["test:unit"];
  for (const contractPath of [
    "scripts/production-audit-policy.test.mjs",
    "scripts/image-size-security.test.mjs",
    "tests/mqtt-production-config.node.mjs"
  ]) {
    assert.equal(unitCommand.split(contractPath).length - 1, 1, `${contractPath} must run exactly once`);
  }
});

test("workspace dependency preparation is ordered once and leaf checks cannot start nested writers", async () => {
  const rootPackage = await readPackageJson("package.json");
  assert.equal(
    rootPackage.scripts["workspace:prepare"],
    "pnpm --filter @led-control/shared build && pnpm --filter @led-control/automation-engine build"
  );

  const packageFiles = [
    "apps/api/package.json",
    "apps/gateway/package.json",
    "apps/web/package.json",
    "packages/automation-engine/package.json",
    "packages/shared/package.json"
  ];
  const forbiddenLifecycleScripts = new Set([
    "prebuild",
    "prelint",
    "pretest",
    "pretypecheck"
  ]);
  const forbiddenNestedWriter = /(?:pnpm\s+--filter\s+@led-control\/(?:shared|automation-engine)\s+build|pnpm\s+run\s+(?:build:shared|build:dependencies))/;

  for (const packageFile of packageFiles) {
    const packageJson = await readPackageJson(packageFile);
    for (const lifecycle of forbiddenLifecycleScripts) {
      assert.equal(packageJson.scripts[lifecycle], undefined, `${packageJson.name} must not define ${lifecycle}`);
    }
    for (const commandName of ["build", "lint", "test", "typecheck"]) {
      const command = packageJson.scripts[commandName];
      if (!command || packageJson.name === "@led-control/shared" && commandName === "build") continue;
      assert.doesNotMatch(command, forbiddenNestedWriter, `${packageJson.name} ${commandName} must be graph-pure`);
    }
  }
});
