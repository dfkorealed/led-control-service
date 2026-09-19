import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { cadSceneCodecGolden } from "../cad-scene/cad-scene-codec.golden";

for (const width of [1024, 320]) test(`HTTP provider and stable React Canvas save/reload/read-only at ${width}px`, async ({ page }, testInfo) => {
  const bytes = Buffer.from(cadSceneCodecGolden.payloadBase64, "base64");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const sceneId = "00000000-0000-4000-8000-000000000001";
  const assetId = "00000000-0000-4000-8000-000000000002";
  const manifestId = "00000000-0000-4000-8000-000000000003";
  const ref = { formatVersion: 1 as const, generationId: "http-generation", revision: 0, width: 1024, height: 1024,
    gridSize: 50, elementCount: 7, manifest: { assetId: manifestId, sha256, byteSize: 100, decodedByteSize: 100 } };
  const tile = { version: 1, sceneId, assetId, sha256, byteSize: bytes.length, tileX: 0, tileY: 0, part: 0, lod: 0,
    primitiveCount: 7, bounds: { minX: 0, minY: 0, maxX: 512, maxY: 512 } };
  const layers = ["WALLS", "DOORS", "ELECTRICAL", "LABELS"].map((name, order) => ({ id: `layer-${order}`, name, order, visible: true, locked: false }));
  const requests: string[] = [];
  await page.route("**/api/floors/u9b-http/map-document/**", async route => {
    const url = new URL(route.request().url()); requests.push(url.pathname + url.search);
    const revision = Number(url.searchParams.get("revision"));
    if (url.pathname.endsWith("/manifest")) {
      await route.fulfill({ json: { generationId: ref.generationId, revision, canonical: ref.manifest, layers, groups: [],
        displayLayerBindings: layers.map(layer => ({ layerName: layer.name, layerId: layer.id })), display: {
          version: 1, sceneId, regionId: "manual", manifestAssetId: manifestId, width: 1024, height: 1024,
          padding: 0, gridSize: 50, tileSize: 512, lodMode: "additive", primitiveCount: 7, tileCount: 1,
          byteSize: 100, sha256, sourceBounds: { minX: 0, minY: 0, maxX: 1024, maxY: 1024 },
          transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }, tiles: [tile] } } });
    } else if (url.pathname.endsWith("/changes")) {
      await route.fulfill({ json: { generationId: ref.generationId, revision,
        operations: revision > 0 ? [{ kind: "delete", id: "polyline-golden" }] : [], nextCursor: null } });
    } else if (url.pathname.includes("/tiles/")) {
      await route.fulfill({ body: bytes, contentType: "application/octet-stream" });
    } else if (url.pathname.endsWith("/elements")) await route.fulfill({ json: [] });
    else await route.fulfill({ status: 404 });
  });
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.setViewportSize({ width, height: 480 });
  await page.goto("/src/features/cad-scene/cad-scene-webgl-smoke.html");
  const evidence = await page.evaluate(async ({ ref, width }) => {
    const fixturePath = "/src/features/map-scene/map-scene-canvas-smoke.tsx";
    const { mountMapSceneSmoke } = await import(/* @vite-ignore */ fixturePath);
    const h = mountMapSceneSmoke(ref, width);
    const wait = async (predicate: () => boolean) => {
      for (let i = 0; i < 300; i++) { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); if (predicate()) return; }
      throw new Error(`HTTP Canvas GPU wait failed: ${h.errors.join(",")}; pixel=${h.pixel(30, 25)}`);
    };
    await wait(() => h.versions.length === 1 && h.pixel(30, 25)[3] > 20);
    const canvas = h.canvas();
    const version = h.handle.current!.applyChanges([{ kind: "delete", id: "polyline-golden" }], [{ minX: 20, minY: 20, maxX: 40, maxY: 40 }]);
    await wait(() => h.pixel(30, 25)[3] === 0 && h.pixel(6, 7)[3] > 0);
    const saved = { ...ref, revision: 1 };
    const ack = h.handle.current!.acknowledge(saved, version);
    h.render(saved);
    await ack;
    await wait(() => h.versions.includes(1) && h.pixel(30, 25)[3] === 0 && h.pixel(6, 7)[3] > 0);
    const stableCanvas = canvas === h.canvas(), stableRenderer = h.renderers.length === 1;
    h.handle.current!.setDraftChanges([], []);
    await wait(() => h.pixel(30, 25)[3] === 0 && h.pixel(6, 7)[3] > 0);
    const memory = h.renderers[0].memoryBytes;
    h.render(saved, true);
    await wait(() => h.renderers.length === 2 && h.pixel(30, 25)[3] === 0 && h.pixel(6, 7)[3] > 0 && h.versions.length >= 3);
    const readOnlyCanvasRenewed = h.canvas() !== canvas;
    let readOnlyRejected = false;
    try { h.handle.current!.applyChanges([{ kind: "delete", id: "x" }], []); } catch { readOnlyRejected = true; }
    const beforeDispose = h.renderers.map((renderer: { memoryBytes: number }) => renderer.memoryBytes);
    h.dispose();
    return { stableCanvas, stableRenderer, readOnlyCanvasRenewed, readOnlyRejected, memory, beforeDispose,
      afterDispose: h.renderers.map((renderer: { memoryBytes: number }) => renderer.memoryBytes), errors: h.errors };
  }, { ref, width });
  expect(evidence).toMatchObject({ stableCanvas: true, stableRenderer: true, readOnlyCanvasRenewed: true, readOnlyRejected: true, afterDispose: [0, 0], errors: [] });
  expect(evidence.memory).toBeLessThanOrEqual((width === 320 ? 32 : 128) * 1024 * 1024);
  expect(requests.filter(url => url.includes("/elements"))).toHaveLength(0);
  expect(requests.filter(url => url.includes("/tiles/"))).toHaveLength(2);
  expect(errors).toEqual([]);
  await testInfo.attach("http-canvas-evidence", { body: JSON.stringify({ ...evidence, requests }, null, 2), contentType: "application/json" });
});
