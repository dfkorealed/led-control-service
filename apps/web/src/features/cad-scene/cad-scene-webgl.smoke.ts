import { expect, test } from "@playwright/test";

test("renders, pans, and recovers a real Pixi WebGL CAD scene", async ({ page }) => {
  await page.goto("/src/features/cad-scene/cad-scene-webgl-smoke.html");

  const result = await page.evaluate(async () => {
    document.body.replaceChildren();
    const rendererPath = "/src/features/cad-scene/CadSceneRenderer.ts";
    const workerPath = "/src/features/cad-scene/cad-scene-worker.ts";
    const [{ CadSceneRenderer, PixiCadSceneRenderBackend }, { buildCadGeometryBatches }] = await Promise.all([
      import(/* @vite-ignore */ rendererPath),
      import(/* @vite-ignore */ workerPath)
    ]);
    const canvas = document.createElement("canvas");
    canvas.style.width = "128px";
    canvas.style.height = "128px";
    document.body.append(canvas);
    const descriptor = {
      version: 1,
      sceneId: "11111111-1111-4111-8111-111111111111",
      tileX: 0,
      tileY: 0,
      lod: 0,
      part: 0,
      assetId: "33333333-3333-4333-8333-333333333333",
      primitiveCount: 1,
      byteSize: 1,
      sha256: "0".repeat(64),
      bounds: { minX: 0, minY: 0, maxX: 512, maxY: 512 }
    };
    const primitive = {
      elementId: "fill-1",
      groupId: null,
      layerName: "WALLS",
      sourceType: "LWPOLYLINE",
      bounds: { minX: 16, minY: 16, maxX: 112, maxY: 112 },
      clipBounds: null,
      style: { strokeColor: null, fillColor: "#00ff00", strokeWidth: 0, opacity: 1 },
      type: "rectangle",
      geometry: { origin: { x: 16, y: 16 }, width: 96, height: 96, rotation: 0 }
    };
    const textPrimitive = {
      elementId: "text-1",
      groupId: null,
      layerName: "LABELS",
      sourceType: "TEXT",
      bounds: { minX: 24, minY: 72, maxX: 104, maxY: 104 },
      clipBounds: null,
      style: { strokeColor: "#ffffff", fillColor: null, strokeWidth: 1, opacity: 1 },
      type: "text",
      geometry: {
        position: { x: 24, y: 104 },
        text: "GPU",
        width: 80,
        height: 32,
        rotation: 0,
        fontSize: 24
      }
    };
    const decoded = {
      ...buildCadGeometryBatches([primitive, textPrimitive]),
      descriptor,
      byteSize: 1
    };
    const manifest = {
      version: 1,
      sceneId: descriptor.sceneId,
      regionId: "smoke",
      manifestAssetId: "22222222-2222-4222-8222-222222222222",
      width: 512,
      height: 512,
      padding: 0,
      gridSize: 50,
      tileSize: 512,
      lodMode: "additive",
      primitiveCount: 1,
      tileCount: 1,
      byteSize: 1,
      sha256: "0".repeat(64),
      sourceBounds: descriptor.bounds,
      transform: { scaleX: 1, scaleY: -1, translateX: 0, translateY: 512 },
      tiles: [descriptor]
    };
    const worker = { decode: async () => decoded, destroy: () => undefined };
    const renderer = new CadSceneRenderer({
      manifest,
      loadTile: async () => new Uint8Array([1]),
      worker,
      devicePixelRatio: 1
    });
    const camera = {
      centerX: 64,
      centerY: 64,
      zoom: 1,
      viewportWidth: 128,
      viewportHeight: 128
    };
    await renderer.mount(canvas);
    await renderer.setCamera(camera);
    const gl = canvas.getContext("webgl2") ?? canvas.getContext("webgl");
    if (!gl) throw new Error("WebGL context unavailable");
    const countVisiblePixels = () => {
      gl.finish();
      const pixels = new Uint8Array(canvas.width * canvas.height * 4);
      gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      let count = 0;
      for (let offset = 3; offset < pixels.length; offset += 4) {
        if (pixels[offset] > 0) count++;
      }
      return count;
    };
    const initialPixels = countVisiblePixels();
    await renderer.setCamera({ ...camera, centerX: 65 });
    const pannedPixels = countVisiblePixels();

    let recoveredPixels: number | null = null;
    let restoreEventReceived: boolean | null = null;
    const extension = gl.getExtension("WEBGL_lose_context");
    if (extension) {
      const lost = new Promise<void>(resolve => canvas.addEventListener("webglcontextlost", () => resolve(), {
        once: true
      }));
      extension.loseContext();
      await lost;
      await new Promise(resolve => setTimeout(resolve, 50));
      const restored = new Promise<void>(resolve => canvas.addEventListener("webglcontextrestored", () => resolve(), {
        once: true
      }));
      extension.restoreContext();
      restoreEventReceived = await Promise.race([
        restored.then(() => true),
        new Promise<false>(resolve => setTimeout(() => resolve(false), 2_000))
      ]);
      if (restoreEventReceived) {
        await new Promise(resolve => setTimeout(resolve, 100));
        await renderer.setCamera({ ...camera, centerX: 66 });
        recoveredPixels = countVisiblePixels();
      }
    }
    renderer.destroy();

    const resourceCanvas = document.createElement("canvas");
    resourceCanvas.width = 128;
    resourceCanvas.height = 128;
    document.body.append(resourceCanvas);
    const resourceBackend = new PixiCadSceneRenderBackend();
    await resourceBackend.mount(resourceCanvas, { resolution: 1 });
    resourceBackend.setCamera(camera);
    resourceBackend.replaceTile("resource-release", decoded, new Set());
    resourceBackend.render();
    const resourceGl = resourceCanvas.getContext("webgl2") ?? resourceCanvas.getContext("webgl");
    if (!resourceGl) throw new Error("Resource-test WebGL context unavailable");
    let deletedBuffers = 0;
    let deletedTextures = 0;
    const originalDeleteBuffer = resourceGl.deleteBuffer.bind(resourceGl);
    const originalDeleteTexture = resourceGl.deleteTexture.bind(resourceGl);
    Object.defineProperties(resourceGl, {
      deleteBuffer: {
        configurable: true,
        value: (buffer: WebGLBuffer | null) => {
          if (buffer) deletedBuffers++;
          originalDeleteBuffer(buffer);
        }
      },
      deleteTexture: {
        configurable: true,
        value: (texture: WebGLTexture | null) => {
          if (texture) deletedTextures++;
          originalDeleteTexture(texture);
        }
      }
    });
    resourceBackend.destroy();
    return {
      initialPixels,
      pannedPixels,
      recoveredPixels,
      restoreEventReceived,
      deletedBuffers,
      deletedTextures
    };
  });

  expect(result.initialPixels).toBeGreaterThan(0);
  expect(result.pannedPixels).toBeGreaterThan(0);
  if (result.restoreEventReceived !== null) expect(result.restoreEventReceived).toBe(true);
  if (result.recoveredPixels !== null) expect(result.recoveredPixels).toBeGreaterThan(0);
  expect(result.deletedBuffers).toBeGreaterThan(0);
  expect(result.deletedTextures).toBeGreaterThan(0);
});
