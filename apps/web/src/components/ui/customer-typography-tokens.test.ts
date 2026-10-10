import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const { parse } = createRequire(require.resolve("vite"))("postcss");

// This frozen review predates the addition; rotating the live policy anchor
// must not erase the proof that every original token retained its value.
const approvedTokenRef = "fac0d214653c03cc277993887c0e0c40e440b20d";
const customerTokens = [
  ["--text-customer-page-title", "1.625rem"],
  ["--text-customer-page-title--line-height", "1.35"],
  ["--text-customer-metric", "1.875rem"],
  ["--text-customer-metric--line-height", "1.3"],
] as const;

function declarations(source: string): [string, string][] {
  const inventory: [string, string][] = [];
  parse(source).walkDecls((declaration: { prop: string; value: string }) => {
    inventory.push([declaration.prop, declaration.value]);
  });
  return inventory;
}

describe("approved customer typography token contract", () => {
  // Missing, duplicate or changed declarations break the approved desktop
  // size/leading contract; expectations come directly from the reviewed API.
  it.each(customerTokens)("declares %s exactly once with approved value %s", (name, value) => {
    const inventory = declarations(readFileSync("src/styles/theme.css", "utf8"));
    expect(inventory.filter(([property]) => property === name)).toEqual([[name, value]]);
  });

  it("preserves every existing token name and value without additional palette or scale declarations", () => {
    const approved = declarations(execFileSync("git", [
      "show", `${approvedTokenRef}:apps/web/src/styles/theme.css`,
    ], { encoding: "utf8" }));
    const current = declarations(readFileSync("src/styles/theme.css", "utf8"));
    const additions = new Set<string>(customerTokens.map(([name]) => name));

    expect(current.filter(([name]) => !additions.has(name))).toEqual(approved);
    expect(current).toHaveLength(approved.length + customerTokens.length);
  });

  it("keeps customer shadow aliases accepted only inside the reviewed roots", () => {
    // Exercise the actual policy against live base CSS and representative
    // escape attempts. A subprocess retains the Node-only policy boundary.
    const result = JSON.parse(execFileSync(process.execPath, ["--input-type=module", "--eval", `
      import { readFileSync } from "node:fs";
      import { inspectUiSource } from "./scripts/ui-policy.mjs";
      const base = readFileSync(0, "utf8");
      const escapes = [
        "body { --shadow-focus: var(--shadow-customer-dark-focus); }",
        "body { --shadow-customer-dark-focus: var(--shadow-popover); }",
        "body { --unrelated: var(--shadow-customer-light-focus); }",
      ];
      console.log(JSON.stringify([
        inspectUiSource("src/styles/base.css", base),
        ...escapes.map(source => inspectUiSource("src/styles/base.css", base + source)),
      ]));
    `], { encoding: "utf8", input: readFileSync("src/styles/base.css", "utf8") })) as { rule: string }[][];

    expect(result[0]).toEqual([]);
    for (const violations of result.slice(1)) {
      expect(violations.map(({ rule }) => rule)).toContain("customer-theme-binding");
    }
  });
});
