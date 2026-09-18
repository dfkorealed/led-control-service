import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
const DATE_SIDE_EFFECT_ID = "virtual:date-bundle-date-picker-side-effect";
const DATE_STUBS = new Set([
  "/date/Calendar.tsx",
  "/date/DatePicker.tsx",
  "/date/DateRangePicker.tsx",
  "/date/TimePicker.tsx",
  "/date/date-adapters.ts"
]);

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
const stubConsumerSource = `
  import {Calendar,DatePicker,DateRangePicker,TimePicker,parseIsoDate,formatIsoDate,parseLocalTime,formatLocalTime} from "${BARREL_ID}";
  globalThis[Symbol.for("date-bundle-stub-consumer")] = [Calendar,DatePicker,DateRangePicker,TimePicker,parseIsoDate,formatIsoDate,parseLocalTime,formatLocalTime];
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

function stubSourceFor(id) {
  if (![...DATE_STUBS].some(suffix => id.endsWith(suffix))) return undefined;
  const source = readFileSync(id, "utf8");
  // Keep each original source body and import graph discoverable, but make its
  // public runtime export a pure stub. This proves public implementations add
  // no raw emitted cost without relying on the stripped-barrel control.
  if (id.endsWith("/date/Calendar.tsx")) return `${source.replace("export const Calendar =", "const dateBundleOriginalCalendar =")}\nexport const Calendar = () => null;`;
  if (id.endsWith("/date/DatePicker.tsx")) return `${source.replace("export const DatePicker =", "const dateBundleOriginalDatePicker =")}\nexport const DatePicker = () => null;`;
  if (id.endsWith("/date/DateRangePicker.tsx")) return `${source.replace("export const DateRangePicker =", "const dateBundleOriginalDateRangePicker =")}\nexport const DateRangePicker = () => null;`;
  if (id.endsWith("/date/TimePicker.tsx")) return `${source.replace("export const TimePicker =", "const dateBundleOriginalTimePicker =")}\nexport const TimePicker = () => null;`;
  let stub = source;
  for (const name of ["parseIsoDate", "formatIsoDate", "parseLocalTime", "formatLocalTime", "parseBounds", "parseDateRange"]) {
    stub = stub.replace(`export function ${name}`, `function dateBundleOriginal${name}`);
  }
  return `${stub}\nexport const parseIsoDate = value => value;\nexport const formatIsoDate = value => value;\nexport const parseLocalTime = value => value;\nexport const formatLocalTime = value => value;\nexport const parseBounds = () => ({});\nexport const parseDateRange = value => value;`;
}

function closureSignature(entry) {
  return Object.entries(entry.modules).map(([id, module]) => ({
    id,
    renderedLength: module.renderedLength,
    renderedExports: [...module.renderedExports].sort(),
    removedExports: [...module.removedExports].sort()
  })).sort((left, right) => left.id.localeCompare(right.id));
}

function assertStrippedClosure(normalEntry, strippedEntry) {
  const normal = metrics(normalEntry);
  const stripped = metrics(strippedEntry);
  assert.equal(normal.characters, stripped.characters, "Stripped comparison characters must match");
  assert.equal(normal.modules, stripped.modules, "Stripped comparison module count must match");
  assert.deepEqual(normal.dateModules, [], "Normal neutral build must retain no date modules");
  assert.deepEqual(stripped.dateModules, [], "Stripped neutral build must retain no date modules");
  assert.deepEqual(closureSignature(normalEntry), closureSignature(strippedEntry),
    "Stripped comparison retained dependency closure must match exactly");
  return { normal, stripped };
}

function bundlePlugin(mode) {
  return {
    name: "date-bundle-control",
    enforce: "pre",
    resolveId(source) {
      if (source === DATE_SIDE_EFFECT_ID) return "\0" + DATE_SIDE_EFFECT_ID;
      return undefined;
    },
    load(id) {
      if (id === "\0" + DATE_SIDE_EFFECT_ID) return "globalThis[Symbol.for(\"date-bundle-date-picker-side-effect\")] = true;";
      const hasDatePickerSideEffect = mode.startsWith("date-side-effect") && id.endsWith("/date/DatePicker.tsx");
      const hasDatePickerLocalSideEffect = mode.startsWith("date-local-side-effect") && id.endsWith("/date/DatePicker.tsx");
      const stub = mode === "stub-date" ? stubSourceFor(id) : undefined;
      if (stub) return stub;
      if (hasDatePickerSideEffect) {
        return `import "${DATE_SIDE_EFFECT_ID}";\n${readFileSync(id, "utf8")}`;
      }
      if (hasDatePickerLocalSideEffect) return `${readFileSync(id, "utf8")}\nglobalThis[Symbol.for("date-bundle-date-picker-local-side-effect")] = true;`;
      if ((mode === "pure-date" || mode === "impure-date") && id.includes("/src/components/ui/date/") && id.endsWith(".tsx")) {
        const source = readFileSync(id, "utf8");
        return mode === "impure-date" ? source.replaceAll("/* @__PURE__ */", "") : source;
      }
      if (!id.endsWith("/src/components/ui/index.ts")) return undefined;
      if (mode.endsWith("without-date")) return removeDateExports(readFileSync(id, "utf8"));
      return undefined;
    }
  };
}

async function virtualBuild(mode, source) {
  const virtual = "virtual:date-bundle-consumer";
  return build({
    logLevel: "silent",
    build: { write: false, rollupOptions: { input: virtual, output: { inlineDynamicImports: true } } },
    plugins: [{
      name: "date-bundle-virtual-consumer",
      enforce: "pre",
      resolveId(id) { if (id === virtual) return "\0" + virtual; },
      load(id) { if (id === "\0" + virtual) return source; }
    }, bundlePlugin(mode)]
  });
}

async function virtualEntry(mode, source) {
  return entryOf(await virtualBuild(mode, source));
}

function datePickerConsumptionPlugin(consumers) {
  return {
    name: "date-bundle-date-picker-consumption",
    transform(source, id) {
      if (!id.includes("/src/") || !/\.(?:ts|tsx)$/.test(id)) return undefined;
      for (const match of source.matchAll(/\bimport\s+(?:type\s+)?\{([^}]+)\}\s+from\s+["'][^"']*components\/ui(?:\/index)?["']/g)) {
        if (match[1].split(",").some(specifier => specifier.trim().split(/\s+as\s+/)[0] === "DatePicker")) consumers.add(id);
      }
      return undefined;
    }
  };
}

async function productionAppMetrics() {
  const datePickerConsumers = new Set();
  const app = buildMetrics(await build({ logLevel: "silent", build: { write: false }, plugins: [datePickerConsumptionPlugin(datePickerConsumers)] }));
  return { app, datePickerConsumers };
}

async function executeBundle(entry, marker) {
  try {
    await import(`data:text/javascript;base64,${Buffer.from(entry.code).toString("base64")}`);
    return globalThis[marker];
  } finally {
    delete globalThis[marker];
  }
}

function assertImpureNegativeControl(candidate, normal) {
  assert.ok(candidate.dateModules.length >= DATE_COMPONENTS.length && candidate.gzip > normal.gzip && candidate.modules > normal.modules,
    "Removing date PURE annotations must retain date modules and increase the neutral bundle");
}

test("date barrel costs nothing to a neutral public consumer and rejects removed date exports", { timeout: 90_000 }, async context => {
  const normalEntry = await virtualEntry("normal", neutralConsumerSource);
  const stubEntry = await virtualEntry("stub-date", neutralConsumerSource);
  const normal = metrics(normalEntry);
  assert.deepEqual(normal, metrics(stubEntry), "Pure stubs must preserve the raw neutral output exactly");
  assert.deepEqual(normal.dateModules, [], "The neutral Button consumer must not retain date modules");
  context.diagnostic(`Raw normal/stub: ${normal.characters} chars, gzip ${normal.gzip} bytes, ${normal.modules} modules, sha256 ${normal.digest}, date modules ${normal.dateModules.length}`);

  const stripped = assertStrippedClosure(normalEntry, await virtualEntry("without-date", neutralConsumerSource));
  const rawStrippedOutcome = stripped.normal.gzip === stripped.stripped.gzip && stripped.normal.digest === stripped.stripped.digest
    ? "raw output exact"
    : `raw ordering noise (normal gzip ${stripped.normal.gzip}, sha256 ${stripped.normal.digest}; stripped gzip ${stripped.stripped.gzip}, sha256 ${stripped.stripped.digest})`;
  context.diagnostic(`Stripped closure exact; ${rawStrippedOutcome}`);

  const pure = metrics(await virtualEntry("pure-date", neutralConsumerSource));
  assert.throws(() => assertImpureNegativeControl(pure, normal), /Removing date PURE annotations/,
    "The negative-control assertion must fail when PURE annotations remain effective");
  const impure = metrics(await virtualEntry("impure-date", neutralConsumerSource));
  assertImpureNegativeControl(impure, normal);
  assert.throws(() => assert.deepEqual(impure, normal), /AssertionError/);
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

test("stub control replaces every date implementation module", { timeout: 90_000 }, async () => {
  const stub = await virtualEntry("stub-date", stubConsumerSource);
  const retainedStubs = Object.entries(stub.modules).filter(([id]) => stubSourceFor(id));
  assert.equal(retainedStubs.length, DATE_STUBS.size, "The stub control must replace every exported date implementation");
  assert.doesNotMatch(stub.code, /Expected YYYY-MM-DD|max-w-full rounded-popover|minValue must not exceed/,
    "The stub control output must not leak real date implementation code");
});

test("review mutation makes the stripped-barrel comparison fail closed for an unused date side effect", { timeout: 90_000 }, async () => {
  const normal = await virtualEntry("date-side-effect", neutralConsumerSource);
  const control = await virtualEntry("date-side-effect-without-date", neutralConsumerSource);
  assert.throws(() => assertStrippedClosure(normal, control), /must match|closure/,
    "A DatePicker-only side effect must make the stripped-barrel comparison fail");
  assert.ok(metrics(normal).modules > metrics(await virtualEntry("normal", neutralConsumerSource)).modules,
    "The injected DatePicker-only side effect must add an unused-date dependency");
});

test("review mutation makes the stripped-barrel comparison fail closed for a DatePicker-local side effect", { timeout: 90_000 }, async () => {
  const normal = await virtualEntry("date-local-side-effect", neutralConsumerSource);
  const control = await virtualEntry("date-local-side-effect-without-date", neutralConsumerSource);
  assert.throws(() => assertStrippedClosure(normal, control), /must match|closure/,
    "A DatePicker-local side effect must make the stripped-barrel comparison fail");
  assert.ok(metrics(normal).dateModules.some(id => id.endsWith("/date/DatePicker.tsx")),
    "The DatePicker-local side effect must retain DatePicker");
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

  const { app, datePickerConsumers } = await productionAppMetrics();
  const retainsDatePicker = app.dateModules.some(id => id.endsWith("/components/ui/date/DatePicker.tsx"));
  if (datePickerConsumers.size > 0) {
    assert.ok(retainsDatePicker, "The production app DatePicker consumer must build and retain DatePicker");
  }
  context.diagnostic(`Production app: ${app.characters} chars, gzip ${app.gzip} bytes, ${app.modules} modules, sha256 ${app.digest}, date modules ${app.dateModules.length}; DatePicker ${datePickerConsumers.size > 0 ? "consumed and retained" : "not consumed"}`);
});
