import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const require = createRequire(new URL("../package.json", import.meta.url));
// PostCSS is the existing Vite CSS parser, not an additional dependency.
const postcss = createRequire(require.resolve("vite"))("postcss");
const { compile } = require("tailwindcss");
const repository = new URL("../../../", import.meta.url);
const proposal = JSON.parse(readFileSync(new URL("docs/assets/atlas-ui-refresh-2026-10-07/customer-theme-roles.json", repository), "utf8"));
const source = readFileSync(new URL("../src/styles/theme.css", import.meta.url), "utf8");
const anchor = "7b2617b173618d376e7b3a90ec31e1392c3b7bc0";

test("actual CSS distinguishes approved argument whitespace from NBSP and vertical tab", async () => {
  const { inspectUiSource } = await import("./ui-policy.mjs");
  const base = readFileSync(new URL("../src/styles/base.css", import.meta.url), "utf8");
  const token = "--color-customer-dark-action-primary-foreground";
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const space of [" ", "\t", "\n", "\f", "\r", "\u00a0", "\u000b"]) {
      const valid = [" ", "\t", "\n", "\f", "\r"].includes(space);
      const candidate = base.replace(`var(${token})`, `var(${space}${token})`);
      const compiler = await compile(`${source}\n${candidate}\n@tailwind utilities;`);
      await page.setContent(`<style>${compiler.build(["text-action-primary-foreground"])}</style><div id="probe" class="text-action-primary-foreground"></div>`);
      const color = await page.evaluate(() => { document.documentElement.dataset.customerTheme = "dark"; return getComputedStyle(document.getElementById("probe")).color; });
      assert.equal(color, valid ? "rgb(15, 23, 36)" : "rgb(255, 255, 255)", `real CSS U+${space.codePointAt(0).toString(16)}`);
      const violations = inspectUiSource("src/styles/base.css", candidate);
      if (valid) assert.deepEqual(violations, []);
      else assert.ok(violations.some(v => v.rule === "customer-theme-binding"), "CSS-invalid whitespace must not be admitted");
    }
  } finally { await browser.close(); }
});

test("real CSS parser rejects admitted invalid functions and escaped override payloads", async () => {
  const { inspectUiSource } = await import("./ui-policy.mjs");
  const base = readFileSync(new URL("../src/styles/base.css", import.meta.url), "utf8");
  const attacks = [
    { css: base.replace("var(--color-customer-dark-action-primary-foreground)", "var (--color-customer-dark-action-primary-foreground)"), property: "color", candidate: "text-action-primary-foreground", dark: "rgb(255, 255, 255)" },
    { css: base + String.raw`body { --color-\73 urface-canvas: var(--color-content-primary); }`, property: "backgroundColor", candidate: "bg-surface-canvas", initial: "rgb(21, 50, 74)", dark: "rgb(234, 241, 250)" },
    { css: base + String.raw`body { --unrelated: var(--color-\63 ustomer-dark-content-primary); }`, property: "color", candidate: "text-action-primary-foreground", style: "color:var(--unrelated)", dark: "rgb(234, 241, 250)" }
  ];
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    for (const attack of attacks) {
      const compiler = await compile(`${source}\n${attack.css}\n@tailwind utilities;`);
      const css = compiler.build([attack.candidate]);
      await page.setContent(`<style>${css}</style><div id="probe" class="${attack.candidate}" style="${attack.style ?? ""}"></div>`);
      if (attack.initial) assert.equal(await page.evaluate(property => { delete document.documentElement.dataset.customerTheme; return getComputedStyle(document.getElementById("probe"))[property]; }, attack.property), attack.initial, "escaped property overrides the non-customer default in real CSS");
      const dark = await page.evaluate(property => { document.documentElement.dataset.customerTheme = "dark"; return getComputedStyle(document.getElementById("probe"))[property]; }, attack.property);
      assert.equal(dark, attack.dark, "actual generated CSS demonstrates why this payload must be rejected");
      assert.ok(inspectUiSource("src/styles/base.css", attack.css).some(v => v.rule === "customer-theme-binding"), "unsafe CSS cannot be admitted even when its encoding differs");
    }
  } finally { await browser.close(); }
});

test("generated CSS restores non-customer defaults and resolves customer light/dark foreground", async () => {
  const base = readFileSync(new URL("../src/styles/base.css", import.meta.url), "utf8");
  const compiler = await compile(`${source}\n${base}\n@tailwind utilities;`);
  const css = compiler.build(["bg-surface-canvas", "text-action-primary-foreground"]);
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.setContent(`<style>${css}</style><div id="probe" class="bg-surface-canvas text-action-primary-foreground"></div>`);
    const observed = await page.evaluate(() => {
      const read = () => { const style = getComputedStyle(document.getElementById("probe")); return [style.backgroundColor, style.color]; };
      const values = [read()];
      document.documentElement.dataset.customerTheme = "light"; values.push(read());
      document.documentElement.dataset.customerTheme = "dark"; values.push(read());
      delete document.documentElement.dataset.customerTheme; values.push(read());
      return values;
    });
    assert.deepEqual(observed, [["rgb(244, 248, 250)", "rgb(255, 255, 255)"], ["rgb(244, 247, 251)", "rgb(255, 255, 255)"], ["rgb(15, 23, 36)", "rgb(15, 23, 36)"], ["rgb(244, 248, 250)", "rgb(255, 255, 255)"]]);
    // Tailwind's namespace reset (--color-*) is compiler syntax, not a CSS
    // custom property; only actual named colors have browser consumers.
    const defaults = Object.fromEntries([...declarations(execFileSync("git", ["show", "1d65472d9619bd87cce1d9ddec5d38cd56c47313:apps/web/src/styles/theme.css"], { cwd: repository, encoding: "utf8" }))].filter(([name]) => name.startsWith("--color-") && !name.includes("*") && !name.startsWith("--color-customer-")));
    const mismatches = await page.evaluate(({ defaults, palettes }) => {
      const probe = document.getElementById("probe");
      const reference = document.createElement("div"); document.body.append(reference);
      const differences = [];
      for (const mode of [null, "light", "dark", null]) {
        if (mode) document.documentElement.dataset.customerTheme = mode;
        else delete document.documentElement.dataset.customerTheme;
        for (const [property, original] of Object.entries(defaults)) {
          const role = property.slice("--color-".length);
          probe.style.color = `var(${property})`;
          reference.style.color = mode && palettes[role] ? palettes[role][mode] : original;
          const actual = getComputedStyle(probe).color;
          const expected = getComputedStyle(reference).color;
          if (actual !== expected) differences.push({ mode, property, actual, expected });
        }
      }
      return differences;
    }, { defaults, palettes: proposal.colors });
    assert.deepEqual(mismatches, [], "all semantic colors resolve, excluded brand/operator defaults remain unchanged, and removal restores every original");
  } finally { await browser.close(); }
});

function declarations(css) {
  const root = postcss.parse(css);
  const blocks = [];
  root.walkAtRules("theme", block => blocks.push(block));
  assert.equal(blocks.length, 1, "one canonical theme owns all token declarations");
  assert.equal(blocks[0].params, "static");
  const values = new Map();
  blocks[0].walkDecls(declaration => {
    assert.ok(!values.has(declaration.prop), `duplicate ${declaration.prop}`);
    values.set(declaration.prop, declaration.value);
  });
  return values;
}

test("matches both customer palettes without changing approved defaults", () => {
  const before = declarations(execFileSync("git", ["show", `${anchor}:apps/web/src/styles/theme.css`], { cwd: repository, encoding: "utf8" }));
  const after = declarations(source);
  for (const [name, value] of before) assert.equal(after.get(name), value, `non-customer default ${name}`);
  assert.equal(proposal.colors["action-primary"].dark, "#94B9FF");
  assert.equal(proposal.colors["surface-canvas"].light, "#F4F7FB");
  assert.equal(proposal.colors["surface-canvas"].dark, "#0F1724");
  for (const [role, palette] of Object.entries(proposal.colors)) {
    for (const theme of ["light", "dark"]) assert.equal(after.get(`--color-customer-${theme}-${role}`), palette[theme], `${theme} ${role}`);
  }
  assert.equal(after.get("--color-action-primary-foreground"), "#FFFFFF");
  assert.equal(after.get("--color-map-background"), "#EDF2F7");
  assert.equal(after.get("--color-map-line"), "#64758A");
  assert.equal(after.get("--color-map-room"), "#F7F9FC");
  for (const [name, value] of Object.entries(proposal.layouts)) assert.equal(after.get(name), value, name);
  const extras = [...after.keys()].filter(name => !before.has(name)).sort();
  const expected = [...Object.keys(proposal.colors).flatMap(role => ["light", "dark"].map(theme => `--color-customer-${theme}-${role}`)), ...Object.keys(proposal.layouts), "--color-action-primary-foreground", "--color-map-background", "--color-map-line", "--color-map-room"].sort();
  assert.deepEqual(extras, expected, "only the reviewed additions are canonical");
});

test("Tailwind consumers resolve customer colors and geometry while retaining default color utilities", async () => {
  const compiler = await compile(`${source}\n@tailwind utilities;`);
  const output = postcss.parse(compiler.build(["bg-surface-canvas", "bg-customer-light-surface-canvas", "bg-customer-dark-surface-canvas", "text-action-primary-foreground", "w-customer-sidebar", "w-customer-rail", "w-customer-site-small", "w-customer-site"]));
  function utility(selector, property) {
    let value;
    output.walkRules(selector, rule => rule.walkDecls(property, declaration => { value = declaration.value; }));
    return value;
  }
  assert.equal(utility(".bg-surface-canvas", "background-color"), "var(--color-surface-canvas)");
  assert.equal(utility(".bg-customer-light-surface-canvas", "background-color"), "var(--color-customer-light-surface-canvas)");
  assert.equal(utility(".bg-customer-dark-surface-canvas", "background-color"), "var(--color-customer-dark-surface-canvas)");
  assert.equal(utility(".text-action-primary-foreground", "color"), "var(--color-action-primary-foreground)");
  for (const role of ["sidebar", "rail", "site-small", "site"]) assert.equal(utility(`.w-customer-${role}`, "width"), `var(--spacing-customer-${role})`);
  const rootValues = new Map();
  output.walkRules(":root, :host", rule => rule.walkDecls(declaration => rootValues.set(declaration.prop, declaration.value)));
  assert.equal(rootValues.get("--color-surface-canvas"), "#f4f8fa");
  assert.equal(rootValues.get("--color-customer-light-surface-canvas"), "#F4F7FB");
  assert.equal(rootValues.get("--color-customer-dark-surface-canvas"), "#0F1724");
  assert.equal(rootValues.get("--spacing-customer-site-small"), "8rem");
  assert.equal(rootValues.get("--spacing-customer-site"), "9rem");
});
