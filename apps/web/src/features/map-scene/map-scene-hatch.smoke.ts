import { expect, test } from "@playwright/test";
import type { MapElement, Point } from "@led-control/shared/map-document-contracts";
import { buildCadScene, type CadSemanticEntity } from "../../../../api/src/floor-import/cad-scene-builder";
import { createCadMapElementConverter } from "../../../../api/src/floor-import/map-element-converter";
import { decodeMapDisplayTile } from "../../../../api/src/floor-import/cad-scene-codec";

const square = (x: number, y: number, side: number): Point[] => [
  { x, y }, { x: x + side, y }, { x: x + side, y: y + side }, { x, y: y + side }
];

const envelope = process.env.MAP_SCENE_HATCH_ENVELOPE === "1";
const probes = envelope
  ? [1, 30].flatMap(strokeWidth => [1, 2].map(dpr => ({ holes: 2, dpr, strokeWidth, zoom: 0.001 })))
  : [0, 1, 2].flatMap(holes => [1, 2].map(dpr => ({ holes, dpr, strokeWidth: 30, zoom: undefined })));

for (const { holes, dpr, strokeWidth, zoom } of probes) {
  test(`source HATCH compound contour ${holes} holes across cells at DPR ${dpr}${envelope ? ` min zoom ${zoom} stroke ${strokeWidth}` : ""}`, async ({ page }, testInfo) => {
    const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const rings = [square(10, 10, 60), ...[square(20, 20, 20), square(50, 50, 10)].slice(0, holes)];
    const entity = { type: "hatch", sourceEntityId: "hatch-pixel", layer: "FILL", hatchStyle: 0,
      loops: rings.map(vertices => ({ type: "polyline", flags: 2, closed: true,
        vertices: vertices.map(point => ({ ...point, z: 0, bulge: 0 })) }))
    } as CadSemanticEntity["source"]["entity"];
    const converter = createCadMapElementConverter({ importJobId: "hatch-pixel", regionBounds: bounds });
    const canonical: MapElement[] = [];
    const scene = buildCadScene({ version: 1, bounds, blocks: [], entities: [entity] },
      { regionId: "hatch-pixel", bounds, primitiveCount: 2, textCount: 0, lightCandidateCount: 0, area: 10000 },
      { sceneId: "11111111-1111-4111-8111-111111111111", displayVersion: 2, onSemanticEntity: value => {
        const elements = converter.convertSemanticEntity(value).map(element => ({ ...element,
          style: { fillColor: "#ff0000", strokeColor: "#00ff00", strokeWidth, opacity: 0.5 } }));
        canonical.push(...elements); return elements;
      } });
    expect(canonical).toHaveLength(1);
    expect(scene.manifest.orderedPages).toEqual({ version: 1 });
    expect(canonical[0].type === "polygon" && canonical[0].geometry.holes.length).toBe(holes);
    const primitives = scene.tiles.flatMap(tile => decodeMapDisplayTile(tile.payload, tile.descriptor));
    expect(primitives.filter(p => p.style.fillColor !== null).every(p => p.type === "polyline" && p.geometry.closed)).toBe(true);
    if (holes) expect(primitives.filter(p => p.style.fillColor !== null).every(p => p.style.strokeColor === null)).toBe(true);
    const layerNames = [...new Set(primitives.map(p => p.layerName))];
    const payloads = new Map(scene.tiles.map(tile => [tile.descriptor.assetId, tile.payload]));
    await page.route("**/hatch-tiles/*", route => route.fulfill({ contentType: "application/octet-stream",
      body: payloads.get(new URL(route.request().url()).pathname.split("/").at(-1)!)! }));
    await page.goto("/src/features/map-scene/map-scene-raster-smoke.html");
    const evidence = await page.evaluate(async ({ manifest, canonical, layerNames, dpr, zoom }) => {
      const rendererPath = "/src/features/map-scene/MapSceneRenderer.ts", backendPath = "/src/features/map-scene/map-raster-backend.ts";
      const { MapSceneRenderer } = await import(/* @vite-ignore */ rendererPath);
      const { MapRasterBackend } = await import(/* @vite-ignore */ backendPath);
      const originalDisplay = MapRasterBackend.prototype.renderDisplay;
      let completion = Promise.resolve();
      MapRasterBackend.prototype.renderDisplay = function(...args: unknown[]) { return completion = originalDisplay.apply(this, args); };
      const canvas = document.createElement("canvas"); canvas.style.width = "320px"; canvas.style.height = "320px";
      document.body.replaceChildren(canvas);
      const getContext = canvas.getContext.bind(canvas);
      canvas.getContext = ((kind: string, options?: object) => getContext(kind as "webgl2", { ...options, preserveDrawingBuffer: true })) as typeof canvas.getContext;
      const errors: string[] = [], layers = [{ id: canonical[0].layerId, name: "Hatch", order: 0, visible: true, locked: false }];
      const ref = { formatVersion: 1, generationId: manifest.sceneId, revision: 0, width: manifest.width, height: manifest.height,
        gridSize: 50, elementCount: 1, manifest: { assetId: "canonical", sha256: "a".repeat(64), byteSize: 100, decodedByteSize: 100 } };
      let loads = 0;
      const renderer = new MapSceneRenderer({ devicePixelRatio: dpr, onError: (error: Error) => errors.push(error.message), source: {
        scopeKey: "hatch-pixel", getElements: async () => canonical,
        getChanges: async () => ({ generationId: ref.generationId, revision: 0, operations: [], nextCursor: null }),
        loadDisplayTile: async (tile: { assetId: string }) => { loads++; return new Uint8Array(await (await fetch(`/hatch-tiles/${tile.assetId}`)).arrayBuffer()); },
        getManifest: async () => ({ generationId: ref.generationId, revision: 0, canonical: ref.manifest, groups: [], layers,
          displayLayerBindings: layerNames.map(layerName => ({ layerName, layerId: layers[0].id })), display: manifest })
      } });
      const camera = { centerX: manifest.width / 2, centerY: manifest.height / 2, zoom: zoom ?? 320 / manifest.width,
        viewportWidth: 320, viewportHeight: 320 };
      const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      await renderer.mount(canvas); await renderer.setDocument(ref); renderer.setCamera(camera);
      await frame(); await frame(); await frame(); await completion; await frame();
      const reference = document.createElement("canvas"); reference.width = canvas.width; reference.height = canvas.height;
      const context = reference.getContext("2d")!;
      const paintReference = () => {
        context.setTransform(1, 0, 0, 1, 0, 0); context.clearRect(0, 0, canvas.width, canvas.height);
        context.scale(canvas.width / 320, canvas.height / 320);
        context.translate(160 - camera.centerX * camera.zoom, 160 - camera.centerY * camera.zoom); context.scale(camera.zoom, camera.zoom);
        // Independent canonical-ring oracle: no display contour, codec path,
        // renderer painter, or area-only assertion is used for expected pixels.
        for (const element of canonical) {
          if (element.type !== "polygon") throw new Error("Expected canonical polygon");
          context.save(); const t = element.transform;
          context.translate(t.x, t.y); context.rotate(t.rotation * Math.PI / 180); context.scale(t.scaleX, t.scaleY);
          context.beginPath();
          for (const ring of [element.geometry.outer, ...element.geometry.holes]) {
            context.moveTo(ring[0].x, ring[0].y); for (const p of ring.slice(1)) context.lineTo(p.x, p.y); context.closePath();
          }
          context.globalAlpha = element.style.opacity; context.fillStyle = element.style.fillColor!; context.fill("evenodd");
          context.strokeStyle = element.style.strokeColor!; context.lineWidth = Math.max(element.style.strokeWidth, 0.5 / camera.zoom); context.stroke();
          context.restore();
        }
        const expected = context.getImageData(0, 0, canvas.width, canvas.height).data;
        const gl = canvas.getContext("webgl2")!, actual = new Uint8Array(expected.length);
        gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, actual);
        let different = 0, covered = 0, holeLeaks = 0, missingStroke = 0;
        const samples: unknown[] = [];
        for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
          const e = (y * canvas.width + x) * 4, a = ((canvas.height - 1 - y) * canvas.width + x) * 4;
          if (expected[e + 3]) covered++;
          if (!expected[e + 3] && actual[a + 3] > 3) holeLeaks++;
          // Green is exclusively the canonical boundary stroke. A fully
          // absent stroke is a coverage bug, not tolerable edge antialiasing.
          if (expected[e + 1] * expected[e + 3] / 255 > 8 && actual[a + 1] === 0) missingStroke++;
          if ([0, 1, 2, 3].some(c => Math.abs(actual[a + c] - (c === 3 ? expected[e + c] : expected[e + c] * expected[e + 3] / 255)) > 3)) {
            different++; if (samples.length < 12) samples.push({ x, y, actual: [...actual.slice(a, a + 4)], expected: [...expected.slice(e, e + 4)] });
          }
        }
        return { different, covered, holeLeaks, missingStroke, pixels: canvas.width * canvas.height, samples };
      };
      const overview = paintReference();
      camera.centerX += 0.25 / camera.zoom; camera.zoom *= 1.3; renderer.setCamera(camera);
      await frame(); await frame(); await completion; await frame();
      const zoomed = paintReference();
      renderer.dispose(); MapRasterBackend.prototype.renderDisplay = originalDisplay;
      return { overview, zoomed, errors, loads, tiles: manifest.tileCount, disposed: renderer.memoryBytes };
    }, { manifest: scene.manifest, canonical, layerNames, dpr, zoom });
    await testInfo.attach("hatch-coverage", { body: JSON.stringify({ holes, dpr, strokeWidth, zoom, ...evidence }), contentType: "application/json" });
    expect(evidence.errors).toEqual([]); expect(evidence.loads).toBeGreaterThanOrEqual(evidence.tiles);
    for (const stage of [evidence.overview, evidence.zoomed]) {
      expect(stage.covered).toBeGreaterThan(envelope ? 0 : 15000);
      expect(stage.different / stage.pixels).toBeLessThan(0.005);
      expect(stage.holeLeaks).toBe(0);
      expect(stage.missingStroke).toBe(0);
    }
    expect(evidence.disposed).toBe(0);
  });
}
