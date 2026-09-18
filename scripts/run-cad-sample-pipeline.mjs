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
    "CAD_SAMPLE_DWG_PATH",
    "CAD_SAMPLE_CONVERTER_PATH",
    "CAD_SAMPLE_CONVERTER_ARGV_JSON"
  ];
  const missing = required.filter(name => !environment[name]);
  if (missing.length > 0 || environment.RUN_OBJECT_STORAGE_INTEGRATION !== "true") {
    const detail = missing.length > 0 ? `missing ${missing.join(", ")}` : "RUN_OBJECT_STORAGE_INTEGRATION must be true";
    throw new Error(`CAD sample environment is incomplete: ${detail}`);
  }

  const argv = JSON.parse(environment.CAD_SAMPLE_CONVERTER_ARGV_JSON);
  if (!Array.isArray(argv) || argv.length === 0 || argv.some(argument => typeof argument !== "string")) {
    throw new Error("CAD_SAMPLE_CONVERTER_ARGV_JSON must be a non-empty JSON string array");
  }
  const source = await stat(environment.CAD_SAMPLE_DWG_PATH);
  if (!source.isFile()) throw new Error("CAD_SAMPLE_DWG_PATH must reference a regular file");
  await access(environment.CAD_SAMPLE_CONVERTER_PATH, constants.X_OK);

  // Rebuild the fork target from this checkout after preparing its workspace dependencies.
  await rm(resolve(root, "apps/api/dist"), { recursive: true, force: true });
  await runCommand(["run", "workspace:prepare"]);
  await runCommand(["--filter", "@led-control/api", "build"]);
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
