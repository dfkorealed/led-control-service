import { createHash } from "node:crypto";
import { expect, test } from "@playwright/test";
import { encodeMapDisplayTile, decodeMapDisplayTile } from "../../../../api/src/floor-import/cad-scene-codec";
import { createMapDisplayPageWriter } from "../../../../api/src/floor-import/map-display-page-writer";
import { compareMapDisplayFragmentKeys, type MapDisplayTile } from "@led-control/shared/map-display-contracts";
import { buildMapDisplay } from "../../../../api/src/floor-editor/map-display-builder";
import type { MapElement } from "@led-control/shared/map-document-contracts";

for (const dpr of [1, 2]) test(`canonical painter coverage across cells and draft z at DPR ${dpr}`, async ({ page }, testInfo) => {
  const shapes: Array<{ id: string; layer: string; z: number; color: string; opacity: number; x: number; y: number; width: number; height: number; text?: string; fragment?: number; line?: boolean; hole?: boolean }> = [
    { id: "red", layer: "a", z: 0, color: "#ff0000", opacity: 0.6, x: 480, y: 30, width: 100, height: 90 },
    { id: "blue", layer: "a", z: 3, color: "#0000ff", opacity: 0.5, x: 490, y: 40, width: 100, height: 90 },
    { id: "text", layer: "a", z: 1, color: "#ffffff", opacity: 0.7, x: 506, y: 62, width: 80, height: 36, text: "IIIIWWW" },
    { id: "fragment-owner", layer: "a", z: 4, color: "#ff0000", opacity: 0.5, x: 475, y: 150, width: 80, height: 20, fragment: 0 },
    { id: "fragment-owner", layer: "a", z: 4, color: "#0000ff", opacity: 0.5, x: 485, y: 150, width: 80, height: 20, fragment: 1 },
    { id: "yellow", layer: "b", z: -10, color: "#ffff00", opacity: 0.25, x: 500, y: 50, width: 100, height: 90 },
    { id: "cyan", layer: "c", z: -20, color: "#00ffff", opacity: 0.2, x: 505, y: 55, width: 100, height: 90 },
    { id: "hole", layer: "b", z: 10, color: "#ff00ff", opacity: 0.5, x: 490, y: 135, width: 80, height: 45, hole: true }
  ];
  // Deliberately interleave the z ranges of separate server parts.
  let tiles = [1, 0].flatMap(tileX => shapes.filter(shape => shape.fragment !== undefined).map((shape, part) => {
    const bounds = { minX: tileX * 512, minY: 0, maxX: (tileX + 1) * 512, maxY: 512 };
    const base = { elementId: shape.id, groupId: null,
      layerName: shape.layer, sourceType: "CANONICAL", zIndex: shape.z, fragmentOrder: shape.fragment ?? 0,
      bounds: { minX: Math.max(bounds.minX, shape.x), minY: shape.y,
        maxX: Math.min(bounds.maxX, shape.x + shape.width), maxY: shape.y + shape.height }, clipBounds: bounds,
      style: { fillColor: shape.color, strokeColor: null, strokeWidth: 0, opacity: shape.opacity } };
    const bytes = encodeMapDisplayTile(shape.text ? [{ ...base, type: "text", geometry: {
      position: { x: shape.x, y: shape.y + shape.height }, width: shape.width, height: shape.height, rotation: 0, fontSize: 32, text: shape.text
    } }] : shape.fragment !== undefined ? [{ ...base, type: "rectangle", geometry: {
      origin: { x: shape.x, y: shape.y }, width: shape.width, height: shape.height, rotation: 0
    } }] : [
      { ...base, sourceType: "rectangle", type: "triangle", fragmentOrder: 0, geometry: { points: [
        { x: shape.x, y: shape.y }, { x: shape.x + shape.width, y: shape.y }, { x: shape.x + shape.width, y: shape.y + shape.height }
      ] } },
      { ...base, sourceType: "rectangle", type: "triangle", fragmentOrder: 1, geometry: { points: [
        { x: shape.x, y: shape.y }, { x: shape.x + shape.width, y: shape.y + shape.height }, { x: shape.x, y: shape.y + shape.height }
      ] } }
    ]);
    return { descriptor: { version: 2, sceneId: "order", assetId: `${tileX}-${part}`, tileX, tileY: 0, lod: 0, part,
      bounds, primitiveCount: shape.text || shape.fragment !== undefined ? 1 : 2, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") },
    base64: bytes.toString("base64") };
  }));
  const nativeShapes = shapes.filter(shape => shape.fragment === undefined);
  await buildMapDisplay({ formatVersion: 1, generationId: "11111111-1111-4111-8111-111111111111", revision: 0,
    width: 1024, height: 512, gridSize: 50, elementCount: nativeShapes.length,
    manifest: { assetId: "22222222-2222-4222-8222-222222222222", sha256: "a".repeat(64), byteSize: 100, decodedByteSize: 100 }
  }, (async function* () {
    for (const shape of nativeShapes) yield {
      id: shape.id, layerId: shape.layer, zIndex: shape.z, groupId: null, visible: true, locked: false, provenance: null,
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      style: { fillColor: shape.color, strokeColor: null, strokeWidth: 0, opacity: shape.opacity },
      ...(shape.text ? { type: "text", geometry: { position: { x: shape.x, y: shape.y }, width: shape.width,
        height: shape.height, fontSize: 32, text: shape.text } } : shape.hole ? { type: "polygon", geometry: {
          outer: [{ x: shape.x, y: shape.y }, { x: shape.x + shape.width, y: shape.y },
            { x: shape.x + shape.width, y: shape.y + shape.height }, { x: shape.x, y: shape.y + shape.height }],
          holes: [[{ x: shape.x + 10, y: shape.y + 10 }, { x: shape.x + shape.width - 10, y: shape.y + 10 },
            { x: shape.x + shape.width - 10, y: shape.y + shape.height - 10 }, { x: shape.x + 10, y: shape.y + shape.height - 10 }]]
        } } : { type: "rectangle", geometry: {
        origin: { x: shape.x, y: shape.y }, width: shape.width, height: shape.height
      } })
    } as MapElement;
  })(), async tile => { tiles.push({ descriptor: tile.descriptor, base64: tile.payload.toString("base64") }); });
  // Repack the small mixed native/custom fragment oracle with the real public
  // ordered-page writer. No consumer-inferred ordering metadata is used.
  const writer = createMapDisplayPageWriter({ sceneId: "order", width: 1024, height: 512 });
  const records = tiles.flatMap(tile => decodeMapDisplayTile(Buffer.from(tile.base64, "base64"), tile.descriptor as MapDisplayTile)
    .map((primitive, index) => ({ primitive, tile: tile.descriptor, group: (tile.descriptor as MapDisplayTile).pages
      ?.find(page => index >= page.primitiveStart && index < page.primitiveStart + page.primitiveCount)?.paintGroup?.id })));
  records.sort((a, b) => (a.primitive.layerName < b.primitive.layerName ? -1 : a.primitive.layerName > b.primitive.layerName ? 1 : 0) ||
    compareMapDisplayFragmentKeys(a.primitive, b.primitive));
  for (const record of records) writer.append({ tileX: record.tile.tileX, tileY: record.tile.tileY, lod: record.tile.lod as 0 | 1 | 2 },
    record.primitive, record.primitive.layerName, record.group);
  tiles = [...writer.finish()].map(tile => ({ descriptor: tile.descriptor, base64: tile.payload.toString("base64") }));
  await page.goto("/src/features/map-scene/map-scene-raster-smoke.html");
  const evidence = await page.evaluate(async ({ tiles, shapes, dpr }) => {
    const path = "/src/features/map-scene/MapSceneRenderer.ts";
    const { MapSceneRenderer } = await import(/* @vite-ignore */ path);
    const backendPath = "/src/features/map-scene/map-raster-backend.ts";
    const { MapRasterBackend } = await import(/* @vite-ignore */ backendPath);
    const parent = Object.getPrototypeOf(MapRasterBackend.prototype), originalRaster = parent.replaceRaster;
    const rasters = new Map<string, { canvas: HTMLCanvasElement; bounds: { minX: number; minY: number; maxX: number; maxY: number } }>();
    parent.replaceRaster = function(key: string, canvas: HTMLCanvasElement, bounds: { minX: number; minY: number; maxX: number; maxY: number }) {
      rasters.set(key, { canvas, bounds }); return originalRaster.call(this, key, canvas, bounds);
    };
    const canvas = document.createElement("canvas");
    canvas.style.width = "256px"; canvas.style.height = "192px"; document.body.replaceChildren(canvas);
    // Inspection only: preserve the completed framebuffer without changing production rendering.
    const original = canvas.getContext.bind(canvas);
    canvas.getContext = ((kind: string, options: object) => original(kind as "webgl2", { ...options, preserveDrawingBuffer: true })) as typeof canvas.getContext;
    const errors: string[] = [];
    const ref = { formatVersion: 1, generationId: "g", revision: 0, width: 1024, height: 512, gridSize: 50,
      elementCount: shapes.length, manifest: { assetId: "canonical", sha256: "a".repeat(64), byteSize: 100, decodedByteSize: 100 } };
    const layers = ["a", "b", "c"].map((id, order) => ({ id, name: id, order, visible: true, locked: false }));
    const renderer = new MapSceneRenderer({ devicePixelRatio: dpr, onError: (error: Error) => errors.push(error.message),
      source: { scopeKey: "ordered-test", getElements: async () => [],
        getChanges: async () => ({ generationId: "g", revision: 0, operations: [], nextCursor: null }),
        loadDisplayTile: async (tile: { assetId: string }) => Uint8Array.from(atob(tiles.find(value => value.descriptor.assetId === tile.assetId)!.base64), value => value.charCodeAt(0)),
        getManifest: async () => ({ generationId: "g", revision: 0, canonical: ref.manifest, groups: [], layers,
          displayLayerBindings: layers.map(layer => ({ layerName: layer.id, layerId: layer.id })),
          display: { version: 2, orderedPages: { version: 1 }, sceneId: "order", regionId: "native", manifestAssetId: "display", width: 1024, height: 512,
            padding: 0, gridSize: 50, tileSize: 512, lodMode: "additive", tileCount: tiles.length, primitiveCount: tiles.length,
            byteSize: 100, sha256: "b".repeat(64), sourceBounds: { minX: 0, minY: 0, maxX: 1024, maxY: 512 },
            transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }, tiles: tiles.map(value => value.descriptor) } }) } });
    const camera = { centerX: 512, centerY: 96, zoom: 1, viewportWidth: 256, viewportHeight: 192 };
    await renderer.mount(canvas); await renderer.setDocument(ref); renderer.setCamera(camera);
    const settle = async () => { for (let i = 0; i < 30; i++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); };
    await settle();
    // Canonical vector paths are the oracle, independent of display fragments.
    // fillRect's special fractional-AA fast path is retained as a diagnostic,
    // not mixed with path fills in the primary compositing comparison.
    const compare = (values: typeof shapes, orders = layers.map(layer => layer.id), pathReference = true) => {
      const reference = document.createElement("canvas"); reference.width = canvas.width; reference.height = canvas.height;
      const ctx = reference.getContext("2d")!; ctx.scale(canvas.width / 256, canvas.height / 192);
      ctx.translate(128 - camera.centerX * camera.zoom, 96 - camera.centerY * camera.zoom); ctx.scale(camera.zoom, camera.zoom);
      const sorted = [...values].sort((a, b) => orders.indexOf(a.layer) - orders.indexOf(b.layer) || a.z - b.z ||
        (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) || (a.fragment ?? 0) - (b.fragment ?? 0));
      for (const shape of sorted) {
        ctx.globalAlpha = shape.opacity; ctx.fillStyle = shape.color;
        if (shape.line) {
          ctx.beginPath(); ctx.moveTo(shape.x, shape.y); ctx.lineTo(shape.x + shape.width, shape.y + shape.height);
          ctx.lineWidth = 10; ctx.strokeStyle = shape.color; ctx.stroke();
        } else if (shape.text) {
          ctx.save(); ctx.font = "32px sans-serif"; ctx.textBaseline = "top";
          const run = Math.max(1, ctx.measureText(shape.text).width);
          ctx.translate(shape.x, shape.y); ctx.scale(shape.width / (Math.ceil(run) + 4), shape.height / 36);
          ctx.fillText(shape.text, 2, 2); ctx.restore();
        } else if (shape.hole) {
          ctx.beginPath(); ctx.rect(shape.x, shape.y, shape.width, shape.height);
          ctx.rect(shape.x + 10, shape.y + 10, shape.width - 20, shape.height - 20); ctx.fill("evenodd");
        } else if (pathReference) {
          ctx.beginPath(); ctx.rect(shape.x, shape.y, shape.width, shape.height); ctx.fill();
        } else ctx.fillRect(shape.x, shape.y, shape.width, shape.height);
      }
      const expected = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      const gl = canvas.getContext("webgl2")!; const actual = new Uint8Array(expected.length);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, actual);
      let different = 0, covered = 0;
      const samples: unknown[] = [];
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const a = ((canvas.height - 1 - y) * canvas.width + x) * 4, e = (y * canvas.width + x) * 4;
        if (expected[e + 3]) covered++;
        // WebGL stores premultiplied RGB; ImageData exposes straight RGB.
        if ([0, 1, 2, 3].some(c => Math.abs(actual[a + c] - (c === 3 ? expected[e + c] : expected[e + c] * expected[e + 3] / 255)) > 3)) {
          different++;
          if (samples.length < 12) {
            const wx = ((x + 0.5) / (canvas.width / 256) - 128) / camera.zoom + camera.centerX;
            const wy = ((y + 0.5) / (canvas.height / 192) - 96) / camera.zoom + camera.centerY;
            const r = [...rasters.values()].find(r => r.canvas.width && wx >= r.bounds.minX && wx < r.bounds.maxX && wy >= r.bounds.minY && wy < r.bounds.maxY);
            const cpu = r && [...r.canvas.getContext("2d")!.getImageData(Math.floor((wx - r.bounds.minX) / (r.bounds.maxX - r.bounds.minX) * r.canvas.width),
              Math.floor((wy - r.bounds.minY) / (r.bounds.maxY - r.bounds.minY) * r.canvas.height), 1, 1).data];
            samples.push({ x, y, actual: [...actual.slice(a, a + 4)], expected: [...expected.slice(e, e + 4)], cpu });
          }
        }
      }
      return { different, covered, pixels: canvas.width * canvas.height, samples };
    };
    const base = compare(shapes);
    const draft = { id: "green", layer: "a", z: 2, color: "#00ff00", opacity: 0.4, x: 485, y: 35, width: 100, height: 90 };
    const stroke = { id: "edge", layer: "a", z: 10, color: "#ff00ff", opacity: 0.4, x: 512, y: 20, width: 0, height: 140, line: true };
    renderer.applyChanges([{ kind: "add", element: { id: draft.id, layerId: draft.layer, zIndex: draft.z,
      type: "rectangle", geometry: { origin: { x: draft.x, y: draft.y }, width: draft.width, height: draft.height },
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, style: { fillColor: draft.color, strokeColor: null, strokeWidth: 0, opacity: draft.opacity },
      groupId: null, visible: true, locked: false, provenance: null } }, { kind: "add", element: {
        id: stroke.id, layerId: stroke.layer, zIndex: stroke.z, type: "line",
        geometry: { start: { x: 512, y: 20 }, end: { x: 512, y: 160 } },
        transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
        style: { fillColor: null, strokeColor: stroke.color, strokeWidth: 10, opacity: stroke.opacity },
        groupId: null, visible: true, locked: false, provenance: null
      } }], []);
    const values = [...shapes, draft, stroke];
    await settle(); const between = compare(values);
    renderer.applyChanges([{ kind: "layer.put", layer: { ...layers[0], order: 5 } }], []);
    await settle(); const reordered = compare(values, ["b", "c", "a"]);
    camera.centerX += 0.25; camera.zoom = 0.75; renderer.setCamera(camera); await settle();
    const fractional = compare(values, ["b", "c", "a"]);
    const fractionalFillRectDiagnostic = compare(values, ["b", "c", "a"], false);
    const gl = canvas.getContext("webgl2")!, extension = gl.getExtension("WEBGL_lose_context")!;
    const lost = new Promise<void>(resolve => canvas.addEventListener("webglcontextlost", () => resolve(), { once: true }));
    extension.loseContext(); await lost;
    // The extension disallows restoration within the context-loss dispatch.
    await new Promise<void>(resolve => setTimeout(resolve, 50));
    const recovered = new Promise<void>(resolve => canvas.addEventListener("webglcontextrestored", () => resolve(), { once: true }));
    extension.restoreContext(); await recovered; await settle();
    const restored = compare(values, ["b", "c", "a"]);
    const memory = renderer.memoryBytes; renderer.dispose();
    parent.replaceRaster = originalRaster;
    return { base, between, reordered, fractional, fractionalFillRectDiagnostic, restored, errors, memory, disposed: renderer.memoryBytes };
  }, { tiles, shapes, dpr });
  await testInfo.attach("ordered-coverage", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
  expect(evidence.errors).toEqual([]);
  for (const stage of [evidence.base, evidence.between, evidence.reordered, evidence.fractional, evidence.restored]) {
    expect(stage.covered).toBeGreaterThan(5000);
    expect(stage.different / stage.pixels).toBeLessThan(0.0005);
  }
  expect(evidence.disposed).toBe(0);
});
