import { constants } from "node:fs";
import { access, rm, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const required = [
  "CAD_SAMPLE_DWG_PATH",
  "CAD_SAMPLE_CONVERTER_PATH",
  "CAD_SAMPLE_CONVERTER_ARGV_JSON"
];
const missing = required.filter(name => !process.env[name]);
if (missing.length > 0 || process.env.RUN_OBJECT_STORAGE_INTEGRATION !== "true") {
  const detail = missing.length > 0 ? `missing ${missing.join(", ")}` : "RUN_OBJECT_STORAGE_INTEGRATION must be true";
  throw new Error(`CAD sample environment is incomplete: ${detail}`);
}

const argv = JSON.parse(process.env.CAD_SAMPLE_CONVERTER_ARGV_JSON);
if (!Array.isArray(argv) || argv.length === 0 || argv.some(argument => typeof argument !== "string")) {
  throw new Error("CAD_SAMPLE_CONVERTER_ARGV_JSON must be a non-empty JSON string array");
}
const source = await stat(process.env.CAD_SAMPLE_DWG_PATH);
if (!source.isFile()) throw new Error("CAD_SAMPLE_DWG_PATH must reference a regular file");
await access(process.env.CAD_SAMPLE_CONVERTER_PATH, constants.X_OK);

// A clean child artifact binds the forked runtime to this checkout instead of an ignored stale dist file.
await rm(resolve(root, "apps/api/dist"), { recursive: true, force: true });
run(["--filter", "@led-control/api", "build"]);
run([
  "--filter", "@led-control/api", "exec", "jest",
  "src/floor-import/cad-sample-pipeline.integration.spec.ts", "--runInBand"
]);

function run(args) {
  const result = spawnSync("pnpm", args, { cwd: root, env: process.env, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
