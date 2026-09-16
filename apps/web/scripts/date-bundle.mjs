import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import test from "node:test";

// This serial gate is intentionally outside Vitest. Production builds must not
// compete with the ordinary parallel tests for Vite transforms or shared files.
process.chdir(fileURLToPath(new URL("..", import.meta.url)));
process.env.NODE_ENV = "production";
const { build } = await import("vite");

const BARREL_ID = "/src/components/ui/index.ts";
const DATE_COMPONENTS = ["Calendar", "DatePicker", "DateRangePicker", "TimePicker"];
const NEUTRAL_MARKER = Symbol.for("date-bundle-neutral-markup");
const DATE_MARKER = Symbol.for("date-bundle-markup");
const APP_SOURCE_REF = process.env.DATE_BUNDLE_APP_SOURCE_REF;

const neutralConsumerSource = `
  import React from "react";
  import {renderToString} from "react-dom/server";
  import {Button} from "${BARREL_ID}";
  globalThis[Symbol.for("date-bundle-neutral-markup")] = renderToString(
    React.createElement(Button, null, "neutral-consumer"));
`;
const dateConsumerSource = `
  import React from "react";
  import {renderToString} from "react-dom/server";
  import {Calendar,DatePicker,DateRangePicker,TimePicker} from "${BARREL_ID}";
  globalThis[Symbol.for("date-bundle-markup")] = [Calendar,DatePicker,DateRangePicker,TimePicker].map((Component,index) =>
    renderToString(React.createElement(Component,{label:"date-consumer-"+index,value:null,onChange:()=>{}})));
`;

function entryOf(result) {
  assert.ok(!Array.isArray(result) && "output" in result, "Expected one memory build");
  const entry = result.output.find(asset => asset.type === "chunk" && asset.isEntry);
  assert.ok(entry, "Missing production entry");
  return entry;
}

function metrics(entry) {
  return {
    characters: entry.code.length,
    gzip: gzipSync(entry.code).length,
    modules: Object.keys(entry.modules).length,
    digest: createHash("sha256").update(entry.code).digest("hex"),
    dateModules: Object.keys(entry.modules).filter(id => id.includes("/components/ui/date/"))
  };
}

function buildMetrics(result) {
  const outputs = Array.isArray(result) ? result : [result];
  const chunks = outputs.flatMap(output => output.output.filter(asset => asset.type === "chunk"));
  const code = chunks.sort((left, right) => left.fileName.localeCompare(right.fileName)).map(chunk => chunk.code).join("\n");
  const moduleIds = [...new Set(chunks.flatMap(chunk => Object.keys(chunk.modules)))].sort();
  return {
    characters: code.length,
    gzip: gzipSync(code).length,
    modules: moduleIds.length,
    digest: createHash("sha256").update(code).digest("hex"),
    dateModules: moduleIds.filter(id => id.includes("/components/ui/date/"))
  };
}

function removeDateExports(source) {
  return source.split("\n").filter(line => !line.includes('from "./date/')).join("\n");
}

function bundlePlugin(mode) {
  return {
    name: "date-bundle-control",
    enforce: "pre",
    load(id) {
      if (!id.endsWith("/src/components/ui/index.ts")) return undefined;
      const source = readFileSync(id, "utf8");
      if (mode === "without-date") return removeDateExports(source);
      if (mode === "impure-date") {
        // This deliberate impure mutation makes date re-exports executable.
        // It proves the neutral comparison detects a reachable date dependency.
        return `${source}\nimport { Calendar as dateBundleCalendar } from "./date/Calendar";\nimport { DatePicker as dateBundleDatePicker } from "./date/DatePicker";\nimport { DateRangePicker as dateBundleDateRangePicker } from "./date/DateRangePicker";\nimport { TimePicker as dateBundleTimePicker } from "./date/TimePicker";\nglobalThis[Symbol.for("date-bundle-impure-control")] = [dateBundleCalendar, dateBundleDatePicker, dateBundleDateRangePicker, dateBundleTimePicker];\n`;
      }
      return undefined;
    }
  };
}

async function virtualEntry(mode, source) {
  const virtual = "virtual:date-bundle-consumer";
  return entryOf(await build({
    logLevel: "silent",
    build: { write: false, rollupOptions: { input: virtual, output: { inlineDynamicImports: true }, treeshake: { moduleSideEffects: mode === "impure-date" } } },
    plugins: [{
      name: "date-bundle-virtual-consumer",
      enforce: "pre",
      resolveId(id) { if (id === virtual) return "\0" + virtual; },
      load(id) { if (id === "\0" + virtual) return source; }
    }, bundlePlugin(mode)]
  }));
}

async function productionAppMetrics() {
  const plugins = APP_SOURCE_REF ? [{
    name: "date-bundle-git-source",
    enforce: "pre",
    load(id) {
      const relativePath = path.relative(process.cwd(), id);
      if (!relativePath.startsWith("src/") || !/\.(?:ts|tsx)$/.test(relativePath)) return undefined;
      return execFileSync("git", ["show", `${APP_SOURCE_REF}:apps/web/${relativePath}`], { encoding: "utf8" });
    }
  }] : undefined;
  return buildMetrics(await build({ logLevel: "silent", build: { write: false }, plugins }));
}

async function executeBundle(entry, marker) {
  try {
    await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString("base64")}`);
    return globalThis[marker];
  } finally {
    delete globalThis[marker];
  }
}

test("date barrel costs nothing to a neutral public consumer and rejects removed date exports", { timeout: 90_000 }, async context => {
  const normalEntry = await virtualEntry("normal", neutralConsumerSource);
  const controlEntry = await virtualEntry("without-date", neutralConsumerSource);
  const normal = metrics(normalEntry);
  const control = metrics(controlEntry);
  assert.deepEqual(normal, control, "Removing date exports must preserve the neutral entry exactly");
  assert.deepEqual(normal.dateModules, [], "The neutral Button consumer must not retain date modules");
  context.diagnostic(`Normal/control neutral entry: ${normal.characters} chars, gzip ${normal.gzip} bytes, ${normal.modules} modules, sha256 ${normal.digest}, date modules ${normal.dateModules.length}`);

  const impure = metrics(await virtualEntry("impure-date", neutralConsumerSource));
  assert.ok(impure.dateModules.length >= DATE_COMPONENTS.length && impure.gzip > normal.gzip && impure.modules > normal.modules,
    "The impure negative control must retain date modules and increase the neutral bundle");
  assert.throws(() => assert.deepEqual(impure, control), /AssertionError/);
  context.diagnostic(`Negative control: ${impure.characters} chars, gzip ${impure.gzip} bytes, ${impure.modules} modules, sha256 ${impure.digest}, date modules ${impure.dateModules.length}`);

  const neutral = await executeBundle(normalEntry, NEUTRAL_MARKER);
  assert.ok(neutral.includes("neutral-consumer"), "The neutral consumer must execute and render Button");

  // This controlled failure proves that the no-date control really removes
  // exports. If it stopped doing so, a date consumer would build successfully.
  await assert.rejects(
    () => virtualEntry("without-date", dateConsumerSource),
    /not exported|MISSING_EXPORT/,
    "The no-date control must reject date consumers"
  );
});

test("explicit date consumers and the production app retain DatePicker when consumed", { timeout: 90_000 }, async context => {
  const virtualEntryResult = await virtualEntry("normal", dateConsumerSource);
  const virtual = metrics(virtualEntryResult);
  for (const name of DATE_COMPONENTS) {
    assert.ok(virtual.dateModules.some(id => id.endsWith(`/components/ui/date/${name}.tsx`)), `${name} must remain when explicitly used`);
  }
  const rendered = await executeBundle(virtualEntryResult, DATE_MARKER);
  assert.equal(rendered.length, DATE_COMPONENTS.length);
  for (const [index, html] of rendered.entries()) assert.ok(html.includes(`date-consumer-${index}`), `Consumer ${index} must render its public control`);
  context.diagnostic(`Explicit consumer: ${virtual.characters} chars, gzip ${virtual.gzip} bytes, ${virtual.modules} modules, sha256 ${virtual.digest}, date modules ${virtual.dateModules.length}`);

  const app = await productionAppMetrics();
  const retainsDatePicker = app.dateModules.some(id => id.endsWith("/components/ui/date/DatePicker.tsx"));
  if (process.env.DATE_BUNDLE_REQUIRE_DATE_PICKER === "1") {
    assert.ok(retainsDatePicker, "The production app DatePicker consumer must build and retain DatePicker");
  }
  const source = APP_SOURCE_REF ? `git ${APP_SOURCE_REF}` : "working tree";
  context.diagnostic(`Production app (${source}): ${app.characters} chars, gzip ${app.gzip} bytes, ${app.modules} modules, sha256 ${app.digest}, date modules ${app.dateModules.length}; DatePicker ${retainsDatePicker ? "retained" : "not consumed"}`);
});
