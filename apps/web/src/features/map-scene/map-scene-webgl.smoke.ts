import { expect, test } from "@playwright/test";

for (const width of [1024, 320]) test(`common map compact worker, draft holes and context recovery at ${width}px`, async ({ page }, testInfo) => {
  await page.setViewportSize({ width, height: 480 });
  await page.goto("/src/features/cad-scene/cad-scene-webgl-smoke.html");
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  const result = await page.evaluate(async width => {
    const rendererPath = "/src/features/map-scene/MapSceneRenderer.ts";
    const goldenPath = "/src/features/cad-scene/cad-scene-codec.golden.ts";
    const backendPath = "/src/features/cad-scene/CadSceneRenderer.ts";
    const [{ MapSceneRenderer }, { cadSceneCodecGolden }, { PixiCadSceneRenderBackend }] = await Promise.all([
      import(/* @vite-ignore */ rendererPath), import(/* @vite-ignore */ goldenPath), import(/* @vite-ignore */ backendPath)
    ]);
    document.body.style.margin = "0";
    const canvas = document.createElement("canvas");
    canvas.style.width = `${width}px`; canvas.style.height = "320px";
    document.body.replaceChildren(canvas);
    const bytes = Uint8Array.from(atob(cadSceneCodecGolden.payloadBase64), value => value.charCodeAt(0));
    const sha256 = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))].map(value => value.toString(16).padStart(2, "0")).join("");
    const tile = { version: 1, sceneId: "common-display", tileX: 0, tileY: 0, part: 0, lod: 0,
      assetId: "display-tile", sha256, byteSize: bytes.length, primitiveCount: 7,
      bounds: { minX: 0, minY: 0, maxX: 512, maxY: 512 } };
    const ref = { formatVersion: 1, generationId: "common-generation", revision: 0, width: 1024, height: 1024,
      gridSize: 50, elementCount: 7, manifest: { assetId: "canonical-metadata", sha256, byteSize: 100, decodedByteSize: 100 } };
    const layers = ["WALLS", "DOORS", "ELECTRICAL", "LABELS"].map((name, order) => ({ id: `layer-${order}`, name, order, visible: true, locked: false }));
    let fetches = 0, lookups = 0;
    let captured = new Uint8Array();
    let restoreStarted = false;
    let restoredEventCompleted = false;
    let prematureRestoreRenders = 0;
    class RecordingBackend extends PixiCadSceneRenderBackend {
      render() {
        super.render();
        const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
        if (!gl || gl.isContextLost()) return;
        if (restoreStarted && !restoredEventCompleted) prematureRestoreRenders++;
        captured = new Uint8Array(canvas.width * canvas.height * 4);
        gl.finish(); gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, captured);
      }
    }
    const renderErrors: string[] = [];
    const renderer = new MapSceneRenderer({
      platform: width === 320 ? "mobile" : "desktop", devicePixelRatio: 1,
      backendFactory: () => new RecordingBackend(),
      onError: (error: Error) => renderErrors.push(error.message),
      source: {
        scopeKey: "smoke:floor:user",
        getChanges: async (document: typeof ref) => ({ generationId: document.generationId, revision: document.revision, operations: [], nextCursor: null }),
        getManifest: async (document: typeof ref) => ({ generationId: document.generationId, revision: document.revision,
          canonical: document.manifest, groups: [{ id: "golden-group", parentId: null, name: "Group", visible: true, locked: false }], layers,
          displayLayerBindings: layers.map(layer => ({ layerName: layer.name, layerId: layer.id })),
          display: { version: 1, sceneId: tile.sceneId, regionId: "region", manifestAssetId: "derived-metadata",
            width: 1024, height: 1024, padding: 0, gridSize: 50, tileSize: 512, lodMode: "additive", primitiveCount: 7,
            tileCount: 1, byteSize: bytes.length, sha256, sourceBounds: tile.bounds,
            transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }, tiles: [tile] } }),
        loadDisplayTile: async () => { fetches++; return bytes; },
        getElements: async () => { lookups++; return [{ id: "line-golden", type: "line",
          geometry: { start: { x: 1, y: 2 }, end: { x: 11, y: 12 } },
          transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
          groupId: null, layerId: "layer-0", zIndex: 0, locked: false, visible: true,
          style: { strokeColor: "#123456", fillColor: null, strokeWidth: 1.5, opacity: 0.75 }, provenance: null }]; }
      }
    });
    const camera = { centerX: 256, centerY: 160, zoom: Math.min(1, width / 512), viewportWidth: width, viewportHeight: 320 };
    await renderer.mount(canvas); await renderer.setDocument(ref); renderer.setCamera(camera);
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) throw new Error("WebGL is required");
    const pixel = (x: number, y: number) => {
      const sx = Math.round((x - camera.centerX) * camera.zoom + width / 2);
      const sy = Math.round((y - camera.centerY) * camera.zoom + 160);
      const offset = ((canvas.height - sy - 1) * canvas.width + sx) * 4;
      return [...captured.slice(offset, offset + 4)];
    };
    const waitFor = async (condition: () => boolean, stage = "overview") => {
      for (let i = 0; i < 300; i++) { await new Promise<void>(resolve => requestAnimationFrame(() => resolve())); if (condition()) return; }
      throw new Error(`GPU condition timed out (${stage}): ${renderErrors.join(",")}; source=${pixel(30, 25)}; draft=${pixel(110, 110)}; contextLost=${gl.isContextLost()}; prematureRestoreRenders=${prematureRestoreRenders}`);
    };
    // Inspect a known filled source triangle, not merely any nonblank pixel.
    await waitFor(() => pixel(30, 25)[3] > 20);
    const overviewLookups = lookups;
    const screen = (x: number, y: number) => ({ x: (x - camera.centerX) * camera.zoom + width / 2, y: (y - camera.centerY) * camera.zoom + 160 });
    const picked = await renderer.pick(screen(6, 7));
    // Element IDs and group IDs may legally collide in a common document.
    const draft = { id: "golden-group", type: "polygon", geometry: {
      outer: [{ x: 100, y: 100 }, { x: 180, y: 100 }, { x: 180, y: 180 }, { x: 100, y: 180 }],
      holes: [[{ x: 120, y: 120 }, { x: 120, y: 160 }, { x: 160, y: 160 }, { x: 160, y: 120 }]] },
      transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
      groupId: null, layerId: "layer-0", zIndex: 0, locked: false, visible: true, provenance: null,
      style: { fillColor: "#00ff00", strokeColor: null, strokeWidth: 0, opacity: 1 } };
    renderer.applyChanges([{ kind: "add", element: draft }], []);
    await waitFor(() => pixel(110, 110)[1] > 200 && pixel(30, 25)[3] > 20, "add colliding element");
    const holeAlpha = pixel(140, 140)[3];
    const localPick = await renderer.pick(screen(110, 110));
    renderer.setCamera({ ...camera, centerX: camera.centerX + 100 });
    const beforeFramePick = renderer.pick(screen(110, 110));
    renderer.setCamera(camera);
    const beforeFrameId = (await beforeFramePick)?.element.id;
    const group = { id: "golden-group", parentId: null, name: "Group", visible: false, locked: false };
    renderer.applyChanges([{ kind: "group.put", group }], []);
    await waitFor(() => pixel(110, 110)[1] > 200 && pixel(30, 25)[3] === 0, "hide colliding group");
    renderer.applyChanges([{ kind: "group.put", group: { ...group, visible: true } }], []);
    await waitFor(() => pixel(110, 110)[1] > 200 && pixel(30, 25)[3] > 20, "show colliding group");
    await renderer.setDocument({ ...ref, revision: 1 });
    renderer.setCamera({ ...camera, zoom: camera.zoom * 1.1 });
    renderer.setCamera(camera);
    const extension = gl.getExtension("WEBGL_lose_context");
    if (!extension) throw new Error("Context loss extension is required");
    const lost = new Promise<void>(resolve => canvas.addEventListener("webglcontextlost", () => resolve(), { once: true }));
    extension.loseContext(); await lost;
    captured = new Uint8Array();
    // Chromium's extension refuses synchronous restoration in the loss event.
    await new Promise(resolve => setTimeout(resolve, 50));
    restoreStarted = true;
    const restore = new Promise<void>(resolve => canvas.addEventListener("webglcontextrestored", () => { restoredEventCompleted = true; resolve(); }, { once: true }));
    extension.restoreContext(); await restore;
    await waitFor(() => pixel(110, 110)[1] > 200 && pixel(30, 25)[3] > 20, "restore context");
    const memoryBytes = renderer.memoryBytes;
    renderer.applyChanges([{ kind: "delete", id: draft.id }], []);
    await waitFor(() => pixel(110, 110)[3] === 0 && pixel(30, 25)[3] > 20, "delete colliding element");
    const sourceStillVisible = pixel(30, 25)[3] > 20;
    renderer.dispose();
    return { overviewLookups, picked: picked?.element.id, localPick: localPick?.element.id, beforeFrameId, holeAlpha,
      fetches, lookups, memoryBytes, afterDispose: renderer.memoryBytes, sourceStillVisible, prematureRestoreRenders, renderErrors };
  }, width);
  expect(result).toMatchObject({ overviewLookups: 0, picked: "line-golden", localPick: "golden-group", beforeFrameId: "golden-group", holeAlpha: 0,
    fetches: 1, lookups: 1, afterDispose: 0, sourceStillVisible: true, prematureRestoreRenders: 0, renderErrors: [] });
  expect(result.memoryBytes).toBeLessThanOrEqual((width === 320 ? 32 : 128) * 1024 * 1024);
  expect(errors).toEqual([]);
  await testInfo.attach("common-map-gpu-evidence", { body: JSON.stringify(result, null, 2), contentType: "application/json" });
});
