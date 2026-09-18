import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { compile } from "tailwindcss";
import { inspectUiSource } from "./ui-policy.mjs";

test("compact shell safe-area utilities preserve navigation geometry without feature-level env values", async () => {
  const path = "src/styles/base.css";
  const source = await readFile(new URL("../src/styles/base.css", import.meta.url), "utf8");

  assert.match(
    source,
    /@utility pb-shell-navigation-safe\s*{\s*padding-bottom:\s*calc\(var\(--spacing\) \* 17 \+ env\(safe-area-inset-bottom\)\);\s*}/
  );
  assert.match(
    source,
    /@utility h-shell-navigation-safe\s*{\s*height:\s*calc\(var\(--spacing\) \* 17 \+ env\(safe-area-inset-bottom\)\);\s*}/
  );
  assert.match(
    source,
    /@utility pb-safe-area-bottom\s*{\s*padding-bottom:\s*env\(safe-area-inset-bottom\);\s*}/
  );
  assert.deepEqual(inspectUiSource(path, source), []);

  const compiler = await compile(`@tailwind utilities;\n${source}`);
  const css = compiler.build([
    "pb-shell-navigation-safe",
    "h-shell-navigation-safe",
    "pb-safe-area-bottom"
  ]);
  assert.match(css, /\.pb-shell-navigation-safe\s*{[^}]*padding-bottom:\s*calc\(var\(--spacing\) \* 17 \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /\.h-shell-navigation-safe\s*{[^}]*height:\s*calc\(var\(--spacing\) \* 17 \+ env\(safe-area-inset-bottom\)\)/);
  assert.match(css, /\.pb-safe-area-bottom\s*{[^}]*padding-bottom:\s*env\(safe-area-inset-bottom\)/);
});
