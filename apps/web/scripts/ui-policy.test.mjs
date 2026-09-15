import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { inspectUiSource } from "./ui-policy.mjs";

test("rejects arbitrary spacing, raw colors and production querySelector", () => {
  const violations = inspectUiSource("sample.tsx", 'className="p-[13px] text-[#fff]"; node.querySelector("button")');
  assert.deepEqual(violations.map(({ rule }) => rule), ["arbitrary-spacing", "raw-color", "query-selector"]);
  assert.deepEqual(violations[0], { rule: "arbitrary-spacing", path: "sample.tsx", match: "p-[13px]" });
});

test("accepts all approved spacing steps, semantic colors and typography", () => {
  const source = 'className="p-0.5 p-1 p-1.5 p-2 p-2.5 p-3 p-3.5 p-4 p-4.5 p-5 p-6 p-7 p-8 p-10 p-12 p-16 p-0 -mt-2 mx-auto top-1/2 max-compact:gap-3 bg-surface-panel text-content-primary text-body rounded-panel shadow-panel"';
  assert.deepEqual(inspectUiSource("sample.tsx", source), []);
});

test("blocks numeric spacing outside the approved scale, including variants and negatives", () => {
  assert.deepEqual(inspectUiSource("sample.tsx", '"p-9 hover:gap-11 -mt-13 max-compact:px-0.75 inset-15"').map(v => v.rule), Array(5).fill("unapproved-spacing"));
});

test("blocks variable arbitrary spacing, arbitrary colors and stock palette classes", () => {
  assert.deepEqual(inspectUiSource("sample.tsx", '"p-(--custom) bg-[var(--custom)] text-red-500"').map(v => v.rule), ["arbitrary-spacing", "arbitrary-color", "unapproved-color"]);
});

test("blocks CSS and React literal spacing and typography without flagging geometry", () => {
  assert.deepEqual(inspectUiSource("sample.tsx", 'style={{ padding: 13, gap: "1rem", fontSize: 17, lineHeight: 1.7, letterSpacing: "0.1em", width: 44, height: "100%", top: position.y }}').map(v => v.rule), ["literal-spacing", "literal-spacing", "literal-typography", "literal-typography", "literal-typography"]);
  assert.deepEqual(inspectUiSource("src/styles/base.css", 'body { margin: 0; padding: 13px 1rem; font-size: 17px; border: 1px solid var(--color-border-default); min-height: 44px; }').filter(v => v.rule !== "css-selector").map(v => v.rule), ["literal-spacing", "literal-typography"]);
});

test("rejects literal colors in CSS, SVG props and style objects", () => {
  assert.deepEqual(inspectUiSource("sample.tsx", '<path fill="white" stroke="#ff00aa" style={{ color: "rgb(1 2 3)", background: "rebeccapurple" }} />').map(v => v.rule), Array(4).fill("raw-color"));
});

test("blocks stock and arbitrary typography, fractional padding and subpixel literals", () => {
  assert.deepEqual(inspectUiSource("sample.tsx", '"text-sm leading-7 tracking-wide text-[17px] p-1/2"; style={{ gap: 0.5 }}').map(v => v.rule), ["unapproved-typography", "unapproved-typography", "unapproved-typography", "arbitrary-typography", "unapproved-spacing", "literal-spacing"]);
});

test("theme permits only token declarations, not arbitrary rules or new CSS imports", () => {
  const path = "src/styles/theme.css";
  assert.deepEqual(inspectUiSource(path, '@theme static { --color-surface-panel: #fff; --text-body: 0.875rem; --text-body--line-height: 1.375rem; --radius-control: 0.625rem; --shadow-panel: 0 8px 24px rgb(30 64 175 / 0.06); --spacing: 4px; --breakpoint-compact: 47.5rem; }'), []);
  assert.ok(inspectUiSource(path, 'body { color: #fff; padding: 13px; }').some(v => v.rule === "raw-color"));
  assert.ok(inspectUiSource(path, '@import "./rogue.css";').some(v => v.rule === "css-import"));
  assert.ok(inspectUiSource("src/other/theme.css", '@theme { --color-test: #fff; }').some(v => v.rule === "raw-color"));
});

test("allows exact entry imports and main entry only", () => {
  assert.deepEqual(inspectUiSource("src/styles.css", '@import "tailwindcss"; @import "./styles/theme.css"; @import "./styles/base.css"; @import "./styles/exceptions.css";'), []);
  assert.deepEqual(inspectUiSource("src/main.tsx", 'import "./styles.css";'), []);
  assert.ok(inspectUiSource("src/page.tsx", 'import "./page.css";').some(v => v.rule === "css-import"));
  assert.ok(inspectUiSource("src/page.tsx", 'import("./page.css");').some(v => v.rule === "css-import"));
});

test("inventories unapproved CSS files, selectors and raw form styling", () => {
  const violations = inspectUiSource("src/page.css", '.new-panel { display: grid; } input { appearance: none; }');
  assert.ok(violations.some(v => v.rule === "css-file"));
  assert.equal(violations.filter(v => v.rule === "css-selector").length, 2);
  assert.ok(violations.some(v => v.rule === "raw-form-style"));
});

test("blocks newly styled native fields outside the shared UI ownership boundary", () => {
  const source = '<input className="p-2" />';
  assert.ok(inspectUiSource("src/features/example.tsx", source).some(v => v.rule === "raw-form-style"));
  assert.deepEqual(inspectUiSource("src/components/ui/TextField.tsx", source), []);
});

test("rejects unquoted CSS URL imports", () => {
  assert.ok(inspectUiSource("src/styles.css", '@import url(./rogue.css);').some(v => v.rule === "css-import"));
});

test("skips test-only paths and comments, not production paths containing test", () => {
  for (const path of ["src/page.test.tsx", "src/page.spec.ts", "src/test/fixture.ts", "e2e/page.ts"]) {
    assert.deepEqual(inspectUiSource(path, '"p-[13px]"; node.querySelector("button")'), []);
  }
  assert.deepEqual(inspectUiSource("src/latest.tsx", '// "p-[13px]"\n/* color: #fff; */'), []);
  assert.equal(inspectUiSource("src/latest.tsx", 'node.querySelectorAll("button")').length, 1);
});

test("rejects TypeScript generic and optional-chain production DOM queries", () => {
  assert.deepEqual(inspectUiSource("src/Modal.tsx", 'ref.current?.querySelector<HTMLElement>(selector); dialog.querySelectorAll<HTMLButtonElement>(selector)').map(v => v.rule), ["query-selector", "query-selector"]);
});

test("CLI inventories only production src and fails on new or increased debt", async () => {
  const root = await mkdtemp(join(tmpdir(), "led-ui-policy-"));
  const cli = new URL("./ui-policy.mjs", import.meta.url);
  const run = () => spawnSync(process.execPath, [cli.pathname, "--root", root], { encoding: "utf8" });
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "src/legacy.tsx"), '"p-[13px]"');
    await writeFile(join(root, "src/ignored.test.tsx"), '"p-[15px]"');
    await writeFile(join(root, "scripts/ui-policy-baseline.json"), JSON.stringify({ version: 1, sourceRef: "test-fixture", files: { "src/legacy.tsx": { "arbitrary-spacing": { count: 1, matches: { "p-[13px]": 1 } } } } }));
    assert.equal(run().status, 0);
    await writeFile(join(root, "src/legacy.tsx"), '"p-[13px] p-[13px]"');
    assert.equal(run().status, 1);
    await writeFile(join(root, "src/legacy.tsx"), '"p-[15px]"');
    assert.equal(run().status, 1, "a different violation cannot consume removed debt");
    await writeFile(join(root, "src/legacy.tsx"), '"gap-3"');
    assert.equal(run().status, 0);
    await writeFile(join(root, "src/new.tsx"), '"p-[13px]"');
    assert.equal(run().status, 1, "new files have no baseline allowance");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
