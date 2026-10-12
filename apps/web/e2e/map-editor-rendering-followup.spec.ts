import { expect, test } from "@playwright/test";
import type { MapElement } from "@led-control/shared/map-document-contracts";
import { buildMapDisplay } from "../../api/src/floor-editor/map-display-builder";

for (const { width, denseLines } of [{ width: 768, denseLines: 0 }, { width: 320, denseLines: 0 }, { width: 768, denseLines: 10_000 }])
test(`ordered Pixi camera work is bounded at ${width}px with ${denseLines} lines`, async ({ page }, testInfo) => {
  const common = { groupId: null, layerId: "plan", visible: true, locked: false, provenance: null,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 } };
  const elements: MapElement[] = [
    { ...common, id: "red", type: "rectangle", zIndex: 0,
      geometry: { origin: { x: 10, y: 10 }, width: 490, height: 490 },
      style: { fillColor: "#ff0000", strokeColor: null, strokeWidth: 0, opacity: 0.5 } },
    { ...common, id: "green", type: "rectangle", zIndex: 1,
      geometry: { origin: { x: 10, y: 10 }, width: 490, height: 490 },
      style: { fillColor: "#00ff00", strokeColor: null, strokeWidth: 0, opacity: 0.5 } }
  ];
  for (let i = 0; i < denseLines; i++) {
    const x = 235 + (i % 100) * 0.1, y = 235 + Math.floor(i / 100) * 0.1;
    elements.push({ ...common, id: `dense-${i}`, type: "line", zIndex: i + 2,
      geometry: { start: { x, y }, end: { x: x + 0.08, y: y + 0.08 } },
      style: { fillColor: null, strokeColor: "#0000ff", strokeWidth: 0.04, opacity: 0.8 } });
  }
  const ref = { formatVersion: 1 as const, generationId: "11111111-1111-4111-8111-111111111111", revision: 0,
    width: 2048, height: 1024, gridSize: 10, elementCount: elements.length,
    manifest: { assetId: "22222222-2222-4222-8222-222222222222", sha256: "a".repeat(64), byteSize: 100, decodedByteSize: 100 } };
  const tiles: Array<{ descriptor: Parameters<Parameters<typeof buildMapDisplay>[2]>[0]["descriptor"]; base64: string }> = [];
  await buildMapDisplay(ref, (async function* () { yield* elements; })(), async tile => {
    tiles.push({ descriptor: tile.descriptor, base64: tile.payload.toString("base64") });
  });
  await page.setViewportSize({ width, height: 480 });
  await page.goto("/src/features/map-scene/map-scene-raster-smoke.html");
  const evidence = await page.evaluate(async ({ tiles, ref, width, denseLines }) => {
    const rendererPath = "/src/features/map-scene/MapSceneRenderer.ts", backendPath = "/src/features/map-scene/map-raster-backend.ts";
    const [{ MapSceneRenderer }, { MapRasterBackend }] = await Promise.all([
      import(/* @vite-ignore */ rendererPath), import(/* @vite-ignore */ backendPath)
    ]);
    const proto = Object.getPrototypeOf(MapRasterBackend.prototype);
    const originalRender = proto.render, originalRaster = proto.replaceRaster, originalResize = proto.resize;
    let draws = 0, bakes = 0, loads = 0, resizes = 0, peakBytes = 0, ready = false;
    proto.render = function(...args: unknown[]) { draws++; return originalRender.apply(this, args); };
    proto.replaceRaster = function(...args: unknown[]) { bakes++; return originalRaster.apply(this, args); };
    proto.resize = function(...args: unknown[]) { resizes++; return originalResize.apply(this, args); };
    const canvas = document.createElement("canvas"); canvas.style.width = `${width}px`; canvas.style.height = "240px";
    const getContext = canvas.getContext.bind(canvas);
    canvas.getContext = ((kind: string, options?: object) => getContext(kind as "webgl2", { ...options, preserveDrawingBuffer: true })) as typeof canvas.getContext;
    document.body.replaceChildren(canvas);
    const errors: string[] = [], degraded: unknown[] = [], descriptors = tiles.map(tile => tile.descriptor);
    const renderer = new MapSceneRenderer({ platform: width < 768 ? "mobile" : "desktop", devicePixelRatio: 1,
      onPaintReady: (value: boolean) => { ready = value; }, onError: (error: Error) => errors.push(error.message),
      onDegraded: (value: unknown) => degraded.push(value), source: {
        scopeKey: "ordered-followup", getElements: async () => [],
        getChanges: async () => ({ generationId: ref.generationId, revision: 0, operations: [], nextCursor: null }),
        loadDisplayTile: async (tile: { assetId: string }) => { loads++; return Uint8Array.from(atob(tiles.find(value => value.descriptor.assetId === tile.assetId)!.base64), c => c.charCodeAt(0)); },
        getManifest: async () => ({ generationId: ref.generationId, revision: 0, canonical: ref.manifest, groups: [],
          layers: [{ id: "plan", name: "Plan", order: 0, visible: true, locked: false }],
          displayLayerBindings: [{ layerName: "plan", layerId: "plan" }], display: {
            version: 2, orderedPages: { version: 1 }, sceneId: ref.generationId, regionId: "fixture", manifestAssetId: "display",
            width: ref.width, height: ref.height, padding: 0, gridSize: 10, tileSize: 512, lodMode: "additive",
            primitiveCount: descriptors.reduce((sum, tile) => sum + tile.primitiveCount, 0), tileCount: descriptors.length,
            byteSize: 100, sha256: "b".repeat(64), sourceBounds: { minX: 0, minY: 0, maxX: ref.width, maxY: ref.height },
            transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }, tiles: descriptors }
        })
      } });
    const frame = () => new Promise<number>(resolve => requestAnimationFrame(time => { peakBytes = Math.max(peakBytes, renderer.memoryBytes); resolve(time); }));
    const waitReady = async () => {
      const deadline = performance.now() + 10_000;
      while (!ready) { if (errors.length || performance.now() > deadline) throw new Error(`Coverage: ${errors}`); await frame(); }
      await frame(); await frame();
    };
    let camera = { centerX: 256, centerY: 256, viewportWidth: width, viewportHeight: 240, zoom: 4 };
    const counts = () => ({ draws, bakes, loads, resizes });
    const delta = (before: ReturnType<typeof counts>) => ({ draws: draws - before.draws, bakes: bakes - before.bakes,
      loads: loads - before.loads, resizes: resizes - before.resizes });
    const pixel = (worldX = camera.centerX, worldY = camera.centerY) => {
      const gl = canvas.getContext("webgl2")!, value = new Uint8Array(4);
      const x = Math.floor((worldX - camera.centerX) * camera.zoom + width / 2);
      const y = Math.floor((worldY - camera.centerY) * camera.zoom + 120);
      gl.finish(); gl.readPixels(x, canvas.height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, value); return [...value];
    };
    try {
      await renderer.mount(canvas); await renderer.setDocument(ref); renderer.setCamera(camera); await waitReady();
      const initialPixel = pixel(), densePixel = denseLines ? pixel(240, 240) : null, beforeNoop = counts();
      for (let i = 0; i < 20; i++) { renderer.setCamera({ ...camera }); await frame(); }
      await frame(); const noop = delta(beforeNoop), beforePan = counts(), frames: number[] = [];
      let last = await frame();
      for (let i = 0; i < 60; i++) {
        camera = { ...camera, centerX: 256 + (i % 10) * 0.1 };
        renderer.setCamera(camera); const now = await frame(); frames.push(now - last); last = now;
      }
      await waitReady(); const pan = delta(beforePan), beforeDensity = counts();
      camera = { ...camera, zoom: 4.2 }; renderer.setCamera(camera); await waitReady();
      await new Promise(resolve => setTimeout(resolve, 160)); await waitReady();
      const density = delta(beforeDensity), beforeEntry = counts();
      camera = { ...camera, centerX: 450 }; renderer.setCamera(camera); await waitReady();
      const entry = delta(beforeEntry), beforeReturn = counts();
      camera = { ...camera, centerX: 256 }; renderer.setCamera(camera); await waitReady();
      const back = delta(beforeReturn), finalPixel = pixel();
      const image = document.createElement("img"); image.src = canvas.toDataURL();
      renderer.dispose(); document.body.replaceChildren(image);
      return { width, elements: ref.elementCount, denseLines, fixtures: 0, displayPrimitives: descriptors.reduce((sum, tile) => sum + tile.primitiveCount, 0),
        assets: descriptors.length, ordered: true, noop, pan, density, entry, back, initialPixel, finalPixel, densePixel,
        frameP95: [...frames].sort((a, b) => a - b)[Math.ceil(frames.length * 0.95) - 1], peakBytes,
        budgetBytes: (width < 768 ? 32 : 128) * 1024 * 1024, disposedBytes: renderer.memoryBytes, errors, degraded };
    } finally { renderer.dispose(); proto.render = originalRender; proto.replaceRaster = originalRaster; proto.resize = originalResize; }
  }, { tiles, ref, width, denseLines });
  console.log(`F3_EVIDENCE ${JSON.stringify(evidence)}`);
  await testInfo.attach("ordered-camera-evidence", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath("ordered-camera.png") });
  expect(evidence.errors).toEqual([]); expect(evidence.degraded).toEqual([]);
  expect(evidence.initialPixel).toEqual(evidence.finalPixel);
  expect(evidence.initialPixel[1]).toBeGreaterThan(evidence.initialPixel[0]);
  expect(evidence.initialPixel[3]).toBeGreaterThan(180); expect(evidence.initialPixel[3]).toBeLessThan(200);
  if (denseLines) { expect(evidence.densePixel![2]).toBeGreaterThan(0); expect(evidence.densePixel![3]).toBeGreaterThan(192); }
  expect(evidence.peakBytes).toBeLessThanOrEqual(evidence.budgetBytes); expect(evidence.disposedBytes).toBe(0);
  if (process.env.F3_BASELINE !== "1") {
    expect(evidence.noop).toEqual({ draws: 0, bakes: 0, loads: 0, resizes: 0 });
    expect(evidence.pan.resizes).toBe(0); expect(evidence.pan.draws).toBeLessThanOrEqual(60);
    expect(evidence.pan.bakes).toBe(0); expect(evidence.pan.loads).toBe(0);
    expect(evidence.density.loads).toBe(0); expect(evidence.entry.loads).toBe(0);
    expect(evidence.back.bakes).toBe(0); expect(evidence.back.loads).toBe(0);
    expect(evidence.frameP95).toBeLessThanOrEqual(33);
  }
});

for (const mode of ["space", "middle"] as const) test(`first fixture click works after ${mode} pan`, async ({ page }, testInfo) => {
  page.on("pageerror", error => console.log(`F3_FIRST_CLICK_ERROR ${error.stack}`));
  await page.setViewportSize({ width: 768, height: 640 });
  await page.route(url => url.pathname.startsWith("/api/"), route => route.fulfill({ status: 200, json: {} }));
  await page.goto("/src/features/map-scene/map-scene-raster-smoke.html");
  await page.evaluate(async () => {
    const path = "/src/features/map-scene/rendering-followup-smoke.tsx";
    const { mountPanHitFixture } = await import(/* @vite-ignore */ path);
    (window as unknown as { panHitFixture: ReturnType<typeof mountPanHitFixture> }).panHitFixture = mountPanHitFixture({ floor: { id: "pan-hit", siteId: "site", name: "Pan hit", level: 1, mapRevision: 1,
      floorPlan: { imageUrl: "", sourceType: "none", width: 1200, height: 800, gridSize: 10, version: 1 } },
      fixtures: [{ id: "lamp", name: "Lamp", x: 600, y: 400, size: 40, placementStatus: "placed",
        ratedWatt: 40, brightness: 80, status: "online" }], objects: [], lightSlots: [] });
  });
  const canvas = page.getByTestId("floor-editor-canvas");
  await expect(canvas).toHaveAttribute("data-rendered-fixture-count", "1");
  const box = (await canvas.boundingBox())!;
  const listening = () => page.evaluate(() => (window as unknown as { panHitFixture: { snapshot(): { listening: boolean[] } } }).panHitFixture.snapshot().listening);
  const pixel = () => page.evaluate(() => (window as unknown as { panHitFixture: { snapshot(): { pixel: number[] } } }).panHitFixture.snapshot().pixel);
  await expect.poll(listening).toEqual([true, true, true]);
  await expect.poll(async () => (await pixel())[3]).toBeGreaterThan(0);
  const initialPixel = await pixel();
  const panBefore = Number(await canvas.getAttribute("data-pan-x"));
  await page.mouse.move(box.x + box.width / 2 - 80, box.y + box.height / 2 - 60);
  if (mode === "space") await page.keyboard.down("Space");
  await page.mouse.down({ button: mode === "middle" ? "middle" : "left" });
  await expect.poll(listening).toEqual([false, false, false]);
  for (let step = 1; step <= 60; step++) await page.mouse.move(box.x + box.width / 2 - 80 + step / 2, box.y + box.height / 2 - 60);
  await page.mouse.up({ button: mode === "middle" ? "middle" : "left" });
  if (mode === "space") await page.keyboard.up("Space");
  await expect.poll(listening).toEqual([true, true, true]);
  await expect.poll(async () => Number(await canvas.getAttribute("data-pan-x"))).not.toBe(panBefore);
  await expect.poll(pixel).toEqual(initialPixel);
  const point = await canvas.evaluate(element => {
    const rect = element.getBoundingClientRect(), zoom = Number(element.dataset.zoom);
    return { x: rect.x + Number(element.dataset.panX) + 600 * zoom, y: rect.y + Number(element.dataset.panY) + 400 * zoom };
  });
  await page.mouse.click(point.x, point.y);
  await expect.poll(() => page.evaluate(async () => {
    const path = "/src/features/floor-editor/editor-store.ts";
    const { useFloorEditorStore } = await import(/* @vite-ignore */ path);
    return useFloorEditorStore.getState().selectedFixtureIds;
  })).toEqual(["lamp"]);
  await testInfo.attach("first-click-pan-evidence", { body: JSON.stringify({ mode, moves: 60, fixtureCount: 1,
    initialPixel, panPixel: initialPixel, selectedFixtureIds: ["lamp"], listening: await listening() }), contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath(`first-click-${mode}.png`) });
});
