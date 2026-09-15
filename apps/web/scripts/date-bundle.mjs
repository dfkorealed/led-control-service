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
async function appBundle(mode) {
  return metrics(entryOf(await build({ logLevel: "silent", build: { write: false }, plugins: [{
    name: "date-bundle-control", enforce: "pre",
    load(id) {
      // The no-date control changes only the barrel in memory; actual files,
      // exports and all other app sources remain untouched. Once pages consume
      // date controls, replace this migration-stage zero-cost contract.
      if (mode === "without-date" && id.endsWith("/src/components/ui/index.ts")) {
        return readFileSync(id, "utf8").split("\n").filter(line => !line.includes('from "./date/')).join("\n");
      }
      // Mutation control proves the comparison catches eager forwardRef calls.
      if (mode === "impure-date" && id.includes("/components/ui/date/") && id.endsWith(".tsx")) {
        return readFileSync(id, "utf8").replaceAll("/* @__PURE__ */", "");
      }
    }
  }] })));
}

test("unused public date exports cost zero while explicit consumers retain executable controls", { timeout: 90_000 }, async (context) => {
  const normal = await appBundle("normal");
  const control = await appBundle("without-date");
  assert.deepEqual(normal, control, "Unused date exports must preserve the exact app entry, compressed bytes and module count");
  assert.deepEqual(normal.dateModules, []);
  context.diagnostic(`Normal/control entry: ${normal.characters} chars, gzip ${normal.gzip} bytes, ${normal.modules} modules, sha256 ${normal.digest}`);

  const impure = await appBundle("impure-date");
  assert.ok(impure.dateModules.length > 0 && impure.gzip > normal.gzip && impure.modules > normal.modules,
    "Removing pure annotations must retain unused date code and increase the bundle");
  assert.throws(() => assert.deepEqual(impure, control), /AssertionError/);
  context.diagnostic(`Negative control: ${impure.characters} chars, gzip ${impure.gzip} bytes, ${impure.modules} modules`);

  const virtual = "virtual:date-bundle-consumer";
  const source = `
    import React from "react";
    import {renderToString} from "react-dom/server";
    import {Calendar,DatePicker,DateRangePicker,TimePicker} from "/src/components/ui/index.ts";
    globalThis[Symbol.for("date-bundle-markup")] = [Calendar,DatePicker,DateRangePicker,TimePicker].map((Component,index) =>
      renderToString(React.createElement(Component,{label:"date-consumer-"+index,value:null,onChange:()=>{}})));
  `;
  const consumer = entryOf(await build({ logLevel: "silent", build: { write: false, rollupOptions: { input: virtual, output: { inlineDynamicImports: true } } }, plugins: [{
    name: "date-bundle-consumer", enforce: "pre",
    resolveId(id) { if (id === virtual) return "\0" + virtual; },
    load(id) { if (id === "\0" + virtual) return source; }
  }] }));
  for (const name of ["Calendar", "DatePicker", "DateRangePicker", "TimePicker"]) {
    assert.ok(Object.keys(consumer.modules).some(id => id.endsWith(`/components/ui/date/${name}.tsx`)), `${name} must remain when explicitly used`);
  }
  const marker = Symbol.for("date-bundle-markup");
  try {
    // Execute the real production output without a browser. Interactive behavior
    // is also exercised by the required production Chromium UI-foundation gate.
    await import(`data:text/javascript;base64,${Buffer.from(consumer.code).toString("base64")}`);
    const rendered = globalThis[marker];
    assert.equal(rendered.length, 4);
    for (const [index, html] of rendered.entries()) assert.ok(html.includes(`date-consumer-${index}`), `Consumer ${index} must render its public control`);
    context.diagnostic("Explicit consumer: all four date modules retained and all four controls rendered");
  } finally { delete globalThis[marker]; }
});
