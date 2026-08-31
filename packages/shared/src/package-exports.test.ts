import { execFile as execFileCallback } from "node:child_process";
import {
  access,
  chmod,
  copyFile,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectories: string[] = [];

async function createBuildFixture() {
  const root = await mkdtemp(join(tmpdir(), "led-shared-build-fixture-"));
  temporaryDirectories.push(root);

  await mkdir(join(root, "scripts"), { recursive: true });
  await mkdir(join(root, "bin"), { recursive: true });
  await copyFile(join(packageRoot, "scripts", "build.mjs"), join(root, "scripts", "build.mjs"));

  const fakeTypeScript = join(root, "bin", "tsc");
  await writeFile(fakeTypeScript, `#!/usr/bin/env node
const { mkdirSync, symlinkSync, writeFileSync } = require("node:fs");
const { dirname, join } = require("node:path");
const outDirectoryIndex = process.argv.indexOf("--outDir");
if (outDirectoryIndex === -1 || !process.argv[outDirectoryIndex + 1]) process.exit(2);
const outDirectory = process.argv[outDirectoryIndex + 1];
const project = process.argv[process.argv.indexOf("--project") + 1];
if (project === "tsconfig.esm.json" && process.env.FAKE_TSC_ESM_SYMLINK_TARGET) {
  symlinkSync(process.env.FAKE_TSC_ESM_SYMLINK_TARGET, outDirectory, "dir");
} else {
  mkdirSync(outDirectory, { recursive: true });
  writeFileSync(join(outDirectory, "index.js"), "exports.fixtureValue = 1;\\n");
  writeFileSync(join(outDirectory, "index.d.ts"), "export declare const fixtureValue = 1;\\n");
  if (process.env.FAKE_TSC_GENERATED_PATH) {
    const generatedPath = join(outDirectory, ...process.env.FAKE_TSC_GENERATED_PATH.split("/"));
    mkdirSync(dirname(generatedPath), { recursive: true });
    writeFileSync(generatedPath, "generated fixture artifact\\n");
  }
}
`);
  await chmod(fakeTypeScript, 0o755);

  return root;
}

async function createExternalDirectory() {
  const directory = await mkdtemp(join(tmpdir(), "led-shared-external-sentinel-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function writeBuildManifest(root: string, files: unknown[]) {
  await writeFile(
    join(root, ".build-output-manifest.json"),
    `${JSON.stringify({ version: 1, files }, null, 2)}\n`
  );
}

async function runFixtureBuild(root: string, environment: Record<string, string> = {}) {
  return execFile(process.execPath, ["scripts/build.mjs"], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${join(root, "bin")}${delimiter}${process.env.PATH ?? ""}`,
      ...environment
    }
  });
}

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

describe.sequential("shared build output cleanup", () => {
  const reservedDevicePaths = [
    "CON",
    "con.txt",
    "nested/PRN",
    "nested/prn.log",
    "AUX",
    "nested/aux.js",
    "NUL",
    "nested/nul.txt",
    ...Array.from({ length: 9 }, (_, index) =>
      `${index % 2 === 0 ? "nested/" : ""}${index % 2 === 0 ? "COM" : "com"}${index + 1}.log`
    ),
    ...Array.from({ length: 9 }, (_, index) =>
      `${index % 2 === 0 ? "nested/" : ""}${index % 2 === 0 ? "LPT" : "lpt"}${index + 1}.txt`
    ),
    "safe/con/child.js",
    "safe/PRN.txt/child.js"
  ];

  it.each(reservedDevicePaths)(
    "rejects the Windows reserved device path %s before touching any artifact",
    async (path) => {
      const root = await createBuildFixture();
      const externalDirectory = await createExternalDirectory();
      const distDirectory = join(root, "dist");
      const existingArtifact = join(distDirectory, "existing.js");
      const unrelatedArtifact = join(distDirectory, "user-kept.txt");
      const externalSentinel = join(externalDirectory, "sentinel.txt");
      await mkdir(distDirectory, { recursive: true });
      await writeFile(existingArtifact, "existing artifact\n");
      await writeFile(unrelatedArtifact, "unrelated artifact\n");
      await writeFile(externalSentinel, "external sentinel\n");
      await writeBuildManifest(root, ["existing.js", path]);

      await expect(runFixtureBuild(root)).rejects.toThrow();

      await expect(readFile(existingArtifact, "utf8")).resolves.toBe("existing artifact\n");
      await expect(readFile(unrelatedArtifact, "utf8")).resolves.toBe("unrelated artifact\n");
      await expect(readFile(externalSentinel, "utf8")).resolves.toBe("external sentinel\n");
    }
  );

  it.each([
    "console",
    "nested/con1.txt",
    "com0.log",
    "nested/com10.log",
    "lpt0.txt",
    "nested/lpt10.txt",
    "null",
    "nested/auxiliary.js"
  ])("accepts the non-device control path %s", async (path) => {
    const root = await createBuildFixture();
    const distDirectory = join(root, "dist");
    const unrelatedArtifact = join(distDirectory, "user-kept.txt");
    await mkdir(distDirectory, { recursive: true });
    await writeFile(unrelatedArtifact, "unrelated artifact\n");
    await writeBuildManifest(root, [path]);

    await expect(runFixtureBuild(root)).resolves.toMatchObject({ stderr: "" });

    await expect(readFile(unrelatedArtifact, "utf8")).resolves.toBe("unrelated artifact\n");
  });

  it("rejects a generated artifact with a reserved nested segment before cleanup", async () => {
    const root = await createBuildFixture();
    const externalDirectory = await createExternalDirectory();
    const distDirectory = join(root, "dist");
    const existingArtifact = join(distDirectory, "existing.js");
    const unrelatedArtifact = join(distDirectory, "user-kept.txt");
    const externalSentinel = join(externalDirectory, "sentinel.txt");
    await mkdir(distDirectory, { recursive: true });
    await writeFile(existingArtifact, "existing artifact\n");
    await writeFile(unrelatedArtifact, "unrelated artifact\n");
    await writeFile(externalSentinel, "external sentinel\n");
    await writeBuildManifest(root, ["existing.js"]);

    await expect(runFixtureBuild(root, {
      FAKE_TSC_GENERATED_PATH: "nested/COM1.log"
    })).rejects.toThrow();

    await expect(readFile(existingArtifact, "utf8")).resolves.toBe("existing artifact\n");
    await expect(readFile(unrelatedArtifact, "utf8")).resolves.toBe("unrelated artifact\n");
    await expect(readFile(externalSentinel, "utf8")).resolves.toBe("external sentinel\n");
  });

  it.each([
    ["uppercase drive-absolute path", "C:\\outside.js"],
    ["lowercase drive-absolute path", "c:/outside.js"],
    ["uppercase drive-relative path", "D:relative.js"],
    ["lowercase drive-relative traversal", "c:..\\outside.js"],
    ["alternate data stream", "index.js:stream"],
    ["nested alternate data stream", "esm/index.js:stream"],
    ["UNC path", "\\\\server\\share\\outside.js"],
    ["Win32 device namespace", "\\\\?\\C:\\outside.js"],
    ["Win32 device path", "\\\\.\\PhysicalDrive0"],
    ["backslash separator", "nested\\outside.js"],
    ["mixed separators", "nested/sub\\outside.js"],
    ["terminal dot segment", "nested./outside.js"],
    ["terminal space segment", "nested /outside.js"]
  ])("rejects the non-portable %s before touching any artifact", async (_name, path) => {
    const root = await createBuildFixture();
    const externalDirectory = await createExternalDirectory();
    const distDirectory = join(root, "dist");
    const existingArtifact = join(distDirectory, "existing.js");
    const externalSentinel = join(externalDirectory, "sentinel.txt");
    await mkdir(distDirectory, { recursive: true });
    await writeFile(existingArtifact, "existing artifact\n");
    await writeFile(externalSentinel, "external sentinel\n");
    await writeBuildManifest(root, ["existing.js", path]);

    await expect(runFixtureBuild(root)).rejects.toThrow();

    await expect(readFile(existingArtifact, "utf8")).resolves.toBe("existing artifact\n");
    await expect(readFile(externalSentinel, "utf8")).resolves.toBe("external sentinel\n");
  });

  it("rejects an intermediate dist symlink before touching external or existing artifacts", async () => {
    const root = await createBuildFixture();
    const externalDirectory = await createExternalDirectory();
    const distDirectory = join(root, "dist");
    const externalArtifact = join(externalDirectory, "index.js");
    const existingArtifact = join(distDirectory, "index.js");
    await mkdir(distDirectory, { recursive: true });
    await writeFile(existingArtifact, "existing artifact\n");
    await writeFile(externalArtifact, "external sentinel\n");
    await symlink(externalDirectory, join(distDirectory, "esm"), "dir");
    await writeBuildManifest(root, ["index.js", "esm/index.js"]);

    await expect(runFixtureBuild(root)).rejects.toThrow();

    await expect(readFile(externalArtifact, "utf8")).resolves.toBe("external sentinel\n");
    await expect(readFile(existingArtifact, "utf8")).resolves.toBe("existing artifact\n");
    expect((await lstat(join(distDirectory, "esm"))).isSymbolicLink()).toBe(true);
  });

  it("rejects a symlinked dist root without touching its external target", async () => {
    const root = await createBuildFixture();
    const externalDirectory = await createExternalDirectory();
    const externalArtifact = join(externalDirectory, "index.js");
    await writeFile(externalArtifact, "external root sentinel\n");
    await symlink(externalDirectory, join(root, "dist"), "dir");
    await writeBuildManifest(root, ["index.js"]);

    await expect(runFixtureBuild(root)).rejects.toThrow();

    await expect(readFile(externalArtifact, "utf8")).resolves.toBe("external root sentinel\n");
    expect((await lstat(join(root, "dist"))).isSymbolicLink()).toBe(true);
  });

  it("fails closed on a generated target symlink and preserves the external file", async () => {
    const root = await createBuildFixture();
    const externalDirectory = await createExternalDirectory();
    const distDirectory = join(root, "dist");
    const externalArtifact = join(externalDirectory, "target.js");
    const existingArtifact = join(distDirectory, "existing.js");
    await mkdir(distDirectory, { recursive: true });
    await writeFile(existingArtifact, "existing artifact\n");
    await writeFile(externalArtifact, "external target sentinel\n");
    await symlink(externalArtifact, join(distDirectory, "index.js"), "file");
    await writeBuildManifest(root, ["existing.js", "index.js"]);

    await expect(runFixtureBuild(root)).rejects.toThrow();

    await expect(readFile(externalArtifact, "utf8")).resolves.toBe("external target sentinel\n");
    await expect(readFile(existingArtifact, "utf8")).resolves.toBe("existing artifact\n");
    expect((await lstat(join(distDirectory, "index.js"))).isSymbolicLink()).toBe(true);
  });

  it("rejects a symlinked ESM compiler output before writing external metadata", async () => {
    const root = await createBuildFixture();
    const externalDirectory = await createExternalDirectory();
    const externalArtifact = join(externalDirectory, "index.js");
    await writeFile(externalArtifact, "external compiler sentinel\n");
    await writeBuildManifest(root, []);

    await expect(runFixtureBuild(root, {
      FAKE_TSC_ESM_SYMLINK_TARGET: externalDirectory
    })).rejects.toThrow();

    await expect(readFile(externalArtifact, "utf8")).resolves.toBe("external compiler sentinel\n");
    await expect(access(join(externalDirectory, "package.json"))).rejects.toThrow();
  });

  it("rejects malformed, duplicate, and directory manifest entries", async () => {
    const cases: Array<{ name: string; files: unknown[]; setup?: (root: string) => Promise<void> }> = [
      { name: "absolute POSIX path", files: ["/tmp/outside.js"] },
      { name: "absolute Windows path", files: ["C:\\outside.js"] },
      { name: "parent traversal", files: ["../outside.js"] },
      { name: "empty entry", files: [""] },
      { name: "duplicate entry", files: ["index.js", "index.js"] },
      { name: "portable duplicate entry", files: ["esm/index.js", "esm\\index.js"] },
      {
        name: "directory entry",
        files: ["owned-directory"],
        setup: async (root) => mkdir(join(root, "dist", "owned-directory"), { recursive: true })
      },
      { name: "NUL entry", files: ["index.js\0outside"] },
      { name: "mixed-separator escape", files: ["esm\\..\\../outside.js"] }
    ];

    for (const testCase of cases) {
      const root = await createBuildFixture();
      await testCase.setup?.(root);
      await writeBuildManifest(root, testCase.files);
      await expect(runFixtureBuild(root), testCase.name).rejects.toThrow();
    }
  }, 30_000);

  it("cleans only stale manifest-owned files and preserves unrelated dist files", async () => {
    const root = await createBuildFixture();
    const distDirectory = join(root, "dist");
    await mkdir(join(distDirectory, "stale"), { recursive: true });
    await writeFile(join(distDirectory, "index.js"), "old generated artifact\n");
    await writeFile(join(distDirectory, "stale", "removed.js"), "stale generated artifact\n");
    await writeFile(join(distDirectory, "user-kept.txt"), "unrelated user file\n");
    await writeBuildManifest(root, ["index.js", "stale/removed.js"]);

    await expect(runFixtureBuild(root)).resolves.toMatchObject({ stderr: "" });

    await expect(readFile(join(distDirectory, "index.js"), "utf8")).resolves.toBe("exports.fixtureValue = 1;\n");
    await expect(access(join(distDirectory, "stale", "removed.js"))).rejects.toThrow();
    await expect(access(join(distDirectory, "stale"))).rejects.toThrow();
    await expect(readFile(join(distDirectory, "user-kept.txt"), "utf8")).resolves.toBe(
      "unrelated user file\n"
    );

    await rm(distDirectory, { recursive: true });
    await expect(runFixtureBuild(root)).resolves.toMatchObject({ stderr: "" });
    await expect(readFile(join(distDirectory, "esm", "index.js"), "utf8")).resolves.toBe(
      "exports.fixtureValue = 1;\n"
    );
  }, 30_000);
});
