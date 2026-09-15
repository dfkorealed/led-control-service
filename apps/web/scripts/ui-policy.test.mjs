import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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

test("I1 rejects px spacing utilities and static calc/clamp without banning runtime positions", () => {
  assert.deepEqual(inspectUiSource("src/New.tsx", '<div className="p-px hover:gap-px max-compact:-mt-px" />').map(v => v.rule), ["unapproved-spacing", "unapproved-spacing", "unapproved-spacing"]);
  const css = 'body { padding: calc(13px); gap: clamp(0px, 13px, 20px); margin: calc(var(--space-1) + 13px); }';
  assert.deepEqual(inspectUiSource("src/styles/base.css", css).map(v => v.rule), ["literal-spacing", "literal-spacing", "literal-spacing"]);
  assert.equal(inspectUiSource("src/New.tsx", 'style={{ padding: "calc(13px)", gap: "clamp(0px, 13px, 20px)" }}').filter(v => v.rule === "literal-spacing").length, 2);
  assert.deepEqual(inspectUiSource("src/styles/base.css", 'body { top: clamp(16px, var(--fixture-top), calc(100% - 16px)); left: calc(50% - 10px); padding: var(--space-4); margin: 0 auto; gap: 0; }'), []);
  assert.deepEqual(inspectUiSource("src/New.tsx", 'style={{ top: position.y, left: "calc(var(--measured-left) - 10px)" }}'), []);
  assert.deepEqual(inspectUiSource("src/styles/base.css", 'body { border-top: 1px solid #fff; border-left: 1px solid var(--color-border-default); }').map(v => v.rule), ["raw-color"]);
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

test("I3 accepts semantic custom properties and catches literal JSX/style color values", () => {
  assert.deepEqual(inspectUiSource("src/styles/base.css", 'body { color: var(--color-brand-blue); background: var(--color-brand-navy); border: 1px solid var(--color-brand-coral); }'), []);
  assert.deepEqual(inspectUiSource("src/New.tsx", '<path fill={"var(--color-brand-blue)"} style={{ stroke: "var(--color-brand-coral)" }} />'), []);
  assert.deepEqual(inspectUiSource("src/New.tsx", '<path fill={"white"} stroke={\'red\'} style={{ color: "rebeccapurple", backgroundColor: "blue" }} />').map(v => v.match), ["white", "red", "rebeccapurple", "blue"]);
  assert.deepEqual(inspectUiSource("src/styles/base.css", 'body { color: var(--color-brand-blue, red); background: linear-gradient(white, var(--color-brand-navy)); }').map(v => v.match), ["red", "white"]);
  assert.deepEqual(inspectUiSource("src/New.tsx", '<path fill={palette.red} style={{ color: palette.blue }} />'), []);
});

test("I7 catches literal template, image and shadow colors without treating runtime values as CSS", () => {
  const jsx = '<path fill={`white`} style={{ backgroundImage: "linear-gradient(red, blue)", boxShadow: `0 0 2px red` }} />';
  assert.deepEqual(inspectUiSource("src/New.tsx", jsx).map(v => v.match), ["white", "red", "blue", "red"]);
  assert.deepEqual(inspectUiSource("src/styles/base.css", 'body { background-image: linear-gradient(red, blue); box-shadow: 0 0 2px red; text-shadow: 0 0 2px blue; }').map(v => v.match), ["red", "blue", "red", "blue"]);
  assert.deepEqual(inspectUiSource("src/New.tsx", '<div style={{ backgroundImage: "linear-gradient(#123456, rgb(1 2 3))", boxShadow: `0 0 2px #fff` }} />').map(v => v.rule), Array(3).fill("raw-color"));
  assert.deepEqual(inspectUiSource("src/New.tsx", '<path fill={`${palette.white}`} style={{ backgroundImage: palette.red, boxShadow: shadows.blue, color: `var(--color-brand-blue)` }} />'), []);
  assert.deepEqual(inspectUiSource("src/styles/base.css", 'body { background-image: linear-gradient(var(--color-brand-blue), var(--color-brand-coral)); box-shadow: var(--shadow-panel); }'), []);
});

test("blocks stock and arbitrary typography, fractional padding and subpixel literals", () => {
  assert.deepEqual(inspectUiSource("sample.tsx", '"text-sm leading-7 tracking-wide text-[17px] p-1/2"; style={{ gap: 0.5 }}').map(v => v.rule), ["unapproved-typography", "unapproved-typography", "unapproved-typography", "arbitrary-typography", "unapproved-spacing", "literal-spacing"]);
});

test("I2 rejects semantic text line-height overrides in numeric, arbitrary and variable forms", () => {
  const classes = '"text-body/7 text-body/[17px] max-compact:text-page-title/(--custom-leading) text-body/[var(--custom-leading)]"';
  assert.deepEqual(inspectUiSource("src/New.tsx", classes).map(v => v.rule), Array(4).fill("unapproved-typography"));
  assert.deepEqual(inspectUiSource("src/New.tsx", '"text-body text-page-title text-content-primary/70"'), []);
});

test("rejects static CSS and inline typography hidden in calculations", () => {
  assert.deepEqual(inspectUiSource("src/styles/base.css", 'body { font-size: calc(17px); line-height: clamp(0px, 17px, 24px); letter-spacing: calc(1px); }').map(v => v.rule), Array(3).fill("literal-typography"));
  assert.equal(inspectUiSource("src/New.tsx", 'style={{ fontSize: "calc(17px)" }}')[0].rule, "literal-typography");
});

test("theme permits only token declarations, not arbitrary rules or new CSS imports", () => {
  const path = "src/styles/theme.css";
  assert.deepEqual(inspectUiSource(path, '@theme static { --color-surface-panel: #ffffff; --text-body: 0.875rem; --text-body--line-height: 1.375rem; --radius-control: 0.625rem; --shadow-panel: 0 8px 24px rgb(30 64 175 / 0.06); --spacing: 4px; --breakpoint-compact: 47.5rem; }'), []);
  assert.ok(inspectUiSource(path, 'body { color: #fff; padding: 13px; }').some(v => v.rule === "raw-color"));
  assert.ok(inspectUiSource(path, '@import "./rogue.css";').some(v => v.rule === "css-import"));
  assert.ok(inspectUiSource("src/other/theme.css", '@theme { --color-test: #fff; }').some(v => v.rule === "raw-color"));
});

test("I6 rejects changed anchored theme values across every token family", async () => {
  const path = "src/styles/theme.css";
  const theme = await readFile(new URL("../src/styles/theme.css", import.meta.url), "utf8");
  assert.deepEqual(inspectUiSource(path, theme), []);
  for (const [name, value] of [["--spacing", "13px"], ["--text-body", "13px"], ["--breakpoint-compact", "777px"], ["--color-brand-blue", "red"], ["--radius-panel", "1px"], ["--shadow-panel", "0 0 2px red"], ["--color-*", "red"]]) {
    const changed = theme.replace(new RegExp(`${name.replace("*", "\\*")}: [^;]+;`), `${name}: ${value};`);
    assert.ok(inspectUiSource(path, changed).some(v => v.rule === "unapproved-theme-value"), name);
  }
  assert.deepEqual(inspectUiSource(path, theme.replace("0 8px 24px rgb(30 64 175 / 0.06)", "0  /* explanation */ 8px\n 24px rgb( 30 64 175/0.06 )")), []);
  assert.ok(inspectUiSource(path, "@theme static { --spacing: 13px }").some(v => v.rule === "unapproved-theme-value"));
  assert.deepEqual(inspectUiSource(path, "@theme static { --spacing: 4px }"), []);
});

test("rejects unknown theme names, semantic typos and arbitrary responsive breakpoints", () => {
  assert.ok(inspectUiSource("src/styles/theme.css", '@theme static { --text-rogue: 1rem; --breakpoint-rogue: 777px; }').some(v => v.rule === "unapproved-theme-token"));
  assert.deepEqual(inspectUiSource("src/New.tsx", '"max-[777px]:p-4 tablet:bg-surface-pannel text-rogue rounded-rogue shadow-rogue"').map(v => v.rule), ["unapproved-breakpoint", "unapproved-color", "unapproved-typography", "unapproved-theme-utility", "unapproved-theme-utility"]);
  assert.deepEqual(inspectUiSource("src/New.tsx", '"max-compact:p-4 tablet:p-6 bg-surface-panel text-body rounded-panel shadow-popover text-center"'), []);
  assert.deepEqual(inspectUiSource("src/styles/base.css", 'body { text-align: center; text-transform: none; text-decoration: none; }'), []);
  assert.deepEqual(inspectUiSource("src/New.tsx", 'const values = { [key]: value }; const selector = "[tabindex]:not([disabled])";'), []);
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

test("M1 CSS query/hash imports require an exact approved resource ID", () => {
  assert.deepEqual(inspectUiSource("src/New.tsx", 'import "./new.css?inline"; import("./old.css#theme");').map(v => v.rule), ["css-import", "css-import"]);
  assert.equal(inspectUiSource("src/main.tsx", 'import "./styles.css?inline";')[0].rule, "css-import");
  assert.deepEqual(inspectUiSource("src/New.tsx", 'import "./data.json?raw";'), []);
});

test("skips test-only paths and comments, not production paths containing test", () => {
  for (const path of ["src/page.test.tsx", "src/page.spec.ts", "src/test/fixture.ts", "e2e/page.ts"]) {
    assert.deepEqual(inspectUiSource(path, '"p-[13px]"; node.querySelector("button")'), []);
  }
  assert.deepEqual(inspectUiSource("src/latest.tsx", '// "p-[13px]"\n/* color: #fff; */'), []);
  assert.equal(inspectUiSource("src/latest.tsx", 'node.querySelectorAll("button")').length, 1);
});

test("M3 ignores trailing and JSX comments but preserves strings, templates and URLs", () => {
  assert.deepEqual(inspectUiSource("src/New.tsx", 'const x = 1; // old p-[13px]\nconst view = <div>{/* old gap-[13px] */}</div>;'), []);
  assert.deepEqual(inspectUiSource("src/New.tsx", 'const classes = `p-2 ${(() => { /* old p-[13px] */ return "gap-3"; })()}`;'), []);
  assert.deepEqual(inspectUiSource("src/New.tsx", 'const url = "https://host/p-[13px]"; const text = `/* gap-[15px] */`;').map(v => v.match), ["p-[13px]", "gap-[15px]"]);
  assert.deepEqual(inspectUiSource("src/New.tsx", 'const text = "a\\\"// p-[13px]"; const view = <div>// gap-[15px]</div>;').map(v => v.match), ["p-[13px]", "gap-[15px]"]);
  assert.deepEqual(inspectUiSource("src/styles/base.css", '/* p-[13px] */ body { background-image: url("https://host/example.png"); }'), []);
});

test("rejects TypeScript generic and optional-chain production DOM queries", () => {
  assert.deepEqual(inspectUiSource("src/Modal.tsx", 'ref.current?.querySelector<HTMLElement>(selector); dialog.querySelectorAll<HTMLButtonElement>(selector)').map(v => v.rule), ["query-selector", "query-selector"]);
});

test("M2 rejects optional DOM method calls including receiver and generic combinations", () => {
  const source = 'element.querySelector?.("button"); ref.current?.querySelectorAll?.<HTMLElement>("input")';
  const violations = inspectUiSource("src/New.tsx", source);
  assert.equal(violations.length, 2);
  assert.equal(violations[0].match, 'element.querySelector?.("button")');
  assert.equal(violations[1].match, 'ref.current?.querySelectorAll?.<HTMLElement>("input")');
});

test("I4 fingerprints the receiver and complete selector call, independently of surrounding lines", () => {
  const path = "src/ConfirmDialog.tsx";
  const old = 'oldDialog.querySelectorAll<HTMLElement>("button")';
  const changed = 'document.querySelectorAll<HTMLElement>("input")';
  assert.notDeepEqual(inspectUiSource(path, old), inspectUiSource(path, changed));
  assert.deepEqual(inspectUiSource(path, old), inspectUiSource(path, 'const unrelated = 1;\n' + old + ';\nconst extra = 2;'));
  const nested = 'dialog.querySelector<HTMLElement>(`[data-id="${CSS.escape(id)}"]`)';
  assert.equal(inspectUiSource(path, nested)[0].match, nested);
});

test("I4 CLI rejects same-file query receiver/selector replacement but permits unrelated edits", async () => {
  const root = await mkdtemp(join(tmpdir(), "led-ui-query-policy-"));
  const run = () => spawnSync(process.execPath, [new URL("./ui-policy.mjs", import.meta.url).pathname, "--root", root], { encoding: "utf8" });
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "src/components"));
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "scripts/ui-policy-baseline.json"), JSON.stringify({ version: 1, sourceRef: "24b5ea593e860575f7bf1007781146cf1101beb7", files: { "src/components/ConfirmDialog.tsx": { "query-selector": { count: 1, matches: { 'dialogElement.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)': 1 } } } } }));
    await writeFile(join(root, "src/components/ConfirmDialog.tsx"), 'dialogElement.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);');
    assert.equal(run().status, 0);
    await writeFile(join(root, "src/components/ConfirmDialog.tsx"), 'const unused = 1;\ndialogElement.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);');
    assert.equal(run().status, 0);
    await writeFile(join(root, "src/components/ConfirmDialog.tsx"), 'document.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);');
    assert.equal(run().status, 1);
    await writeFile(join(root, "src/components/ConfirmDialog.tsx"), 'dialogElement.querySelectorAll<HTMLElement>(OTHER_SELECTOR);');
    assert.equal(run().status, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI inventories only production src and fails on new or increased debt", async () => {
  const root = await mkdtemp(join(tmpdir(), "led-ui-policy-"));
  const cli = new URL("./ui-policy.mjs", import.meta.url);
  const run = () => spawnSync(process.execPath, [cli.pathname, "--root", root], { encoding: "utf8" });
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "src/App.tsx"), 'import "./styles.css";');
    await writeFile(join(root, "src/ignored.test.tsx"), '"p-[15px]"');
    await writeFile(join(root, "scripts/ui-policy-baseline.json"), JSON.stringify({ version: 1, sourceRef: "24b5ea593e860575f7bf1007781146cf1101beb7", files: { "src/App.tsx": { "css-import": { count: 1, matches: { "./styles.css": 1 } } } } }));
    assert.equal(run().status, 0);
    await writeFile(join(root, "src/App.tsx"), 'import "./styles.css"; import "./styles.css";');
    assert.equal(run().status, 1);
    await writeFile(join(root, "src/App.tsx"), 'import "./new.css";');
    assert.equal(run().status, 1, "a different violation cannot consume removed debt");
    await writeFile(join(root, "src/App.tsx"), '"gap-3"');
    assert.equal(run().status, 0);
    await writeFile(join(root, "src/new.tsx"), 'import "./styles.css";');
    assert.equal(run().status, 1, "new files have no baseline allowance");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("baseline edits cannot replace the approved Git anchor or invent allowance", async () => {
  const root = await mkdtemp(join(tmpdir(), "led-ui-baseline-integrity-"));
  const run = () => spawnSync(process.execPath, [new URL("./ui-policy.mjs", import.meta.url).pathname, "--root", root], { encoding: "utf8" });
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "scripts/ui-policy-baseline.json"), JSON.stringify({ version: 1, sourceRef: "0000000000000000000000000000000000000000", files: {} }));
    assert.equal(run().status, 1, "an edited sourceRef must fail even without current violations");
    await writeFile(join(root, "src/App.tsx"), 'import "./new.css";');
    await writeFile(join(root, "scripts/ui-policy-baseline.json"), JSON.stringify({ version: 1, sourceRef: "24b5ea593e860575f7bf1007781146cf1101beb7", files: { "src/App.tsx": { "css-import": { count: 1, matches: { "./new.css": 1 } } } } }));
    assert.equal(run().status, 1, "same-change source and baseline edits cannot invent approved debt");
    await writeFile(join(root, "src/App.tsx"), 'import "./styles.css"; import "./styles.css";');
    await writeFile(join(root, "scripts/ui-policy-baseline.json"), JSON.stringify({ version: 1, sourceRef: "24b5ea593e860575f7bf1007781146cf1101beb7", files: { "src/App.tsx": { "css-import": { count: 2, matches: { "./styles.css": 2 } } } } }));
    assert.equal(run().status, 1, "existing approved debt may not increase through a baseline edit");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real Vite build emits semantic, spacing, typography and max-compact CSS without fixture pollution", async () => {
  const { build } = await import("vite");
  const result = await build({
    root: fileURLToPath(new URL("../", import.meta.url)),
    logLevel: "warn",
    build: { write: false },
    plugins: [{
      name: "ui-policy-compile-proof",
      enforce: "pre",
      async load(id) {
        if (id.endsWith("/src/styles.css")) return await readFile(id, "utf8") + '\n@source inline("p-0.5 p-16 bg-surface-panel text-content-primary text-body max-compact:p-4");';
      }
    }]
  });
  const css = result.output.filter(item => item.type === "asset" && item.fileName.endsWith(".css")).map(item => item.source).join("\n");
  for (const declaration of [
    '.p-0\\.5{padding:calc(var(--spacing) * .5)}',
    '.p-16{padding:calc(var(--spacing) * 16)}',
    '.bg-surface-panel{background-color:var(--color-surface-panel)}',
    '.text-content-primary{color:var(--color-content-primary)}',
    '.text-body{font-size:var(--text-body);line-height:var(--tw-leading,var(--text-body--line-height))}'
  ]) assert.ok(css.includes(declaration), declaration);
  const compactMedia = css.match(/@media not all and \(min-width:47\.5rem\)\{(?:[^{}]*\{[^{}]*\})+\}/)?.[0];
  assert.ok(compactMedia?.includes('.max-compact\\:p-4{padding:calc(var(--spacing) * 4)}'));
  assert.ok(!css.includes('.p-9{') && !css.includes('.max-compact\\:px-0\\.75{'));
});
