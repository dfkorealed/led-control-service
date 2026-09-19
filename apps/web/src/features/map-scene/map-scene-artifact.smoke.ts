import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { expect, test } from "@playwright/test";
import { mapDisplayManifestSchema } from "@led-control/shared/map-display-contracts";
import { getMapElementBounds } from "@led-control/shared/map-document-geometry";
import { readCanonicalElements, readCanonicalMetadata, readVerifiedCadArtifact,
  type CadCanonicalArtifact } from "../../../../api/src/floor-import/cad-canonical-spool";
import { readCadDisplayTileIndex } from "../../../../api/src/floor-import/cad-display-tile-spool";

// Opt-in only: the producer owns creating/auditing these artifacts. This test
// neither starts CAD jobs nor changes their outputs or the user's database.
const resultsPath = process.env.MAP_SCENE_ARTIFACT_RESULTS;
const diagnosticSample = process.env.MAP_SCENE_ARTIFACT_DIAGNOSTIC_SAMPLE;
type ArtifactResults = { sourceBefore: { head: string }; sourceStable: boolean; samples: Array<{
  directory: string; passed: boolean; originalUnchanged?: boolean; originalBefore?: unknown; originalAfter?: unknown;
  stages: Array<{ name: string; canonical?: CadCanonicalArtifact }>;
}> };

for (const sampleIndex of diagnosticSample === undefined ? [0, 1] : [Number(diagnosticSample)]) for (const platform of ["desktop", "mobile"] as const) {
  test(`${diagnosticSample === undefined ? "actual" : "diagnostic"} artifact ${sampleIndex + 1} overview and canonical pick on ${platform}`, async ({ page }, testInfo) => {
    test.setTimeout(240_000);
    if (!resultsPath) throw new Error("Set MAP_SCENE_ARTIFACT_RESULTS to the approved producer results.json");
    const results = JSON.parse(await readFile(resultsPath, "utf8")) as ArtifactResults;
    const sample = results.samples[sampleIndex];
    expect(sample?.passed).toBe(true);
    if (diagnosticSample === undefined) expect(results.sourceStable).toBe(true);
    else {
      // Main authorized the completed first artifact for protocol diagnosis
      // while the second timed out. Its whole-run CODE snapshot is absent;
      // never manufacture that final gate or label this as both-original PASS.
      expect(sample.originalUnchanged).toBe(true);
      expect(sample.originalBefore).toBeDefined(); expect(sample.originalAfter).toEqual(sample.originalBefore);
    }
    const artifact = sample.stages.find(stage => stage.name === "verify-canonical-display")?.canonical;
    if (!artifact) throw new Error("Verified canonical artifact descriptor is missing");
    const metadata = await readCanonicalMetadata(sample.directory, artifact);
    let display;
    for (const filename of await readdir(sample.directory)) {
      if (!filename.endsWith(".json")) continue;
      const bytes = await readFile(join(sample.directory, filename));
      const value = JSON.parse(bytes.toString("utf8"));
      if (value.version === 2 && value.tiles && value.sceneId) {
        display = mapDisplayManifestSchema.parse({ ...value, byteSize: bytes.length,
          sha256: createHash("sha256").update(bytes).digest("hex") });
        break;
      }
    }
    if (!display) throw new Error("Actual public v2 display manifest is missing");
    const tileIndex = await readCadDisplayTileIndex(sample.directory, artifact.displayTiles, display);
    const descriptors = new Map(display.tiles.map(tile => [tile.assetId, tile]));
    const canonical = { assetId: artifact.metadata.filename.replace(/\.json$/, ""), byteSize: artifact.metadata.byteSize,
      decodedByteSize: artifact.metadata.byteSize, sha256: artifact.metadata.sha256 };
    const ref = { formatVersion: 1 as const, generationId: display.sceneId, revision: 0,
      width: metadata.width, height: metadata.height, gridSize: metadata.gridSize,
      elementCount: metadata.elementCount, manifest: canonical };
    const manifest = { generationId: ref.generationId, revision: 0, canonical, display,
      groups: metadata.groups, layers: metadata.layers, displayLayerBindings: metadata.displayLayerBindings };
    let pickPoint: { x: number; y: number } | undefined;
    // Only one canonical probe is retained; the rest remains in framed spool.
    for await (const element of readCanonicalElements(sample.directory, artifact)) {
      if (element.type !== "line" || !element.visible || !metadata.layers.some(layer => layer.id === element.layerId && layer.visible)) continue;
      const bounds = getMapElementBounds(element);
      if (Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) < 2) continue;
      pickPoint = { x: (bounds.minX + bounds.maxX) / 2, y: (bounds.minY + bounds.maxY) / 2 };
      if (pickPoint.x <= 0 || pickPoint.y <= 0 || pickPoint.x >= ref.width || pickPoint.y >= ref.height) { pickPoint = undefined; continue; }
      break;
    }
    if (!pickPoint) throw new Error("No visible canonical line for a real pick probe");

    let tileRequests = 0, canonicalRequests = 0, maxInflatedBytes = 0, inFlight = 0, maxInFlight = 0;
    let tileDrain = Promise.resolve();
    const routeErrors: string[] = [];
    await page.route("**/api/floors/artifact/map-document**", async route => {
      try {
        const path = new URL(route.request().url()).pathname;
        if (path.endsWith("/map-document")) return await route.fulfill({ json: ref });
        if (path.endsWith("/manifest")) return await route.fulfill({ json: manifest });
        if (path.endsWith("/changes")) return await route.fulfill({ json: {
          generationId: ref.generationId, revision: 0, operations: [], nextCursor: null } });
        if (path.endsWith("/elements")) {
          canonicalRequests++;
          const ids = new Set<string>(route.request().postDataJSON().ids);
          if (ids.size > 128) throw new Error("Unbounded canonical lookup");
          const elements = [];
          for await (const element of readCanonicalElements(sample.directory, artifact)) {
            if (ids.delete(element.id)) elements.push(element);
            if (!ids.size) break;
          }
          return await route.fulfill({ json: elements });
        }
        const tile = descriptors.get(path.split("/").at(-1)!);
        if (!tile) throw new Error(`Unknown artifact request: ${path}`);
        const previous = tileDrain;
        let release!: () => void;
        tileDrain = new Promise<void>(resolve => { release = resolve; });
        await previous;
        tileRequests++; maxInFlight = Math.max(maxInFlight, ++inFlight);
        try {
          // No tile preload, whole-map buffer, or browser geometry arrays. One
          // requested compressed artifact is verified/inflated and then released.
          const entry = tileIndex?.get(tile.assetId);
          const file = entry ?? { filename: `${tile.assetId}.bin`, byteSize: tile.byteSize, sha256: tile.sha256 };
          const encoded = await readVerifiedCadArtifact(sample.directory, {
            filename: file.filename, byteSize: file.byteSize, sha256: file.sha256 }, 16 * 1024 * 1024);
          const bytes = entry ? gunzipSync(encoded, { maxOutputLength: tile.byteSize }) : encoded;
          if (bytes.length !== tile.byteSize || createHash("sha256").update(bytes).digest("hex") !== tile.sha256) {
            throw new Error("Actual artifact raw tile integrity mismatch");
          }
          maxInflatedBytes = Math.max(maxInflatedBytes, bytes.length);
          await route.fulfill({ body: bytes, contentType: "application/octet-stream" });
        } finally { inFlight--; release(); }
      } catch (error) {
        routeErrors.push(String(error)); await route.fulfill({ status: 500, json: { message: String(error) } });
      }
    });
    await page.goto("/src/features/map-scene/map-scene-raster-smoke.html");
    const evidence = await page.evaluate(async ({ platform, pickPoint }) => {
      const providerPath = "/src/api/map-document.ts", rendererPath = "/src/features/map-scene/MapSceneRenderer.ts";
      const backendPath = "/src/features/map-scene/map-raster-backend.ts", workerPath = "/src/features/cad-scene/cad-scene-worker.ts";
      const windowPath = "/src/features/map-scene/map-paint-window.ts", budgetPath = "/src/features/cad-scene/cad-scene-memory-budget.ts";
      const [{ createMapDocumentSource }, { MapSceneRenderer }, { MapRasterBackend }, { createCadSceneWorkerClient },
        { MapPaintWindow }, { CadSceneMemoryBudget }] = await Promise.all([
        import(/* @vite-ignore */ providerPath), import(/* @vite-ignore */ rendererPath),
        import(/* @vite-ignore */ backendPath), import(/* @vite-ignore */ workerPath),
        import(/* @vite-ignore */ windowPath), import(/* @vite-ignore */ budgetPath)
      ]);
      const width = platform === "desktop" ? 1024 : 390, height = platform === "desktop" ? 768 : 640;
      const canvas = document.createElement("canvas"); canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
      document.body.replaceChildren(canvas);
      const getContext = canvas.getContext.bind(canvas);
      canvas.getContext = ((kind: string, options?: object) => getContext(kind as "webgl2", {
        ...options, preserveDrawingBuffer: true })) as typeof canvas.getContext;
      const source = createMapDocumentSource({ floorId: "artifact", authScope: "artifact-probe" });
      const signal = new AbortController().signal, ref = await source.getDocument(signal);
      if (!ref) throw new Error("Artifact document is missing");
      const manifest = await source.getManifest(ref, signal);
      const expectedFragments = manifest.display.tiles.reduce((sum: number, tile: { primitiveCount: number }) => sum + tile.primitiveCount, 0);
      const decodedTiles = new Set<string>(), decodedPages = new Set<string>(), bakedCells = new Set<string>();
      let decodedFragments = 0, completion = Promise.resolve(), peak = 0, monitor = true;
      let lastTile: unknown, failedReservation: unknown;
      const errors: string[] = [], degraded: unknown[] = [], worker = createCadSceneWorkerClient();
      const renderDisplay = MapRasterBackend.prototype.renderDisplay;
      const reserve = MapRasterBackend.prototype.reserve;
      const pageRead = MapPaintWindow.prototype.read, budgetReserve = CadSceneMemoryBudget.prototype.reserve;
      MapPaintWindow.prototype.read = async function(tile: { assetId: string }, descriptor: { primitiveStart: number; primitiveCount: number }, index: number) {
        lastTile = tile;
        const value = await pageRead.call(this, tile, descriptor, index), key = `${tile.assetId}:${descriptor.primitiveStart}`;
        decodedTiles.add(tile.assetId);
        if (!decodedPages.has(key)) { decodedPages.add(key); decodedFragments += descriptor.primitiveCount; }
        return value;
      };
      CadSceneMemoryBudget.prototype.reserve = function(owner: string, key: string, bytes: number, evict?: unknown) {
        const before = this.totalBytes, result = budgetReserve.call(this, owner, key, bytes, evict);
        peak = Math.max(peak, this.totalBytes);
        if (!result) failedReservation = { owner, key, bytes, totalBefore: before, lastTile };
        return result;
      };
      const proto = Object.getPrototypeOf(MapRasterBackend.prototype), replaceRaster = proto.replaceRaster;
      MapRasterBackend.prototype.renderDisplay = function(...args: unknown[]) { return completion = renderDisplay.apply(this, args); };
      MapRasterBackend.prototype.reserve = function(owner: string, key: string, bytes: number) {
        try { const result = reserve.call(this, owner, key, bytes); peak = Math.max(peak, this.budget.totalBytes); return result; }
        catch (error) { failedReservation = { owner, key, bytes, totalBefore: this.budget.totalBytes, lastTile }; throw error; }
      };
      proto.replaceRaster = function(key: string, ...args: unknown[]) { bakedCells.add(key); return replaceRaster.call(this, key, ...args); };
      const renderer = new MapSceneRenderer({ platform, devicePixelRatio: 1, source: { ...source,
        decodeDisplayTile: async (...args: unknown[]) => {
          const tile = args[1] as { assetId: string; tileX: number; tileY: number; primitiveCount: number; byteSize: number };
          lastTile = tile;
          const value = await worker.decode(...args);
          if (value.nativePrimitives && !decodedTiles.has(tile.assetId)) {
            decodedTiles.add(tile.assetId); decodedFragments += value.nativePrimitives.length;
          }
          return value;
        } }, onError: (error: Error) => errors.push(error.message), onDegraded: (value: unknown) => degraded.push(value) });
      const sampleMemory = () => { peak = Math.max(peak, renderer.memoryBytes); if (monitor) requestAnimationFrame(sampleMemory); };
      sampleMemory();
      const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      const settle = async () => { await frame(); await frame(); await completion; await frame(); await frame(); };
      const camera = { centerX: ref.width / 2, centerY: ref.height / 2,
        zoom: Math.min(width / ref.width, height / ref.height) * 0.96, viewportWidth: width, viewportHeight: height };
      let overview: unknown, navigation: unknown, picked: unknown, failure: string | undefined, overviewPng: string | undefined;
      try {
        const start = performance.now(); await renderer.mount(canvas); renderer.setCamera(camera); await renderer.setDocument(ref); await settle();
        const gl = canvas.getContext("webgl2")!, pixels = new Uint8Array(canvas.width * canvas.height * 4);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
        let visiblePixels = 0; for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) visiblePixels++;
        overview = { ms: performance.now() - start, decodedTiles: decodedTiles.size, decodedFragments,
          expectedTiles: manifest.display.tiles.length, expectedFragments, bakedCells: bakedCells.size,
          visiblePixels, retained: renderer.memoryBytes };
        overviewPng = canvas.toDataURL("image/png");
        if (!errors.length && !degraded.length) {
          renderer.setCamera({ ...camera, centerX: camera.centerX + 0.37 / camera.zoom, zoom: camera.zoom * 1.25 });
          await settle(); navigation = { retained: renderer.memoryBytes, errors: [...errors] };
          renderer.setCamera({ ...camera, centerX: pickPoint.x, centerY: pickPoint.y, zoom: Math.max(camera.zoom, 1) });
          await settle();
          const hit = await renderer.pick({ x: width / 2, y: height / 2 }, { radiusPixels: 2 });
          picked = hit ? { id: hit.element.id, type: hit.element.type, provenance: hit.element.provenance } : null;
        }
      } catch (error) { failure = String(error); }
      finally {
        monitor = false; renderer.dispose(); worker.destroy();
        MapRasterBackend.prototype.renderDisplay = renderDisplay; MapRasterBackend.prototype.reserve = reserve;
        MapPaintWindow.prototype.read = pageRead; CadSceneMemoryBudget.prototype.reserve = budgetReserve;
        proto.replaceRaster = replaceRaster;
      }
      return { overview, overviewPng, navigation, picked, failure, errors, degraded, peak, lastTile, failedReservation, disposed: renderer.memoryBytes };
    }, { platform, pickPoint });
    const { overviewPng, ...measurements } = evidence;
    if (overviewPng) await testInfo.attach("actual-artifact-overview", {
      body: Buffer.from(overviewPng.split(",")[1], "base64"), contentType: "image/png" });
    await testInfo.attach("actual-artifact-coverage", { body: JSON.stringify({ producer: results.sourceBefore.head,
      diagnosticOnly: diagnosticSample !== undefined, sourceStable: results.sourceStable ?? null,
      sampleIndex, platform, directory: sample.directory, tileRequests, canonicalRequests, maxInflatedBytes, maxInFlight, routeErrors, ...measurements }),
    contentType: "application/json" });
    expect(routeErrors).toEqual([]); expect(evidence.failure).toBeUndefined();
    expect(evidence.errors).toEqual([]); expect(evidence.degraded).toEqual([]);
    const overview = evidence.overview as { decodedTiles: number; expectedTiles: number; decodedFragments: number;
      expectedFragments: number; visiblePixels: number };
    expect(overview.decodedTiles).toBe(overview.expectedTiles);
    expect(overview.decodedFragments).toBe(overview.expectedFragments);
    expect(overview.visiblePixels).toBeGreaterThan(0);
    expect(evidence.picked).toBeTruthy(); expect(canonicalRequests).toBeGreaterThan(0);
    expect(maxInFlight).toBe(1);
    expect(evidence.peak).toBeLessThanOrEqual((platform === "mobile" ? 32 : 128) * 1024 * 1024);
    expect(evidence.disposed).toBe(0);
  });
}
