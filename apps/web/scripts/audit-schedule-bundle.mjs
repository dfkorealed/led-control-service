import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const MAX_MAIN_BYTES = 1_070_000;
const MAX_MAIN_GZIP_BYTES = 325_000;
const ROOT_RUNTIME_SUFFIX = "/packages/shared/dist/index.js";
const BROWSER_CONTRACT_SUFFIX = "/packages/shared/src/automation-action-result-contracts.ts";
const SCHEDULE_PANEL_SUFFIX = "/apps/web/src/features/control/automation/ScheduleControlPanel.tsx";
const UNRELATED_GATEWAY_MESSAGE =
  "destinationAddress must be a BLE Mesh group address from 0xc000 to 0xfeff";

const configFile = fileURLToPath(new URL("../vite.config.ts", import.meta.url));
const buildResult = await build({
  configFile,
  logLevel: "silent",
  build: { write: false }
});
const rollupResults = Array.isArray(buildResult) ? buildResult : [buildResult];
const outputs = rollupResults.flatMap((result) => result.output);
const chunks = outputs.filter((output) => output.type === "chunk");
const mainChunk = chunks.find((output) =>
  output.type === "chunk"
  && output.isEntry
  && normalizePath(output.facadeModuleId ?? "").endsWith("/apps/web/index.html")
);

if (!mainChunk || mainChunk.type !== "chunk") {
  throw new Error("Web main entry chunk was not produced by the production bundle audit");
}

const moduleIds = chunks.flatMap((chunk) => Object.keys(chunk.modules).map(normalizePath));
const scheduleChunk = chunks.find((chunk) =>
  Object.keys(chunk.modules).map(normalizePath).some((moduleId) => moduleId.endsWith(SCHEDULE_PANEL_SUFFIX))
);
// Vite 5 reports minified JS size from code.length, including this repository's Korean literals.
const rawBytes = mainChunk.code.length;
const gzipBytes = gzipSync(mainChunk.code).byteLength;
const failures = [];

if (!scheduleChunk) {
  failures.push("ScheduleControlPanel is missing from the audited production graph");
}
if (moduleIds.some((moduleId) => moduleId.endsWith(ROOT_RUNTIME_SUFFIX))) {
  failures.push("ScheduleControlPanel pulled the @led-control/shared CommonJS root into the production graph");
}
if (!moduleIds.some((moduleId) => moduleId.endsWith(BROWSER_CONTRACT_SUFFIX))) {
  failures.push("the narrow shared browser automation-contracts entry is missing from the production graph");
}
if (mainChunk.code.includes(UNRELATED_GATEWAY_MESSAGE)) {
  failures.push("the main entry contains an unrelated Gateway contract");
}
if (rawBytes > MAX_MAIN_BYTES) {
  failures.push(`main entry is ${formatKilobytes(rawBytes)} kB, over the ${formatKilobytes(MAX_MAIN_BYTES)} kB limit`);
}
if (gzipBytes > MAX_MAIN_GZIP_BYTES) {
  failures.push(`main entry gzip is ${formatKilobytes(gzipBytes)} kB, over the ${formatKilobytes(MAX_MAIN_GZIP_BYTES)} kB limit`);
}

if (failures.length > 0) {
  throw new Error(`Schedule bundle audit failed:\n- ${failures.join("\n- ")}`);
}

console.log(
  `Schedule bundle audit passed: main ${formatKilobytes(rawBytes)} kB / gzip ${formatKilobytes(gzipBytes)} kB`
);

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

function formatKilobytes(bytes) {
  return (bytes / 1000).toFixed(2);
}
