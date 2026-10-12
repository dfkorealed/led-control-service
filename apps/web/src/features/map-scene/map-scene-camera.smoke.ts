import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import type { MapElement } from "@led-control/shared/map-document-contracts";
import { buildMapDisplay } from "../../../../api/src/floor-editor/map-display-builder";

for (const width of [768, 320]) test(`ordinary drawing reuses pan coverage and refreshes zoom detail at ${width}px`, async ({ page }, testInfo) => {
  const elements: MapElement[] = [];
  const common = { groupId: null, layerId: "plan", visible: true, locked: false, provenance: null,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 } };
  for (let y = 0; y < 4; y++) for (let x = 0; x < 8; x++) {
    elements.push({ ...common, id: `room-${x}-${y}`, zIndex: 0, type: "rectangle",
      geometry: { origin: { x: x * 256 + 20, y: y * 256 + 20 }, width: 210, height: 210 },
      style: { fillColor: "#20c080", strokeColor: "#ffffff", strokeWidth: 2, opacity: 0.6 } });
    elements.push({ ...common, id: `label-${x}-${y}`, zIndex: 1, type: "text",
      geometry: { position: { x: x * 256 + 60, y: y * 256 + 80 }, width: 100, height: 24, fontSize: 20, text: `ROOM ${x}${y}` },
      style: { fillColor: "#ffffff", strokeColor: null, strokeWidth: 0, opacity: 1 } });
  }
  const tiles: Array<{ descriptor: Parameters<Parameters<typeof buildMapDisplay>[2]>[0]["descriptor"]; base64: string }> = [];
  const ref = { formatVersion: 1 as const, generationId: "11111111-1111-4111-8111-111111111111", revision: 0,
    width: 2048, height: 1024, gridSize: 10, elementCount: elements.length,
    manifest: { assetId: "22222222-2222-4222-8222-222222222222", sha256: "a".repeat(64), byteSize: 100, decodedByteSize: 100 } };
  await buildMapDisplay(ref, (async function* () { yield* elements; })(), async tile => {
    tiles.push({ descriptor: tile.descriptor, base64: tile.payload.toString("base64") });
  });
  const sourceHash = createHash("sha256").update(JSON.stringify(tiles)).digest("hex");
  await page.setViewportSize({ width, height: 480 });
  await page.goto("/src/features/map-scene/map-scene-raster-smoke.html");
  const pageErrors: string[] = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  const evidence = await page.evaluate(async ({ tiles, width, ref }) => {
    const backendPath = "/src/features/map-scene/map-raster-backend.ts";
    const budgetPath = "/src/features/cad-scene/cad-scene-memory-budget.ts";
    const [{ MapRasterBackend }, { CadSceneMemoryBudget }] = await Promise.all([
      import(/* @vite-ignore */ backendPath), import(/* @vite-ignore */ budgetPath)
    ]);
    const canvas = document.createElement("canvas");
    canvas.style.width = `${width}px`; canvas.style.height = "256px";
    document.body.style.margin = "0"; document.body.replaceChildren(canvas);
    const getContext = canvas.getContext.bind(canvas);
    canvas.getContext = ((kind: string, options: object) => getContext(kind as "webgl2", { ...options, preserveDrawingBuffer: true })) as typeof canvas.getContext;
    const budget = new CadSceneMemoryBudget((width === 320 ? 32 : 128) * 1024 * 1024);
    let bakes = 0, fetches = 0, peakBytes = 0;
    const densities: number[] = [];
    class RecordingBackend extends MapRasterBackend {
      constructor(memoryBudget: typeof budget) { super(memoryBudget); }
      replaceRaster(key: string, raster: HTMLCanvasElement, bounds: { minX: number; maxX: number; minY: number; maxY: number }) {
        bakes++; densities.push(raster.width / (bounds.maxX - bounds.minX));
        super.replaceRaster(key, raster, bounds);
        peakBytes = Math.max(peakBytes, budget.totalBytes);
      }
    }
    const backend = new RecordingBackend(budget);
    const errors: string[] = [], degraded: unknown[] = [];
    const camera = { centerX: 512, centerY: 512, zoom: 1, viewportWidth: width, viewportHeight: 256 };
    const request = { camera, resolution: 1, signal: new AbortController().signal, excludedIds: new Set<string>(),
      manifest: { version: 2, orderedPages: { version: 1 }, sceneId: "ordinary", width: 2048, height: 1024, tileSize: 512,
        tiles: tiles.map(tile => tile.descriptor), sha256: "a".repeat(64), manifestAssetId: "ordinary", tileCount: tiles.length },
      loadTile: async (descriptor: { assetId: string }) => { fetches++; return Uint8Array.from(atob(tiles.find(tile => tile.descriptor.assetId === descriptor.assetId)!.base64), value => value.charCodeAt(0)); },
      worker: { decode() { throw new Error("Ordered input must use validated pages"); }, destroy() {} },
      onError: (error: Error) => errors.push(error.message), onDegraded: (value: unknown) => degraded.push(value) };
    await backend.mount(canvas, { resolution: 1 });
    backend.resize(width, 256, 1);
    backend.setLayerStates(new Map([["plan", { visible: true, order: 0 }]]));
    const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const wait = async () => { await new Promise(resolve => setTimeout(resolve, 160)); await frame(); await frame(); backend.render(); };
    const pixel = (wx: number, wy: number) => {
      const gl = canvas.getContext("webgl2")!;
      const x = Math.floor((wx - camera.centerX) * camera.zoom + width / 2);
      const y = Math.floor((wy - camera.centerY) * camera.zoom + 128);
      const value = new Uint8Array(4);
      gl.finish(); gl.readPixels(x, canvas.height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, value);
      return [...value];
    };
    const apply = async () => { backend.setCamera(camera); backend.render(); await backend.renderDisplay({ ...request, camera: { ...camera } }); await frame(); backend.render(); };
    await apply(); await wait();
    const initialBakes = bakes, initialPixel = pixel(450, 450);
    const panPixels: number[][] = [];
    for (let round = 0; round < 5; round++) {
      for (let input = 0; input < 5; input++) {
        camera.centerX = 512 + (round * 5 + input + 1) * 0.25;
        await apply(); panPixels.push(pixel(450, 450));
      }
      await wait();
    }
    const panBakes = bakes - initialBakes;
    const beforeZoom = bakes;
    for (const zoom of [1.05, 1.1, 1.15, 1.2]) { camera.zoom = zoom; await apply(); panPixels.push(pixel(450, 450)); }
    const liveZoomBakes = bakes - beforeZoom;
    await wait(); const detailBakes = bakes - beforeZoom, zoomPixel = pixel(450, 450);
    camera.centerX = 1408; await apply(); await wait();
    const beforeReturn = bakes;
    camera.centerX = 512; camera.zoom = 1.2;
    backend.setCamera(camera); backend.render();
    const synchronousReturnPixel = pixel(450, 450);
    await backend.renderDisplay({ ...request, camera: { ...camera } }); await wait();
    const returnBakes = bakes - beforeReturn;
    // Exact density 1 remains cached in its half-octave bucket.
    const beforeBandReturn = bakes;
    camera.zoom = 1; await apply(); await wait();
    const bandReturnBakes = bakes - beforeBandReturn;
    const finalPixel = pixel(450, 450), bytes = budget.totalBytes;
    const image = new Image(); image.src = canvas.toDataURL("image/png");
    await image.decode();
    backend.destroy();
    const disposedBytes = budget.totalBytes;
    // Metadata adoption must not open the import gate while visible tile I/O
    // is blocked. Exercise the public renderer, not just its raster backend.
    const rendererPath = "/src/features/map-scene/MapSceneRenderer.ts";
    const { MapSceneRenderer } = await import(/* @vite-ignore */ rendererPath);
    const preview = document.createElement("canvas");
    document.body.replaceChildren(preview);
    const previewContext = preview.getContext.bind(preview);
    preview.getContext = ((kind: string, options: object) => previewContext(kind as "webgl2", { ...options, preserveDrawingBuffer: true })) as typeof preview.getContext;
    let release!: () => void, started = 0;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const readiness: boolean[] = [], readyPixels: number[][] = [];
    const previewCamera = { ...camera, centerX: 512, centerY: 512, zoom: 1 };
    const renderer = new MapSceneRenderer({ platform: width === 320 ? "mobile" : "desktop", devicePixelRatio: 1,
      source: { scopeKey: "fixture:paint-ready", getElements: async () => [],
        getChanges: async (document: typeof ref) => ({ generationId: document.generationId, revision: document.revision, operations: [], nextCursor: null }),
        getManifest: async (document: typeof ref) => ({ generationId: document.generationId, revision: document.revision,
          canonical: document.manifest, groups: [], layers: [{ id: "plan", name: "Plan", order: 0, visible: true, locked: false }],
          displayLayerBindings: [{ layerName: "plan", layerId: "plan" }], display: request.manifest }),
        loadDisplayTile: async (descriptor: { assetId: string }) => { started++; await blocked; return request.loadTile(descriptor); } },
      onError: (error: Error) => errors.push(error.message),
      onPaintReady: (ready: boolean) => {
        readiness.push(ready);
        if (ready) {
          const gl = preview.getContext("webgl2")!, value = new Uint8Array(4);
          const x = Math.floor((450 - previewCamera.centerX) * previewCamera.zoom + previewCamera.viewportWidth / 2);
          const y = Math.floor((450 - previewCamera.centerY) * previewCamera.zoom + previewCamera.viewportHeight / 2);
          gl.finish(); gl.readPixels(x, preview.height - 1 - y, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, value);
          readyPixels.push([...value]);
        }
      } });
    await renderer.mount(preview);
    renderer.setCamera(previewCamera);
    await renderer.setDocument(ref);
    while (!started) { if (errors.length) throw new Error(errors.join(";")); await frame(); }
    await frame();
    const readyBeforeRelease = readiness.includes(true);
    release();
    const awaitReady = async () => {
      while (readiness.at(-1) !== true) { if (errors.length) throw new Error(errors.join(";")); await frame(); }
    };
    await awaitReady();
    const recovery: Array<{ reset: boolean; restored: boolean }> = [];
    for (const input of [{}, { centerX: 512.25 }, { viewportWidth: width - 8 }]) {
      Object.assign(previewCamera, input);
      renderer.setCamera(previewCamera);
      const reset = readiness.at(-1) === false;
      await awaitReady();
      recovery.push({ reset, restored: readiness.at(-1) === true });
    }
    renderer.dispose();
    const previewDisposedBytes = renderer.memoryBytes;
    document.body.replaceChildren(image);
    return { initialBakes, panBakes, liveZoomBakes, detailBakes, returnBakes, bandReturnBakes,
      initialPixel, zoomPixel, synchronousReturnPixel, finalPixel, minimumPanAlpha: Math.min(...panPixels.map(value => value[3])),
      densities: [...new Set(densities)], fetches, bytes, peakBytes, disposedBytes, errors, degraded,
      readyBeforeRelease, readiness, readyPixels, recovery, previewDisposedBytes };
  }, { tiles, width, ref });
  await page.screenshot({ path: testInfo.outputPath("ordinary-camera.png") });
  await testInfo.attach("ordinary-camera-gpu-evidence", { body: JSON.stringify({ sourceHash, elements: elements.length, width, ...evidence }, null, 2), contentType: "application/json" });
  expect(evidence.errors).toEqual([]); expect(evidence.degraded).toEqual([]); expect(pageErrors).toEqual([]);
  expect(evidence.initialBakes).toBeGreaterThan(0);
  expect(evidence).toMatchObject({ panBakes: 0, liveZoomBakes: 0, returnBakes: 0, bandReturnBakes: 0, disposedBytes: 0 });
  expect(evidence.detailBakes).toBeGreaterThan(0);
  for (const pixel of [evidence.initialPixel, evidence.zoomPixel, evidence.synchronousReturnPixel, evidence.finalPixel]) {
    expect(pixel[1]).toBeGreaterThan(100); expect(pixel[3]).toBeGreaterThan(100); expect(pixel[3]).toBeLessThan(180);
  }
  expect(evidence.minimumPanAlpha).toBeGreaterThan(100);
  expect(evidence.densities.some(value => Math.abs(value - 1) < 1e-10)).toBe(true);
  expect(evidence.densities.some(value => Math.abs(value - 1.2) < 1e-10)).toBe(true);
  expect(evidence.peakBytes).toBeLessThanOrEqual((width === 320 ? 32 : 128) * 1024 * 1024);
  expect(evidence.readyBeforeRelease).toBe(false);
  expect(evidence.recovery).toEqual(Array.from({ length: 3 }, () => ({ reset: true, restored: true })));
  expect(evidence.readyPixels).toHaveLength(4);
  for (const pixel of evidence.readyPixels) expect(pixel).toEqual(evidence.initialPixel);
  expect(evidence.readiness.at(-1)).toBe(false);
  expect(evidence.previewDisposedBytes).toBe(0);
});
