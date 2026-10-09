import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

test("landing has a standalone build contract independent of shared", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts["build:landing"], "vite build --config vite.landing.config.ts");
});

import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { assertLandingModules, assertLandingOutput } from "./static-landing-contract.mjs";
import { createLandingServer } from "./serve-static-landing.mjs";

test("actual module graph rejects internal, concept, and inquiry imports even when tree-shaken", () => {
  for (const module of ["src/AppRoot.tsx", "src/main.tsx", "src/api/client.ts", "src/features/auth/AuthView.tsx", "src/features/mobile/mobile-bootstrap.ts", "src/features/control/ControlView.tsx", "src/features/operator/OperatorShell.tsx", "src/features/landing/FieldDayConceptPage.tsx", "src/features/landing/InquiryForm.tsx", "src/components/ui/fields/NativeInquiryField.tsx", "src/features/landing/PublicContact.test.tsx"]) {
    assert.throws(() => assertLandingModules(["/web/src/landing-main.tsx", `/web/${module}`], "/web"), /Forbidden|Test/);
  }
  assert.deepEqual(assertLandingModules(["/web/src/landing-main.tsx", "/web/src/features/landing/LandingPage.tsx"], "/web"), ["src/features/landing/LandingPage.tsx", "src/landing-main.tsx"]);
});

test("emitted output audit rejects unapproved files and bundled API code", () => {
  const html = { "index.html": { type: "asset" }, "404.html": { type: "asset" } };
  assert.throws(() => assertLandingOutput({ ...html, "concepts/field-day.html": { type: "asset" } }), /Unapproved/);
  assert.throws(() => assertLandingOutput({ ...html, "assets/main-abcdef.js": { type: "chunk", code: 'fetch("/api/auth/me")' } }), /Internal/);
  assert.doesNotThrow(() => assertLandingOutput({ ...html, "assets/main-abcdef.js": { type: "chunk", code: "console.log('public')" } }));
});

test("backend-free HTTP server returns exact public routes, allowlisted assets and real 404", async () => {
  const directory = await mkdtemp(join(tmpdir(), "kinda-static-"));
  await writeFile(join(directory, "index.html"), "public landing");
  await writeFile(join(directory, "404.html"), "public not found");
  await mkdir(join(directory, "assets"));
  await writeFile(join(directory, "assets/main-abcdef.js"), "public JS");
  const server = createLandingServer(directory);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    for (const route of ["/", "/features", "/pricing", "/features?source=test"]) {
      const response = await fetch(`${base}${route}`); assert.equal(response.status, 200, route); assert.equal(await response.text(), "public landing");
    }
    for (const route of ["/features/", "/pricing/", "/login", "/operator", "/api/auth/me", "/concepts/field-day.html", "/unknown", "/index.html", "/404.html", "/assets/missing-abcdef.js", "/assets/plain.js", "/%66eatures"]) {
      const response = await fetch(`${base}${route}`); assert.equal(response.status, 404, route); assert.equal(await response.text(), "public not found");
    }
    const asset = await fetch(`${base}/assets/main-abcdef.js`); assert.equal(asset.status, 200); assert.match(asset.headers.get("cache-control"), /immutable/);
    const head = await fetch(`${base}/pricing`, { method: "HEAD" }); assert.equal(head.status, 200); assert.equal(await head.text(), "");
    assert.equal((await fetch(`${base}/`, { method: "POST" })).status, 405);
  } finally { await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); }
});

test("emitted public JS rejects archived concept presentation markers", () => {
  for (const marker of ["현장의 하루 · 킨다 랜딩 시안", "이 페이지는 디자인 방향을 검토하기 위한 시안입니다.", "킨다 시안 맨 위로"]) {
    assert.throws(() => assertLandingOutput({ "index.html": { type: "asset" }, "404.html": { type: "asset" }, "assets/main-abcdef.js": { type: "chunk", code: `const copy = ${JSON.stringify(marker)}` } }), /Internal concept/);
  }
});
