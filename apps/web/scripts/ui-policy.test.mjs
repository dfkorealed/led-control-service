import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { inspectUiSource, inspectWorkspace } from "./ui-policy.mjs";

test("production UI has no legacy policy violations", async () => {
  const result = await inspectWorkspace({ baseline: {} });
  assert.deepEqual(result.violations, []);
});

test("workspace inspection rejects non-empty debt allowances", async () => {
  await assert.rejects(
    inspectWorkspace({ baseline: { "src/New.tsx": { "raw-color": { count: 1, matches: { red: 1 } } } } }),
    /zero-baseline/
  );
});

test("rejects arbitrary spacing, raw colors and production querySelector", () => {
  const violations = inspectUiSource("sample.tsx", 'className="p-[13px] text-[#fff]"; node.querySelector("button")');
  assert.deepEqual(violations.map(({ rule }) => rule), ["arbitrary-spacing", "raw-color", "query-selector"]);
  assert.deepEqual(violations[0], { rule: "arbitrary-spacing", path: "sample.tsx", match: "p-[13px]" });
});

test("accepts all approved spacing steps, semantic colors and typography", () => {
  const source = 'className="p-0.5 p-1 p-1.5 p-2 p-2.5 p-3 p-3.5 p-4 p-4.5 p-5 p-6 p-7 p-8 p-10 p-12 p-16 p-0 -mt-2 mx-auto top-1/2 max-compact:gap-3 bg-surface-panel text-content-primary text-body rounded-panel shadow-panel"';
  assert.deepEqual(inspectUiSource("sample.tsx", source), []);
});

test("rejects arbitrary radius and shadow utilities without a legacy debt allowance", () => {
  const arbitrary = 'className="rounded-[3px] shadow-[0_0_2px_red]"';
  assert.deepEqual(inspectUiSource("src/New.tsx", arbitrary).map(v => v.rule), ["arbitrary-theme-utility", "arbitrary-theme-utility"]);

  const fixtureShadow = "shadow-[0_0_0_0_color-mix(in_srgb,var(--color-fixture-on)_0%,transparent),inset_0_0_0_1px_color-mix(in_srgb,var(--color-content-inverse)_24%,transparent)]";
  assert.deepEqual(
    inspectUiSource("src/features/floor-map/FloorScene.tsx", `"rounded-[3px] ${fixtureShadow}"`).map(v => v.rule),
    ["arbitrary-theme-utility", "arbitrary-theme-utility"]
  );
});

test("permits runtime exceptions only in their reviewed syntax context", () => {
  const geometry = 'const base = { strokeColor: "#2563eb", fillColor: "#dbeafe", fontSize: 16 };';
  assert.deepEqual(inspectUiSource("src/features/floor-editor/geometry.ts", geometry), []);
  assert.deepEqual(
    inspectUiSource("src/features/floor-editor/geometry.ts", `${geometry}\nconst unrelated = "#2563eb";`).map(v => v.match),
    ["#2563eb"]
  );
  assert.deepEqual(
    inspectUiSource("src/features/floor-editor/geometry.ts", 'const unrelated = { strokeColor: "#2563eb", fillColor: "#dbeafe", fontSize: 16 };').map(v => v.rule),
    ["raw-color", "raw-color", "literal-typography"]
  );
  assert.deepEqual(
    inspectUiSource("src/features/floor-editor/geometry.ts", 'const base = { nested: { strokeColor: "#2563eb", fillColor: "#dbeafe", fontSize: 16 } };').map(v => v.rule),
    ["raw-color", "raw-color", "literal-typography"]
  );

  const chart = '<ComposedChart margin={{ top: 12, right: 12, left: 0, bottom: 8 }} />';
  assert.deepEqual(inspectUiSource("src/features/statistics/EnergyComparisonChart.tsx", chart), []);
  assert.deepEqual(
    inspectUiSource("src/features/statistics/EnergyComparisonChart.tsx", `${chart}\nconst unrelated = { top: 12, right: 12, bottom: 8 };`).map(v => v.match),
    ["top: 12", "right: 12", "bottom: 8"]
  );
  assert.deepEqual(inspectUiSource("src/features/statistics/EnergyComparisonChart.tsx", '<ComposedChart margin={{ top: 13, right: 12, left: 0, bottom: 8 }} />').map(v => v.match), ["top: 13"]);
  assert.deepEqual(
    inspectUiSource("src/features/statistics/EnergyComparisonChart.tsx", '<ComposedChart margin={{ nested: { top: 12, right: 12, bottom: 8 } }} />').map(v => v.rule),
    Array(3).fill("literal-spacing")
  );
});

test("layer wrappers preserve first-selector and raw-form fingerprints without hiding debt", () => {
  const css = '.first { padding: 13px; color: red; } button.custom { margin: 4px; }';
  const expected = inspectUiSource("src/styles.css", css);
  assert.deepEqual(expected.filter(v => v.rule === "css-selector").map(v => v.match), [".first", "button.custom"]);
  assert.deepEqual(expected.filter(v => v.rule === "raw-form-style").map(v => v.match), ["button.custom"]);
  for (const wrapped of [
    `@layer components { ${css} }`,
    `@layer { ${css} }`,
    `@layer components { @layer controls { ${css} } }`,
    `@media (min-width: 760px) { @layer components { ${css} } }`
  ]) assert.deepEqual(inspectUiSource("src/styles.css", wrapped), expected, wrapped);
});

test("adjacent component layers count each first selector exactly once", () => {
  const css = '@layer components { button.first {} } @layer components { input.second {} }';
  const violations = inspectUiSource("src/styles.css", css);
  assert.deepEqual(violations.map(v => [v.rule, v.match]), [
    ["css-selector", "button.first"], ["raw-form-style", "button.first"],
    ["css-selector", "input.second"], ["raw-form-style", "input.second"]
  ]);
  assert.deepEqual(inspectUiSource("src/styles/base.css", '@layer base { button, input, select, textarea { font: inherit; } }'), []);
});

for (const group of ["@media (min-width: 760px)", "@supports (display: grid)", "@supports (display: grid) { @media (min-width: 760px)"]) {
  test(`nested layer ${group} preserves every first form selector`, () => {
    const nested = `${group} { button.first {} input.second {} }${group.includes("{") ? " }" : ""}`;
    assert.deepEqual(inspectUiSource("src/styles.css", `@layer components { ${nested} }`).map(v => [v.rule, v.match]), [
      ["css-selector", "button.first"], ["raw-form-style", "button.first"],
      ["css-selector", "input.second"], ["raw-form-style", "input.second"]
    ]);
  });
}

test("keyframe steps are not selectors and do not hide adjacent form rules", () => {
  for (const prefix of ["@keyframes", "@-webkit-keyframes"]) {
    const css = `@layer components { @supports (display: grid) { ${prefix} pulse { from { opacity: 0; } 25%, 50% { opacity: .5; } to { opacity: 1; } } button.first {} } input.second {} }`;
    assert.deepEqual(inspectUiSource("src/styles.css", css).map(v => [v.rule, v.match]), [
      ["css-selector", "button.first"], ["raw-form-style", "button.first"],
      ["css-selector", "input.second"], ["raw-form-style", "input.second"]
    ]);
  }
});

test("keyframe declarations retain color and spacing debt without selector debt", () => {
  assert.deepEqual(inspectUiSource("src/styles.css", '@keyframes pulse { from { color: red; } to { padding: 13px; content: "}"; } } button.next {}').map(v => [v.rule, v.match]), [
    ["raw-color", "red"], ["literal-spacing", "padding: 13px"],
    ["css-selector", "button.next"], ["raw-form-style", "button.next"]
  ]);
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

test("I9 scans template static segments, filter and SVG stop colors but not expressions or URL payloads", () => {
  const source = '<stop stopColor={`white-${suffix}`} style={{ backgroundImage: `linear-gradient(red, ${palette.blue})`, filter: "drop-shadow(0 0 2px red)" }} />';
  assert.deepEqual(inspectUiSource("src/New.tsx", source).map(v => v.match), ["white", "red", "red"]);
  assert.deepEqual(inspectUiSource("src/styles/base.css", 'body { filter: drop-shadow(0 0 2px blue); stop-color: red; }').map(v => v.match), ["blue", "red"]);
  assert.deepEqual(inspectUiSource("src/New.tsx", '<stop stopColor={`${palette.white}`} style={{ backgroundImage: `linear-gradient(var(--color-brand-blue), ${palette.red})`, filter: filters.red }} />'), []);
});

test("I9 ignores URL payload words while scanning adjacent gradient colors", () => {
  assert.deepEqual(inspectUiSource("src/New.tsx", '<div style={{ backgroundImage: "url(/images/white.png)" }} />'), []);
  assert.deepEqual(inspectUiSource("src/styles/base.css", 'body { background-image: url("/images/red.png"), linear-gradient(blue, var(--color-brand-blue)); }').map(v => v.match), ["blue"]);
  assert.deepEqual(inspectUiSource("src/styles/base.css", 'body { background-image: url("/images/red.png"),\n linear-gradient(blue, var(--color-brand-blue)); }').map(v => v.match), ["blue"]);
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

test("theme permits only token declarations, not arbitrary rules or new CSS imports", async () => {
  const path = "src/styles/theme.css";
  assert.deepEqual(inspectUiSource(path, await readFile(new URL("../src/styles/theme.css", import.meta.url), "utf8")), []);
  assert.ok(inspectUiSource(path, 'body { color: #fff; padding: 13px; }').some(v => v.rule === "raw-color"));
  assert.ok(inspectUiSource(path, '@import "./rogue.css";').some(v => v.rule === "css-import"));
  assert.ok(inspectUiSource("src/other/theme.css", '@theme { --color-test: #fff; }').some(v => v.rule === "raw-color"));
});

test("anchors the fixture marker radius and every brightness shadow token", async () => {
  const path = "src/styles/theme.css";
  const theme = await readFile(new URL("../src/styles/theme.css", import.meta.url), "utf8");
  const names = ["--radius-fixture-marker", ...Array.from({ length: 10 }, (_, index) => `--shadow-fixture-brightness-${index + 1}`)];
  for (const name of names) assert.match(theme, new RegExp(`${name}: [^;]+;`), name);
  for (const name of names) {
    const changed = theme.replace(new RegExp(`${name}: [^;]+;`), `${name}: 0 0 1px red;`);
    assert.ok(inspectUiSource(path, changed).some(v => v.rule === "unapproved-theme-value"), name);
  }
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
  assert.deepEqual(inspectUiSource(path, theme.replace("--breakpoint-tablet: 64rem;", "--breakpoint-tablet: 64rem")), []);
});

test("I8 requires one complete canonical theme declaration inventory", async () => {
  const path = "src/styles/theme.css";
  const theme = await readFile(new URL("../src/styles/theme.css", import.meta.url), "utf8");
  const cases = [
    [theme.replace(/--color-chart-cost:[^;]+;/, ""), "missing-theme-token"],
    [theme.replace(/--breakpoint-tablet:[^;]+;/, ""), "missing-theme-token"],
    ["/* theme removed */", "missing-theme-token"],
    [theme.replace("--spacing: 4px;", "--spacing: 4px; --spacing: 4px;"), "duplicate-theme-token"],
    [theme.replace("--spacing: 4px;", "--rogue: 4px; --spacing: 4px;"), "unapproved-theme-token"],
    [theme.replace("--spacing: 4px;", "--spacing: 13px;"), "unapproved-theme-value"],
    [theme.replace("@theme static", "@theme inline"), "unapproved-theme-block"],
    [theme + "\n@theme static {}", "unapproved-theme-block"],
    ["@theme inline { --spacing: 13px; }", "unapproved-theme-block"],
  ];
  assert.deepEqual(cases.map(([source, rule]) => inspectUiSource(path, source).some(v => v.rule === rule)), Array(9).fill(true));
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

test("rejects imports of the retired landing motion stylesheet", () => {
  assert.ok(inspectUiSource("src/styles.css", '@import "./features/landing/landing.css";').some(v => v.rule === "css-import"));
  assert.ok(inspectUiSource("src/page.tsx", 'import "./features/landing/landing.css";').some(v => v.rule === "css-import"));
  assert.ok(inspectUiSource("src/styles.css", '@import "./features/landing/other.css";').some(v => v.rule === "css-import"));
});

test("rejects retired landing motion selectors and stylesheets", () => {
  const source = '.landing-page[data-landing-motion] [data-landing-revealed] { animation: landing-enter 520ms both; }';
  assert.ok(inspectUiSource("src/features/landing/landing.css", source).some(v => v.rule === "css-file"));
  assert.ok(inspectUiSource("src/features/landing/landing.css", source).some(v => v.rule === "css-selector"));
  const hero = '.landing-page[data-landing-hero-ready] :is( .landing-hero-heading, .landing-hero-description, .landing-hero-actions, .landing-hero-preview ) { animation: landing-enter 560ms both; }';
  assert.ok(inspectUiSource("src/features/landing/landing.css", hero).some(v => v.rule === "css-selector"));
  const removedKicker = '.landing-page[data-landing-hero-ready] :is( .landing-hero-kicker, .landing-hero-heading, .landing-hero-description, .landing-hero-actions, .landing-hero-preview ) { animation: landing-enter 560ms both; }';
  assert.ok(inspectUiSource("src/features/landing/landing.css", removedKicker).some(v => v.rule === "css-selector"));
  const elsewhere = inspectUiSource("src/features/landing/other.css", source);
  assert.ok(elsewhere.some(v => v.rule === "css-file"));
  assert.ok(elsewhere.some(v => v.rule === "css-selector"));
});

test("retired landing CSS cannot bypass selector, color or spacing policy", () => {
  for (const selector of ["body", ".landing-page-rogue", ".landing-page, body", ".landing-page + .other", ".landing-page ~ .other"]) {
    assert.ok(inspectUiSource("src/features/landing/landing.css", `${selector} { animation: none; }`).some(v => v.rule === "css-selector"), selector);
  }
  const violations = inspectUiSource("src/features/landing/landing.css", '.landing-page[data-landing-motion] [data-landing-revealed] { color: red; padding: 13px; }');
  assert.ok(violations.some(v => v.rule === "raw-color"));
  assert.ok(violations.some(v => v.rule === "literal-spacing"));
});

test("rejects rogue utilities and extensionless CSS package imports", () => {
  assert.ok(inspectUiSource("src/styles.css", '@utility rogue { color: red; }').some(v => v.rule === "css-utility"));
  assert.ok(inspectUiSource("src/main.tsx", 'import "tailwindcss";').some(v => v.rule === "css-import"));
});

test("does not mistake JavaScript variant object keys for responsive utility prefixes", () => {
  const source = 'const sm = "px-3"; const classes = {sm:sm, md:"px-4", lg: { padding: "12%" }}; type Sizes = {sm:string; md: string; lg?: string};';
  assert.deepEqual(inspectUiSource("src/components/ui/fields/field-types.ts", source), []);
});

test("still rejects actual unapproved responsive prefixes inside class strings and templates", () => {
  const samples = [
    ['const classes = { sm: "sm:p-3", md: "md:hover:bg-surface-panel" };', ["sm:", "md:"]],
    ['<div className="lg:flex xl:p-4" />', ["lg:", "xl:"]],
    ['const classes = `2xl:p-4 ${active ? "md:block" : "lg:hidden"} max-[777px]:p-4`;', ["2xl:", "md:", "lg:", "max-[777px]:"]],
    ['const prefix = "sm:"; const classes = `${prefix}p-4`;', ["sm:"]],
    ['const classes = "tablet:flex max-compact:p-4";', []]
  ];
  for (const [source, expected] of samples) assert.deepEqual(inspectUiSource("src/New.tsx", source).filter(v => v.rule === "unapproved-breakpoint").map(v => v.match), expected);
});

test("rejects arbitrary breakpoints even when an equivalent named phone-wide token exists", () => {
  const source = 'const classes = "min-[360px]:grid-cols-4 max-[359px]:order-1";';
  assert.deepEqual(
    inspectUiSource("src/New.tsx", source).filter(v => v.rule === "unapproved-breakpoint").map(v => v.match),
    ["min-[360px]:", "max-[359px]:"]
  );
});

test("accepts only the reviewed 360px phone-wide token and named utilities", async () => {
  const path = "src/styles/theme.css";
  const theme = await readFile(new URL("../src/styles/theme.css", import.meta.url), "utf8");
  assert.deepEqual(inspectUiSource(path, theme), []);
  assert.deepEqual(inspectUiSource("src/New.tsx", 'const classes = "phone-wide:grid-cols-4 max-phone-wide:order-1";'), []);
  assert.ok(inspectUiSource(path, theme.replace(/--breakpoint-phone-wide:[^;]+;/, "")).some(v => v.rule === "missing-theme-token"));
  assert.ok(inspectUiSource(path, theme.replace(/--breakpoint-phone-wide:[^;]+;/, "--breakpoint-phone-wide: 22rem;")).some(v => v.rule === "unapproved-theme-value"));
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

test("blocks native form styling hidden behind JSX spreads and React.createElement", () => {
  for (const source of [
    '<input {...{ className: "p-2" }} />',
    '<select {...props} />',
    'React.createElement("textarea", { style: styles })',
    'React.createElement("button", { ...props })',
    'React.createElement(("input"), { "className": "p-2" })',
    'import { createElement as h } from "react"; h("input", { className: "p-2" })',
    '<FormField><input {...{ className: "p-2" }} /></FormField>'
  ]) {
    assert.ok(inspectUiSource("src/features/example.tsx", source).some(v => v.rule === "raw-form-style"), source);
  }
  assert.deepEqual(inspectUiSource("src/features/example.tsx", 'import { FormField } from "../components/ui"; <FormField><input {...attributes} /></FormField>'), []);
  assert.deepEqual(inspectUiSource("src/components/ui/Field.tsx", '<input {...props} />'), []);
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

test("skips only precise CAD smoke and golden fixture suffixes", () => {
  const source = 'const color = "#123456"; node.querySelector("canvas");';
  for (const path of ["src/cad/scene.smoke.ts", "src/cad/scene-smoke.tsx", "src/cad/scene.golden.ts"]) {
    assert.deepEqual(inspectUiSource(path, source), [], path);
  }
  for (const path of [
    "src/cad/smoke.ts", "src/cad/golden.ts", "src/cad/scene-smoke.ts",
    "src/cad/scene.smoke.tsx", "src/cad/scene.golden.tsx", "src/cad/scene.golden.css",
    "src/cad/scene.smoke.ts.backup.ts", "src/cad/scene-smoke-helper.tsx", "src/cad/smoke/scene.ts"
  ]) {
    assert.ok(inspectUiSource(path, source).some(v => v.rule === "raw-color"), path);
  }
});

test("production imports cannot enter skipped CAD fixtures", () => {
  for (const specifier of [
    "./scene.smoke.ts", "./scene-smoke.tsx", "./scene.golden.ts",
    "./scene.smoke", "./scene-smoke", "./scene.golden",
    "./scene.smoke.ts?raw", "./scene-smoke.tsx#entry", "./scene.golden?raw",
    "/src/cad/scene.golden.ts", "../cad/scene-smoke"
  ]) {
    for (const source of [
      `import ${JSON.stringify(specifier)};`,
      `export * from ${JSON.stringify(specifier)};`,
      `import(${JSON.stringify(specifier)});`
    ]) {
      assert.ok(inspectUiSource("src/cad/production.ts", source).some(v => v.rule === "test-import" && v.match === specifier), source);
    }
  }
  assert.deepEqual(inspectUiSource("src/cad/production.ts", 'import "./scene-smoke-helper"; import "./golden";'), []);
});

test("workspace skips CAD fixtures without admitting their production HTML entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "led-ui-cad-fixtures-"));
  const fixtures = ["scene.smoke.ts", "scene-smoke.tsx", "scene.golden.ts"];
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/App.tsx"), 'import "./styles.css";');
    await writeFile(join(root, "src/styles.css"), '@import "tailwindcss"; @import "./styles/theme.css"; @import "./styles/base.css"; @import "./styles/exceptions.css";');
    for (const fixture of fixtures) {
      await writeFile(join(root, "src", fixture), 'import "./styles.css"; const color = "#123456";');
    }
    assert.deepEqual((await inspectWorkspace({ root })).violations, []);

    const entries = fixtures.flatMap(fixture => [`/src/${fixture}`, `/src/${fixture}?entry#fixture`]);
    await writeFile(join(root, "index.html"), entries.map(entry => `<script type="module" src="${entry}"></script>`).join("\n"));
    assert.deepEqual((await inspectWorkspace({ root })).violations.map(v => ({ rule: v.rule, match: v.match })), entries.map(match => ({ rule: "test-import", match })));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
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

test("rejects computed DOM query method calls", () => {
  const source = 'element["querySelector"]("button"); element[`querySelectorAll`]("input"); element["query" + "Selector"]("a"); element[("querySelector")]("button"); element[`query${"Selector"}`]("button")';
  assert.deepEqual(inspectUiSource("src/New.tsx", source).map(v => v.rule), Array(5).fill("query-selector"));
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

test("I4 CLI rejects every production DOM query with a zero baseline", async () => {
  const root = await mkdtemp(join(tmpdir(), "led-ui-query-policy-"));
  const run = () => spawnSync(process.execPath, [new URL("./ui-policy.mjs", import.meta.url).pathname, "--root", root], { encoding: "utf8" });
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "src/components"));
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "src/App.tsx"), 'import "./styles.css";');
    await writeFile(join(root, "src/styles.css"), '@import "tailwindcss"; @import "./styles/theme.css"; @import "./styles/base.css"; @import "./styles/exceptions.css";');
    await writeFile(join(root, "scripts/ui-policy-baseline.json"), JSON.stringify({ version: 1, sourceRef: "24b5ea593e860575f7bf1007781146cf1101beb7", files: {} }));
    await writeFile(join(root, "src/components/ConfirmDialog.tsx"), 'dialogElement.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);');
    assert.equal(run().status, 1);
    await writeFile(join(root, "src/components/ConfirmDialog.tsx"), 'const unused = 1;\ndialogElement.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);');
    assert.equal(run().status, 1);
    await writeFile(join(root, "src/components/ConfirmDialog.tsx"), 'document.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR);');
    assert.equal(run().status, 1);
    await writeFile(join(root, "src/components/ConfirmDialog.tsx"), 'const clean = true;');
    assert.equal(run().status, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CLI inventories only production src and rejects any policy debt", async () => {
  const root = await mkdtemp(join(tmpdir(), "led-ui-policy-"));
  const cli = new URL("./ui-policy.mjs", import.meta.url);
  const run = () => spawnSync(process.execPath, [cli.pathname, "--root", root], { encoding: "utf8" });
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "src/App.tsx"), 'import "./styles.css";');
    await writeFile(join(root, "src/styles.css"), '@import "tailwindcss"; @import "./styles/theme.css"; @import "./styles/base.css"; @import "./styles/exceptions.css";');
    await writeFile(join(root, "src/ignored.test.tsx"), '"p-[15px]"');
    await writeFile(join(root, "scripts/ui-policy-baseline.json"), JSON.stringify({ version: 1, sourceRef: "24b5ea593e860575f7bf1007781146cf1101beb7", files: {} }));
    assert.equal(run().status, 0);
    await writeFile(join(root, "src/App.tsx"), 'import "./new.css";');
    assert.equal(run().status, 1);
    await writeFile(join(root, "src/App.tsx"), 'import "./styles.css"; "gap-3"');
    assert.equal(run().status, 0);
    await writeFile(join(root, "src/new.tsx"), '"p-[15px]"');
    assert.equal(run().status, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace closes skipped-module, entry HTML and public CSS scan gaps", async () => {
  const root = await mkdtemp(join(tmpdir(), "led-ui-graph-policy-"));
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "public"));
    await writeFile(join(root, "src/App.tsx"), 'import "./styles.css"; import "./hidden.test"; import "./hidden.spec?raw";');
    await writeFile(join(root, "src/styles.css"), '@import "tailwindcss"; @import "./styles/theme.css"; @import "./styles/base.css"; @import "./styles/exceptions.css";');
    await writeFile(join(root, "index.html"), '<link rel="stylesheet" href="/rogue.css"><link rel=stylesheet href=/theme><script type="module" src="/e2e/page.ts"></script>');
    await writeFile(join(root, "public/rogue.css"), 'body {}');

    const result = await inspectWorkspace({ root, baseline: {} });
    assert.ok(result.violations.some(v => v.rule === "test-import" && v.match === "./hidden.test"));
    assert.ok(result.violations.some(v => v.rule === "test-import" && v.match === "./hidden.spec?raw"));
    assert.ok(result.violations.some(v => v.rule === "test-import" && v.match === "/e2e/page.ts"));
    assert.ok(result.violations.some(v => v.rule === "html-css-entry" && v.match === "/rogue.css"));
    assert.ok(result.violations.some(v => v.rule === "html-css-entry" && v.match === "/theme"));
    assert.ok(result.violations.some(v => v.rule === "public-css" && v.path === "public/rogue.css"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace requires every canonical CSS import exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "led-ui-css-inventory-"));
  const canonical = '@import "tailwindcss"; @import "./styles/theme.css"; @import "./styles/base.css"; @import "./styles/exceptions.css";';
  try {
    await mkdir(join(root, "src"));
    await writeFile(join(root, "src/App.tsx"), 'import "./styles.css";');
    await writeFile(join(root, "src/styles.css"), canonical);
    assert.deepEqual((await inspectWorkspace({ root, baseline: {} })).violations, []);

    await writeFile(join(root, "src/styles.css"), canonical.replace('@import "./styles/base.css";', ""));
    assert.ok((await inspectWorkspace({ root, baseline: {} })).violations.some(v => v.rule === "missing-css-import" && v.match === "./styles/base.css"));

    await writeFile(join(root, "src/styles.css"), `${canonical}\n@import "tailwindcss";`);
    assert.ok((await inspectWorkspace({ root, baseline: {} })).violations.some(v => v.rule === "duplicate-css-import" && v.match === "tailwindcss"));

    await writeFile(join(root, "src/styles.css"), `/* ${canonical} */`);
    assert.ok((await inspectWorkspace({ root, baseline: {} })).violations.some(v => v.rule === "missing-css-import"));

    await writeFile(join(root, "src/styles.css"), canonical.replace('@import "tailwindcss";', '@import "tailwindcss" print;'));
    const modified = await inspectWorkspace({ root, baseline: {} });
    assert.ok(modified.violations.some(v => v.rule === "missing-css-import" && v.match === "tailwindcss"));
    assert.ok(modified.violations.some(v => v.rule === "css-import" && v.match === "tailwindcss"));

    await writeFile(join(root, "src/styles.css"), canonical);
    await writeFile(join(root, "src/App.tsx"), 'import "./styles.css"; import "./styles.css";');
    assert.ok((await inspectWorkspace({ root, baseline: {} })).violations.some(v => v.rule === "duplicate-css-entry"));

    await writeFile(join(root, "src/App.tsx"), 'import "./styles.css";');
    await writeFile(join(root, "src/main.tsx"), 'import "./styles.css";');
    assert.ok((await inspectWorkspace({ root, baseline: {} })).violations.some(v => v.rule === "duplicate-css-entry"));

    await writeFile(join(root, "src/App.tsx"), "const clean = true;");
    await writeFile(join(root, "src/main.tsx"), "const clean = true;");
    assert.ok((await inspectWorkspace({ root, baseline: {} })).violations.some(v => v.rule === "missing-css-entry"));

    await writeFile(join(root, "src/only.test.ts"), 'import "./styles.css";');
    assert.ok((await inspectWorkspace({ root, baseline: {} })).violations.some(v => v.rule === "missing-css-entry"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace rejects extensionless bare imports only when package metadata exposes CSS", async () => {
  const root = await mkdtemp(join(tmpdir(), "led-ui-package-css-"));
  const canonical = '@import "tailwindcss"; @import "./styles/theme.css"; @import "./styles/base.css"; @import "./styles/exceptions.css";';
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "node_modules/@vendor/theme"), { recursive: true });
    await mkdir(join(root, "node_modules/@vendor/runtime"), { recursive: true });
    await writeFile(join(root, "src/App.tsx"), 'import "./styles.css"; import "@vendor/theme"; import "@vendor/theme/tokens"; import "@vendor/runtime";');
    await writeFile(join(root, "src/styles.css"), canonical);
    await writeFile(join(root, "node_modules/@vendor/theme/package.json"), JSON.stringify({
      name: "@vendor/theme",
      style: "./index.css",
      exports: { ".": { style: "./index.css", import: "./index.js" }, "./tokens": "./tokens.css" }
    }));
    await writeFile(join(root, "node_modules/@vendor/runtime/package.json"), JSON.stringify({
      name: "@vendor/runtime",
      exports: { ".": { import: "./index.js", types: "./index.d.ts" } }
    }));

    const result = await inspectWorkspace({ root, baseline: {} });
    assert.deepEqual(
      result.violations.filter(v => v.rule === "css-import").map(v => v.match),
      ["@vendor/theme", "@vendor/theme/tokens"]
    );
    assert.ok(!result.violations.some(v => v.match === "@vendor/runtime"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("workspace resolves overlapping package export patterns by Node specificity, not declaration order", async () => {
  const root = await mkdtemp(join(tmpdir(), "led-ui-package-pattern-"));
  const canonical = '@import "tailwindcss"; @import "./styles/theme.css"; @import "./styles/base.css"; @import "./styles/exceptions.css";';
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "node_modules/@vendor/patterns"), { recursive: true });
    await mkdir(join(root, "node_modules/@vendor/reversed"), { recursive: true });
    await writeFile(join(root, "src/App.tsx"), [
      'import "./styles.css";',
      'import "@vendor/patterns/features/theme/tokens";',
      'import "@vendor/patterns/features/runtime/client";',
      'import "@vendor/patterns/icons/button.theme";',
      'import "@vendor/reversed/features/theme/tokens";'
    ].join(" "));
    await writeFile(join(root, "src/styles.css"), canonical);
    await writeFile(join(root, "node_modules/@vendor/patterns/package.json"), JSON.stringify({
      name: "@vendor/patterns",
      exports: {
        "./features/*": "./runtime/*.js",
        "./features/theme/*": "./theme/*.css",
        "./features/runtime/*": "./runtime/*.js",
        "./icons/*": "./runtime/*.js",
        "./icons/*.theme": "./themes/*.css"
      }
    }));
    await writeFile(join(root, "node_modules/@vendor/reversed/package.json"), JSON.stringify({
      name: "@vendor/reversed",
      exports: {
        "./features/theme/*": "./theme/*.css",
        "./features/*": "./runtime/*.js"
      }
    }));

    const result = await inspectWorkspace({ root, baseline: {} });
    assert.deepEqual(
      result.violations.filter(v => v.rule === "css-import").map(v => v.match),
      [
        "@vendor/patterns/features/theme/tokens",
        "@vendor/patterns/icons/button.theme",
        "@vendor/reversed/features/theme/tokens"
      ]
    );
    assert.ok(!result.violations.some(v => v.match === "@vendor/patterns/features/runtime/client"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("baseline must preserve the approved Git anchor and an empty violation map", async () => {
  const root = await mkdtemp(join(tmpdir(), "led-ui-baseline-integrity-"));
  const run = () => spawnSync(process.execPath, [new URL("./ui-policy.mjs", import.meta.url).pathname, "--root", root], { encoding: "utf8" });
  try {
    await mkdir(join(root, "src"));
    await mkdir(join(root, "scripts"));
    await writeFile(join(root, "scripts/ui-policy-baseline.json"), JSON.stringify({ version: 1, sourceRef: "0000000000000000000000000000000000000000", files: {} }));
    assert.equal(run().status, 1, "an edited sourceRef must fail even without current violations");
    await writeFile(join(root, "src/App.tsx"), 'const clean = true;');
    await writeFile(join(root, "scripts/ui-policy-baseline.json"), JSON.stringify({ version: 1, sourceRef: "24b5ea593e860575f7bf1007781146cf1101beb7", files: { "src/App.tsx": { "css-import": { count: 2, matches: { "./styles.css": 2 } } } } }));
    assert.equal(run().status, 1, "non-empty debt allowances must fail even with clean source");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real Vite build emits semantic and reviewed responsive CSS without fixture pollution", async () => {
  const { build } = await import("vite");
  const result = await build({
    root: fileURLToPath(new URL("../", import.meta.url)),
    logLevel: "warn",
    build: { write: false },
    plugins: [{
      name: "ui-policy-compile-proof",
      enforce: "pre",
      async load(id) {
        if (id.endsWith("/src/styles.css")) return await readFile(id, "utf8") + '\n@source inline("p-0.5 p-16 bg-surface-panel text-content-primary text-body max-compact:p-4 phone-wide:grid-cols-4 max-phone-wide:order-1");';
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
  assert.ok(css.includes('.phone-wide\\:grid-cols-4{'), "phone-wide min-width CSS");
  assert.ok(css.includes('.max-phone-wide\\:order-1{'), "phone-wide max-width CSS");
  assert.ok(!css.includes('.p-9{') && !css.includes('.max-compact\\:px-0\\.75{'));
});
