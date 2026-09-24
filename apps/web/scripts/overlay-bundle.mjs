import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import test from "node:test";
import { JSDOM, VirtualConsole } from "jsdom";

// Serial, memory-only production builds must not compete with ordinary Vitest
// transforms. CI invokes this after the independent date tree-shaking gate.
process.chdir(fileURLToPath(new URL("..", import.meta.url)));
process.env.NODE_ENV = "production";
const { build } = await import("vite");
const unusedOverlay = /\/components\/ui\/overlays\/(DropdownMenu|Popover)\.tsx$/;
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
    overlayModules: Object.keys(entry.modules).filter(id => unusedOverlay.test(id))
  };
}
async function appBundle(mode) {
  return metrics(entryOf(await build({ logLevel: "silent", build: { write: false }, plugins: [{
    name: "overlay-bundle-control", enforce: "pre",
    load(id) {
      if (mode === "without-overlay" && id.endsWith("/src/components/ui/index.ts")) {
        return readFileSync(id, "utf8").split("\n").filter(line => !/from "\.\/overlays\/(DropdownMenu|Popover)"/.test(line)).join("\n");
      }
      if (mode === "impure-overlay" && unusedOverlay.test(id)) return readFileSync(id, "utf8").replaceAll("/* @__PURE__ */", "");
    }
  }] })));
}

test("unused public overlay exports cost zero while explicit consumers retain and render both controls", { timeout: 90_000 }, async context => {
  const normal = await appBundle("normal");
  const control = await appBundle("without-overlay");
  assert.deepEqual(normal, control, "Unused Dropdown/Popover must preserve the exact app entry, gzip and module count");
  assert.deepEqual(normal.overlayModules, []);
  context.diagnostic(`Normal/control: ${normal.characters} chars, gzip ${normal.gzip} bytes, ${normal.modules} modules, sha256 ${normal.digest}; delta 0/0/0`);
  const impure = await appBundle("impure-overlay");
  assert.ok(impure.overlayModules.length === 2 && impure.gzip > normal.gzip && impure.modules > normal.modules,
    "Removing pure annotations must retain both unused overlays and grow the bundle");
  assert.throws(() => assert.deepEqual(impure, control), /AssertionError/);
  context.diagnostic(`Negative control: ${impure.characters} chars, gzip ${impure.gzip} bytes, ${impure.modules} modules; delta ${impure.characters - normal.characters}/${impure.gzip - normal.gzip}/${impure.modules - normal.modules}`);

  const virtual = "virtual:overlay-bundle-consumer";
  const source = `
    import React,{useRef} from "react";
    import {createRoot} from "react-dom/client";
    import {flushSync} from "react-dom";
    import {DropdownMenu,Popover,SessionStatusCenter,SessionStatusProvider,ToastRegion} from "/src/components/ui/index.ts";
    const el=React.createElement;
    function App(){
      const trigger=useRef(null);
      return el(SessionStatusProvider,null,
        el(React.Fragment,null,
          el(DropdownMenu,{label:"dropdown-consumer",items:[{id:0,label:"action"}],onAction:()=>{}}),
          el("button",{ref:trigger},"anchor"),
          el(Popover,{isOpen:true,triggerRef:trigger,label:"popover-consumer"},el("button",null,"popover-body")),
          el(SessionStatusCenter),el(ToastRegion)));
    }
    const container=document.createElement("div");document.body.append(container);
    const root=createRoot(container);flushSync(()=>root.render(el(App)));
    globalThis[Symbol.for("overlay-bundle-root")]=()=>{flushSync(()=>root.unmount());container.remove();};
  `;
  const consumer = entryOf(await build({ logLevel: "silent", build: { write: false, rollupOptions: { input: virtual, output: { inlineDynamicImports: true } } }, plugins: [{
    name: "overlay-bundle-consumer", enforce: "pre",
    resolveId(id) { if (id === virtual) return "\0" + virtual; },
    load(id) { if (id === "\0" + virtual) return source; }
  }] }));
  for (const name of ["DropdownMenu", "Popover"]) assert.ok(Object.keys(consumer.modules).some(id => id.endsWith(`/components/ui/overlays/${name}.tsx`)), `${name} must remain when used`);
  for (const name of ["SessionStatusProvider", "SessionStatusCenter", "ToastRegion"]) assert.ok(Object.keys(consumer.modules).some(id => id.endsWith(`/components/ui/session-status/${name}.tsx`)), `${name} must remain when used`);

  // A browserless DOM executes the actual production chunk, including an open
  // portal. Geometry/keyboard/accessibility are separately proven in Chromium.
  const errors = [];
  const console = new VirtualConsole();
  console.on("jsdomError", error => {
    // JSDOM 25 cannot parse cascade layers. Only this exact upstream pressable
    // rule is ignored; real CSS is exercised by Chromium, all other errors fail.
    if (error.type === "css parsing" && error.detail?.trim() === "@layer {\n  [data-react-aria-pressable] {\n    touch-action: pan-x pan-y pinch-zoom;\n  }\n}") return;
    errors.push(error.message);
  });
  const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "http://localhost", pretendToBeVisual: true, virtualConsole: console });
  const keys = ["window", "document", "navigator", "CSS", "Node", "Element", "HTMLElement", "HTMLButtonElement", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "SVGElement", "NodeFilter", "MutationObserver", "Event", "CustomEvent", "FocusEvent", "KeyboardEvent", "getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"];
  const saved = new Map(keys.map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const marker = Symbol.for("overlay-bundle-root");
  try {
    for (const key of keys) {
      // JSDOM omits CSS.escape; the fixture uses ordinary generated IDs, whose
      // punctuation is escaped with CSS hexadecimal escapes for Aria selectors.
      const value = key === "window" ? dom.window : key === "CSS" ? { escape: value => String(value).replace(/[^a-zA-Z0-9_-]/g, character => `\\${character.codePointAt(0).toString(16)} `), supports: () => false } : dom.window[key];
      Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: ["getComputedStyle", "requestAnimationFrame", "cancelAnimationFrame"].includes(key) ? value.bind(dom.window) : value });
    }
    await import(`data:text/javascript;base64,${Buffer.from(consumer.code + "\n//# sourceURL=overlay-bundle-consumer.js").toString("base64")}`);
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(dom.window.document.body.textContent.includes("dropdown-consumer"), "Dropdown trigger must render");
    assert.ok(dom.window.document.body.textContent.includes("popover-body"), "Open Popover must render its portal content");
    assert.ok(dom.window.document.body.textContent.includes("상태"), "Session status trigger must render");
    context.diagnostic("Explicit consumer: DropdownMenu, Popover and session status feedback retained; production triggers and open portal rendered in browserless DOM");
  } finally {
    globalThis[marker]?.();
    delete globalThis[marker];
    await new Promise(resolve => setTimeout(resolve, 25));
    dom.window.close();
    for (const [key, descriptor] of saved) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  }
  assert.deepEqual(errors, [], "Production consumer must not throw browserless runtime errors");
});
