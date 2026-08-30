import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories: string[] = [];

const payload = {
  sourceType: "schedule",
  sourceId: "44444444-4444-4444-8444-444444444444",
  results: [{
    fixtureId: "33333333-3333-4333-8333-333333333333",
    status: "succeeded",
    brightnessPercent: 60,
    faultCode: null,
    errorCode: null,
    occurredAt: "2026-08-29T00:00:00.000Z"
  }]
};

const payloadJson = JSON.stringify(payload);
const importSmoke = `
  const payload = ${payloadJson};
  const { automationExecutionActionResultPayloadV1Schema: schema } =
    await import("@led-control/shared/automation-contracts");
  const result = schema.safeParse(payload);
  if (!result.success || JSON.stringify(result.data) !== JSON.stringify(payload)) process.exit(1);
`;
const requireSmoke = `
  const payload = ${payloadJson};
  const { automationExecutionActionResultPayloadV1Schema: schema } =
    require("@led-control/shared/automation-contracts");
  const result = schema.safeParse(payload);
  if (!result.success || JSON.stringify(result.data) !== JSON.stringify(payload)) process.exit(1);
`;
const rootImportSmoke = importSmoke.replace(
  "@led-control/shared/automation-contracts",
  "@led-control/shared"
);
const rootRequireSmoke = requireSmoke.replace(
  "@led-control/shared/automation-contracts",
  "@led-control/shared"
);

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

describe("shared package exports", () => {
  it("loads the automation contracts subpath through direct Node ESM import", async () => {
    await expect(execFile(process.execPath, ["--input-type=module", "--eval", importSmoke], {
      cwd: packageRoot
    })).resolves.toMatchObject({ stderr: "" });
  });

  it("publishes executable ESM and CommonJS automation contracts in the packed package", async () => {
    const temporaryDirectory = await mkdtemp(join(tmpdir(), "led-shared-package-"));
    temporaryDirectories.push(temporaryDirectory);

    const packDirectory = join(temporaryDirectory, "pack");
    const consumerDirectory = join(temporaryDirectory, "consumer");
    const installedPackageDirectory = join(
      consumerDirectory,
      "node_modules",
      "@led-control",
      "shared"
    );
    await mkdir(packDirectory, { recursive: true });
    await mkdir(installedPackageDirectory, { recursive: true });

    const { stdout: packOutput } = await execFile("pnpm", [
      "pack",
      "--pack-destination",
      packDirectory
    ], { cwd: packageRoot });
    const archivePath = packOutput.trim().split("\n").at(-1);
    expect(archivePath).toBeTruthy();

    const { stdout: archiveList } = await execFile("tar", ["-tzf", archivePath!]);
    expect(archiveList).toContain("package/dist/esm/automation-action-result-contracts.js");
    expect(archiveList).toContain("package/dist/esm/automation-action-result-contracts.d.ts");
    expect(archiveList).toContain("package/dist/esm/package.json");

    await execFile("tar", [
      "-xzf",
      archivePath!,
      "--strip-components=1",
      "-C",
      installedPackageDirectory
    ]);

    const zodDirectory = await realpath(join(packageRoot, "node_modules", "zod"));
    await symlink(zodDirectory, join(consumerDirectory, "node_modules", "zod"), "dir");

    const esmPackage = JSON.parse(await readFile(
      join(installedPackageDirectory, "dist", "esm", "package.json"),
      "utf8"
    )) as { type?: string };
    expect(esmPackage).toEqual({ type: "module" });

    const packageJson = JSON.parse(await readFile(
      join(installedPackageDirectory, "package.json"),
      "utf8"
    )) as {
      types: string;
      exports: Record<string, Record<string, string>>;
    };
    await expect(access(join(installedPackageDirectory, packageJson.types))).resolves.toBeUndefined();
    expect(join(installedPackageDirectory, packageJson.exports["."].types)).toBe(
      join(installedPackageDirectory, packageJson.types)
    );
    const automationExports = packageJson.exports["./automation-contracts"];
    expect(automationExports.browser).toMatch(/^\.\/dist\/esm\/.+\.js$/);
    expect(automationExports.import).toMatch(/^\.\/dist\/esm\/.+\.js$/);
    expect(automationExports.require).toMatch(/^\.\/dist\/.+\.js$/);
    expect(automationExports.types).toMatch(/^\.\/dist\/.+\.d\.ts$/);
    expect([automationExports.browser, automationExports.import]).not.toContainEqual(
      expect.stringMatching(/\.ts$/)
    );

    await expect(execFile(process.execPath, ["--input-type=module", "--eval", importSmoke], {
      cwd: consumerDirectory
    })).resolves.toMatchObject({ stderr: "" });
    await expect(execFile(process.execPath, ["--eval", requireSmoke], {
      cwd: consumerDirectory
    })).resolves.toMatchObject({ stderr: "" });
    await expect(execFile(process.execPath, ["--input-type=module", "--eval", rootImportSmoke], {
      cwd: consumerDirectory
    })).resolves.toMatchObject({ stderr: "" });
    await expect(execFile(process.execPath, ["--eval", rootRequireSmoke], {
      cwd: consumerDirectory
    })).resolves.toMatchObject({ stderr: "" });
  }, 30_000);
});
