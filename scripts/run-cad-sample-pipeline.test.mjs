import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCadSamplePipeline } from "./run-cad-sample-pipeline.mjs";

test("CAD sample pipeline prepares a clean workspace before building the API", async () => {
  const root = await mkdtemp(join(tmpdir(), "cad-sample-clean-workspace-"));
  const samplePath = join(root, "sample.dwg");
  const converterPath = join(root, "dwgread");
  const calls = [];
  await writeFile(samplePath, "sample");
  await writeFile(converterPath, "#!/bin/sh\nexit 0\n");
  await chmod(converterPath, 0o700);

  try {
    await runCadSamplePipeline({
      root,
      environment: {
        CAD_SAMPLE_DWG_PATH: samplePath,
        CAD_SAMPLE_CONVERTER_PATH: converterPath,
        CAD_SAMPLE_CONVERTER_ARGV_JSON: '["-O","DXF","-o","{output}","{input}"]',
        RUN_OBJECT_STORAGE_INTEGRATION: "true"
      },
      runCommand: async (args) => {
        calls.push(args);
        if (calls.length === 1) {
          assert.deepEqual(args, ["run", "workspace:prepare"]);
          await mkdir(join(root, "packages/shared/dist"), { recursive: true });
          await mkdir(join(root, "packages/automation-engine/dist"), { recursive: true });
          return;
        }
        await access(join(root, "packages/shared/dist"));
        await access(join(root, "packages/automation-engine/dist"));
        if (calls.length === 2) {
          assert.deepEqual(args, ["--filter", "@led-control/api", "build"]);
          await mkdir(join(root, "apps/api/dist"), { recursive: true });
          return;
        }
        await access(join(root, "apps/api/dist"));
      }
    });

    assert.deepEqual(calls, [
      ["run", "workspace:prepare"],
      ["--filter", "@led-control/api", "build"],
      [
        "--filter", "@led-control/api", "exec", "jest",
        "src/floor-import/cad-sample-pipeline.integration.spec.ts", "--runInBand"
      ]
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
