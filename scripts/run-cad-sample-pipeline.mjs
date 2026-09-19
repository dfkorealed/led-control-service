import { constants } from "node:fs";
import { access, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function runCadSamplePipeline(options = {}) {
  const root = options.root ?? repositoryRoot;
  const environment = options.environment ?? process.env;
  const runCommand = options.runCommand ?? (args => run(args, root, environment));
  const required = [
    "CAD_SAMPLE_CONVERTER_PATH",
    "CAD_SAMPLE_CONVERTER_ARGV_JSON"
  ];
  const missing = required.filter(name => !environment[name]);
  if (missing.length > 0 || environment.RUN_OBJECT_STORAGE_INTEGRATION !== "true") {
    const detail = missing.length > 0 ? `missing ${missing.join(", ")}` : "RUN_OBJECT_STORAGE_INTEGRATION must be true";
    throw new Error(`CAD sample environment is incomplete: ${detail}`);
  }
  if (Boolean(environment.CAD_SAMPLE_DWG_PATH) === Boolean(environment.CAD_SAMPLE_DWG_PATHS_JSON)) {
    throw new Error("Specify exactly one of CAD_SAMPLE_DWG_PATH or CAD_SAMPLE_DWG_PATHS_JSON");
  }
  const samples = environment.CAD_SAMPLE_DWG_PATHS_JSON
    ? JSON.parse(environment.CAD_SAMPLE_DWG_PATHS_JSON)
    : [environment.CAD_SAMPLE_DWG_PATH];
  if (!Array.isArray(samples) || samples.length === 0 || samples.some(sample => typeof sample !== "string" || !sample.trim())) {
    throw new Error("CAD_SAMPLE_DWG_PATHS_JSON must be a non-empty JSON string array");
  }

  const argv = JSON.parse(environment.CAD_SAMPLE_CONVERTER_ARGV_JSON);
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(argument => typeof argument !== "string")) {
    throw new Error("CAD_SAMPLE_CONVERTER_ARGV_JSON must be a non-empty JSON string array");
  }
  for (const sample of samples) {
    const source = await stat(sample);
    if (!source.isFile()) throw new Error("CAD sample paths must reference regular files");
  }
  await access(environment.CAD_SAMPLE_CONVERTER_PATH, constants.X_OK);

  if (environment.CAD_SAMPLE_REUSE_API_DIST === "true") {
    // Watch builds and other workspace owners must not lose their existing dist.
    await access(resolve(root, "apps/api/dist/src/floor-import/cad-core-child.js"));
  } else {
    await rm(resolve(root, "apps/api/dist"), { recursive: true, force: true });
    await runCommand(["run", "workspace:prepare"]);
    await runCommand(["--filter", "@led-control/api", "prisma:generate"]);
    await runCommand(["--filter", "@led-control/api", "build"]);
  }
  await runCommand([
    "--filter", "@led-control/api", "exec", "jest",
    "src/floor-import/cad-sample-pipeline.integration.spec.ts", "--runInBand"
  ]);
}

function run(args, root, environment) {
  const result = spawnSync("pnpm", args, { cwd: root, env: environment, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runCadSamplePipeline();
}
