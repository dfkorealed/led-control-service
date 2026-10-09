import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";

// Exercise the real Vite/Rollup graph; the injected import is tree-shaken from
// output, so a text-only bundle scan would miss this forbidden dependency.
test("real Rollup build refuses a tree-shaken inquiry API dependency", async () => {
  await assert.rejects(build({
    configFile: fileURLToPath(new URL("../vite.landing.config.ts", import.meta.url)),
    logLevel: "silent",
    plugins: [{
      name: "negative-landing-import-fixture",
      enforce: "pre",
      transform(source, id) {
        if (id.endsWith("/src/landing-main.tsx")) return `import "./api/landing-inquiries";\n${source}`;
      }
    }],
    build: { write: false }
  }), /Forbidden landing module: .*\/src\/api\/landing-inquiries\.ts/);
});
