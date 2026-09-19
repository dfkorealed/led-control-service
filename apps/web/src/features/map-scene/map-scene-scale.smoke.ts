import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { encodeMapDisplayTile } from "../../../../api/src/floor-import/cad-scene-codec";

for (const [count, platform] of [[300000, "desktop"], [500000, "desktop"], [500000, "mobile"]] as const) {
  test(`ordered full coverage ${count} on ${platform} budget`, async ({ page }, testInfo) => {
    test.setTimeout(120000);
    const side = platform === "mobile" ? 320 : 512;
    const descriptors = [];
    const payloads = new Map<string, Buffer>();
    for (let cell = 0; cell < 256; cell++) {
      const tileX = cell % 16, tileY = Math.floor(cell / 16);
      const localCount = Math.floor(count / 256) + (cell < count % 256 ? 1 : 0);
      const primitives = Array.from({ length: localCount }, (_, i) => ({
        type: "rectangle" as const, elementId: `e-${cell}-${i}`, groupId: null, layerName: `l${i % 3}`, sourceType: "SYNTHETIC",
        zIndex: i, fragmentOrder: 0,
        bounds: { minX: tileX * 512 + (i % 32) * 16 + 2, minY: tileY * 512 + (Math.floor(i / 32) % 32) * 16 + 2,
          maxX: tileX * 512 + (i % 32) * 16 + 14, maxY: tileY * 512 + (Math.floor(i / 32) % 32) * 16 + 14 },
        clipBounds: null, style: { fillColor: ["#ff0000", "#00ff00", "#0000ff"][i % 3], strokeColor: null, strokeWidth: 0, opacity: 0.5 },
        geometry: { origin: { x: tileX * 512 + (i % 32) * 16 + 2, y: tileY * 512 + (Math.floor(i / 32) % 32) * 16 + 2 },
          width: 12, height: 12, rotation: 0 }
      })).reverse();
      const bytes = encodeMapDisplayTile(primitives), assetId = String(cell);
      payloads.set(assetId, bytes);
      descriptors.push({ version: 2, sceneId: "scale", assetId, tileX, tileY, part: 0, lod: 0,
        primitiveCount: localCount, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"),
        bounds: { minX: tileX * 512, minY: tileY * 512, maxX: (tileX + 1) * 512, maxY: (tileY + 1) * 512 } });
    }
    await page.route("**/scale-tiles/*", route => route.fulfill({ body: payloads.get(new URL(route.request().url()).pathname.split("/").at(-1)!)!,
      contentType: "application/octet-stream" }));
    await page.goto("/src/features/map-scene/map-scene-raster-smoke.html");
    const evidence = await page.evaluate(async ({ count, platform, side, descriptors }) => {
      const path = "/src/features/map-scene/MapSceneRenderer.ts", workerPath = "/src/features/cad-scene/cad-scene-worker.ts";
      const backendPath = "/src/features/map-scene/map-raster-backend.ts";
      const [{ MapSceneRenderer }, { createCadSceneWorkerClient }, { MapRasterBackend }] = await Promise.all([
        import(/* @vite-ignore */ path), import(/* @vite-ignore */ workerPath), import(/* @vite-ignore */ backendPath)
      ]);
      const canvas = document.createElement("canvas"); canvas.style.width = `${side}px`; canvas.style.height = `${side}px`;
      document.body.replaceChildren(canvas);
      const getContext = canvas.getContext.bind(canvas);
      canvas.getContext = ((kind: string, options?: object) => getContext(kind as "webgl2", { ...options, preserveDrawingBuffer: true })) as typeof canvas.getContext;
      const errors: string[] = [], degraded: unknown[] = [];
      let bakes = 0, decoded = 0, loads = 0, originals = 0, peak = 0, monitoring = true;
      const cellKeys = new Set<string>();
      const proto = Object.getPrototypeOf(MapRasterBackend.prototype), originalRaster = proto.replaceRaster;
      const display = MapRasterBackend.prototype.renderDisplay;
      let completion = Promise.resolve();
      let raster: { invalidateDisplay(): void } | undefined;
      MapRasterBackend.prototype.renderDisplay = function(...args: unknown[]) {
        raster = this;
        return completion = display.apply(this, args);
      };
      proto.replaceRaster = function(key: string, image: HTMLCanvasElement, bounds: unknown) {
        bakes++; cellKeys.add(key); return originalRaster.call(this, key, image, bounds);
      };
      const worker = createCadSceneWorkerClient();
      const layers = [0, 1, 2].map(order => ({ id: `l${order}`, name: `Layer ${order}`, order, visible: true, locked: false }));
      const ref = { formatVersion: 1, generationId: "scale", revision: 0, width: 8192, height: 8192, gridSize: 50,
        elementCount: count, manifest: { assetId: "canonical", sha256: "c".repeat(64), byteSize: 100, decodedByteSize: 100 } };
      const renderer = new MapSceneRenderer({ platform, devicePixelRatio: 1,
        onError: (error: Error) => errors.push(error.message), onDegraded: (value: unknown) => degraded.push(value), source: {
          scopeKey: "synthetic-full-coverage", getElements: async () => { originals++; return []; },
          getChanges: async () => ({ generationId: ref.generationId, revision: 0, operations: [], nextCursor: null }),
          loadDisplayTile: async (tile: { assetId: string }, signal: AbortSignal) => {
            loads++; return new Uint8Array(await (await fetch(`/scale-tiles/${tile.assetId}`, { signal })).arrayBuffer());
          },
          decodeDisplayTile: async (...args: unknown[]) => { const result = await worker.decode(...args); decoded += result.nativePrimitives?.length ?? 0; return result; },
          getManifest: async () => ({ generationId: ref.generationId, revision: 0, canonical: ref.manifest, groups: [], layers,
            displayLayerBindings: layers.map(layer => ({ layerName: layer.id, layerId: layer.id })), display: {
              version: 2, sceneId: "scale", regionId: "native", manifestAssetId: "display", width: 8192, height: 8192,
              padding: 0, gridSize: 50, tileSize: 512, lodMode: "additive", primitiveCount: count, tileCount: descriptors.length,
              byteSize: 100, sha256: "d".repeat(64), sourceBounds: { minX: 0, minY: 0, maxX: 8192, maxY: 8192 },
              transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }, tiles: descriptors } })
        } });
      const monitor = () => { peak = Math.max(peak, renderer.memoryBytes); if (monitoring) requestAnimationFrame(monitor); }; monitor();
      const frame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
      const wait = async (condition: () => boolean) => {
        const deadline = performance.now() + 90000;
        while (!condition()) { if (errors.length || performance.now() > deadline) throw new Error(`Scale wait ${decoded}/${count}, bakes=${bakes}: ${errors}`); await frame(); }
        await frame(); await frame();
      };
      const camera = { centerX: 4096, centerY: 4096, zoom: side / 8192, viewportWidth: side, viewportHeight: side };
      const started = performance.now(); await renderer.mount(canvas); await renderer.setDocument(ref); renderer.setCamera(camera);
      await wait(() => cellKeys.size === 256);
      const coldMs = performance.now() - started, overviewDecoded = decoded, retained = renderer.memoryBytes;
      const warmStart = performance.now(), warmBakes = bakes, warmDecodedStart = decoded;
      // Warm means a complete re-bake with the bounded raw LRU retained, not
      // merely presenting an unchanged cached framebuffer on the next frame.
      raster!.invalidateDisplay();
      await wait(() => bakes >= warmBakes + 256); await completion;
      const warmMs = performance.now() - warmStart, warmDecoded = decoded - warmDecodedStart;
      // Independent whole-scene canonical painter. No renderer ordering helper,
      // native paint routine, tile raster, or producer pixels are reused here.
      const reference = document.createElement("canvas"); reference.width = side; reference.height = side;
      const ctx = reference.getContext("2d")!; ctx.scale(side / 8192, side / 8192); ctx.globalAlpha = 0.5;
      for (let layer = 0; layer < 3; layer++) for (let cell = 0; cell < 256; cell++) {
        const n = Math.floor(count / 256) + (cell < count % 256 ? 1 : 0);
        ctx.fillStyle = ["#ff0000", "#00ff00", "#0000ff"][layer];
        for (let i = layer; i < n; i += 3) ctx.fillRect((cell % 16) * 512 + (i % 32) * 16 + 2,
          Math.floor(cell / 16) * 512 + (Math.floor(i / 32) % 32) * 16 + 2, 12, 12);
      }
      const expected = ctx.getImageData(0, 0, side, side).data, gl = canvas.getContext("webgl2")!;
      const actual = new Uint8Array(expected.length); gl.readPixels(0, 0, side, side, gl.RGBA, gl.UNSIGNED_BYTE, actual);
      let differing = 0, covered = 0;
      const samples: unknown[] = [];
      for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
        const e = (y * side + x) * 4, a = ((side - y - 1) * side + x) * 4;
        if (expected[e + 3] > 0) covered++;
        if ([0, 1, 2, 3].some(c => Math.abs(actual[a + c] - (c === 3 ? expected[e + c] : expected[e + c] * expected[e + 3] / 255)) > 3)) {
          differing++; if (samples.length < 6) samples.push({ x, y, actual: [...actual.slice(a, a + 4)], expected: [...expected.slice(e, e + 4)] });
        }
      }
      const beforePan = { bakes, decoded, loads }, frames: number[] = [], calls: number[] = [];
      let last = await frame();
      for (let i = 0; i < 100; i++) {
        const start = performance.now();
        renderer.setCamera({ ...camera, centerX: 4096 + (i % 5) / camera.zoom });
        calls.push(performance.now() - start);
        const next = await frame(); frames.push(next - last); last = next;
      }
      renderer.setCamera(camera); await frame(); await frame();
      const panBakes = bakes - beforePan.bakes, panDecoded = decoded - beforePan.decoded;
      const beforeEdit = bakes, editStart = performance.now();
      renderer.applyChanges([{ kind: "add", element: { id: "draft", layerId: "l1", zIndex: 7, groupId: null,
        type: "rectangle", geometry: { origin: { x: 4000, y: 4000 }, width: 30, height: 30 },
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        style: { fillColor: "#ff00ff", strokeColor: null, strokeWidth: 0, opacity: 0.5 }, visible: true, locked: false, provenance: null } }],
      [{ minX: 4000, minY: 4000, maxX: 4030, maxY: 4030 }]);
      await wait(() => bakes > beforeEdit);
      const editMs = performance.now() - editStart, editBakes = bakes - beforeEdit;
      renderer.applyChanges([{ kind: "delete", id: "draft" }], []);
      await frame(); await frame(); await completion;
      const motionFrames: number[] = [];
      last = await frame();
      for (let i = 0; i < 60; i++) {
        renderer.setCamera({ ...camera, centerX: 4096 + (i % 9) * 0.3 / camera.zoom,
          zoom: camera.zoom * (1 + (i % 7) * 0.005) });
        const next = await frame(); motionFrames.push(next - last); last = next;
      }
      const refineStart = performance.now(); renderer.setCamera(camera);
      await frame(); await frame(); await completion; await frame();
      const refineMs = performance.now() - refineStart;
      gl.readPixels(0, 0, side, side, gl.RGBA, gl.UNSIGNED_BYTE, actual);
      let refinedDifferent = 0;
      for (let y = 0; y < side; y++) for (let x = 0; x < side; x++) {
        const e = (y * side + x) * 4, a = ((side - y - 1) * side + x) * 4;
        if ([0, 1, 2, 3].some(c => Math.abs(actual[a + c] - (c === 3 ? expected[e + c] : expected[e + c] * expected[e + 3] / 255)) > 3)) refinedDifferent++;
      }
      const percentile = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length * 0.95)];
      monitoring = false; renderer.dispose(); worker.destroy(); proto.replaceRaster = originalRaster;
      MapRasterBackend.prototype.renderDisplay = display;
      return { count, platform, side, coldMs, warmMs, warmDecoded, overviewDecoded, covered, differing, pixels: side * side,
        retained, peak, frameP95: percentile(frames), cameraCallP95: percentile(calls), panBakes, panDecoded,
        editMs, editBakes, motionFrameP95: percentile(motionFrames), refineMs, refinedDifferent,
        loads, originals, errors, degraded, disposed: renderer.memoryBytes, sceneCells: cellKeys.size, samples };
    }, { count, platform, side, descriptors });
    await testInfo.attach("scale-evidence", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
    expect(evidence.errors).toEqual([]); expect(evidence.degraded).toEqual([]);
    expect(evidence.overviewDecoded).toBe(count); expect(evidence.sceneCells).toBe(256);
    expect(evidence.warmDecoded).toBe(count);
    expect(evidence.differing).toBe(0); expect(evidence.covered).toBe(evidence.pixels);
    expect(evidence.peak).toBeLessThanOrEqual((platform === "mobile" ? 32 : 128) * 1024 * 1024);
    expect(evidence.panBakes).toBe(0); expect(evidence.panDecoded).toBe(0); expect(evidence.editBakes).toBe(1);
    expect(evidence.frameP95).toBeLessThanOrEqual(33);
    expect(evidence.motionFrameP95).toBeLessThanOrEqual(33);
    expect(evidence.refinedDifferent).toBe(0);
    expect(evidence.originals).toBe(0); expect(evidence.disposed).toBe(0);
  });
}
