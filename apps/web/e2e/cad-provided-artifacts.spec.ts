import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, delimiter, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { buildCadSceneDescriptor, cadSceneEditInputSchema, cadSceneManifestSchema, type CadElementOverride, type CadSceneEditInput } from "@led-control/shared";
import { installSettingsApiRoutes } from "./support/settings-api";
import { computeVisibleTileCoordinates, selectCadSceneLods } from "../src/features/cad-scene/cad-scene-camera";
import { buildCadGeometryBatches, decodeCadSceneTilePayload } from "../src/features/cad-scene/cad-scene-worker";

// Opt-in: CAD_ARTIFACT_DIRS contains path-delimited completed core output dirs.
// Only the application shell is mocked. Manifest geometry and binary tiles are
// read unchanged from provided-file artifacts; no backend or user DB is used.
const directories = process.env.CAD_ARTIFACT_DIRS?.split(delimiter).filter(Boolean) ?? [];
const evidenceDirectory = resolve(import.meta.dirname, "../../../.local/cad-native-qa");
test.use({ actionTimeout: 10_000 });

for (const [index, directory] of (directories.length ? directories : [""]).entries()) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    test(`provided CAD ${index + 1} editor and monitor ${viewport.width}`, async ({ page }, testInfo) => {
      test.skip(!directory, "Set CAD_ARTIFACT_DIRS to completed provided-file core outputs");
      test.setTimeout(300_000);
      const mobilePolicy = viewport.width === 390;
      const profile = mobilePolicy ? "Chromium mobile-policy" : "Chromium desktop-policy";
      const profileSuffix = mobilePolicy ? "-mobile-policy" : "";
      await page.setViewportSize(viewport);
      if (mobilePolicy) {
        await page.addInitScript(() => {
          // Match createMobileWebViewBootstrapScript in apps/mobile/src/WebShell:
          // it supplies both policy and lifecycle state; omitting active
          // intentionally suspends the read-only renderer before it mounts.
          const nativeWindow = window as Window & {
            __LED_CONTROL_MOBILE_WEBVIEW__?: boolean;
            __LED_CONTROL_NATIVE_APP_STATE__?: string;
          };
          nativeWindow.__LED_CONTROL_MOBILE_WEBVIEW__ = true;
          nativeWindow.__LED_CONTROL_NATIVE_APP_STATE__ = "active";
          const setDataset = () => {
            document.documentElement.dataset.ledControlMobileWebview = "true";
            document.documentElement.dataset.ledControlNativeAppState = "active";
          };
          // Playwright init scripts can run before the parser creates <html>.
          if (document.documentElement) setDataset();
          else document.addEventListener("DOMContentLoaded", setDataset, { once: true });
        });
      }
      await installRendererProbe(page);
      const artifact = await loadArtifact(directory);
      const errors: string[] = [];
      const workers: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      page.on("worker", worker => workers.push(worker.url()));
      const requests = await installArtifactRoutes(page, artifact);
      const session = await page.context().newCDPSession(page);
      await session.send("Performance.enable");
      const measurements: unknown[] = [];
      try {
        for (const mode of ["editor", "monitor"] as const) {
          requests.loaded.clear();
          requests.bytes = 0;
          const startedAt = Date.now();
          await page.goto(mode === "editor" ? "/settings/floor-plans/floor-1/edit?siteId=site-1" : "/monitoring?siteId=site-1");
          if (mode === "editor") {
            await expect(page.getByRole("heading", { name: "B2 맵 편집" })).toBeVisible();
            await page.getByRole("button", { name: "맵 맞춤", exact: true }).click();
            await page.getByText("격자 스냅", { exact: true }).click();
            await expect(page.getByRole("checkbox", { name: "격자 스냅" })).not.toBeChecked();
            await page.getByTestId("floor-editor-canvas").evaluate(element => element.scrollIntoView({ block: "center" }));
          } else {
            await page.getByRole("region", { name: "층 도면" }).evaluate(element => element.scrollIntoView({ block: "center" }));
          }
          const canvas = page.getByTestId("cad-scene-canvas");
          await expect(canvas).toBeVisible({ timeout: 30_000 });
          await expect.poll(() => requests.loaded.size, { timeout: 30_000 }).toBeGreaterThan(0);
          let settled = true;
          try {
            await expect.poll(() => requests.active === 0 && Date.now() - requests.lastTileAt > 2000,
              { timeout: 120_000, message: "tile request count unchanged for two seconds" }).toBe(true);
          } catch { settled = false; }
          const settledMs = Date.now() - startedAt;
          expect.soft(settled, `${mode}: requests settle within the 120-second observation ceiling`).toBe(true);
          await expect(page.getByRole("alert")).toHaveCount(0);
          const pixels = await nativePixelContribution(page);
          expect(pixels.changedPixels).toBeGreaterThan(100);
          const readyAndProofMs = Date.now() - startedAt;
          const { metrics } = await session.send("Performance.getMetrics");
          const canvasSize = await canvas.evaluate((element: HTMLCanvasElement) => ({
            width: element.width, height: element.height,
            cssWidth: element.getBoundingClientRect().width, cssHeight: element.getBoundingClientRect().height,
            webgl: Boolean(element.getContext("webgl2") ?? element.getContext("webgl"))
          }));
          expect(canvasSize.webgl).toBe(true);
          const loaded = [...requests.loaded.values()];
          const camera = await currentCamera(page, mode, artifact.manifest);
          const cells = new Set(computeVisibleTileCoordinates(artifact.manifest, camera, 1).map(cell => `${cell.tileX}:${cell.tileY}`));
          const lods = selectCadSceneLods(camera.zoom, "display");
          const expected = artifact.manifest.tiles.filter(tile => lods.includes(tile.lod) && cells.has(`${tile.tileX}:${tile.tileY}`));
          const loadedIds = new Set(loaded.map(tile => tile.assetId));
          const missing = expected.filter(tile => !loadedIds.has(tile.assetId));
          const rendering = await rendererSnapshot(page);
          const renderedKeys = new Set(rendering?.activeTileKeys ?? []);
          const notRendered = expected.filter(tile => !renderedKeys.has(`${tile.sceneId}:${tile.lod}:${tile.tileX}:${tile.tileY}:${tile.part}`));
          const name = `provided-${index + 1}-${mode}-${viewport.width}${profileSuffix}`;
          const path = resolve(evidenceDirectory, `${name}.png`);
          await page.screenshot({ path });
          await testInfo.attach(name, { path, contentType: "image/png" });
          const decoded = { cpuBytes: 0, gpuBytes: 0, textAtlasBytes: 0 };
          // Offline estimates use the same decoder/geometry builder, not a
          // guessed expansion factor. They are totals requested, not residency.
          for (const tile of loaded) {
            const primitives = await decodeCadSceneTilePayload(await readFile(resolve(directory, `${tile.assetId}.bin`)), tile);
            const memory = buildCadGeometryBatches(primitives).memory;
            decoded.cpuBytes += memory.cpuBytes;
            decoded.gpuBytes += memory.gpuBytes;
            decoded.textAtlasBytes += memory.textAtlasBytes;
          }
          const measurement = {
            mode, settled, settledMs, exceeded30SecondBudget: settledMs > 30_000,
            readyAndProofMs, loadedTileParts: loaded.length, servedTileBytes: requests.bytes,
            camera, expectedVisibleTileParts: expected.length, missingExpectedTileParts: missing.length,
            rendering, missingRenderedTileParts: notRendered.length,
            expectedTileBounds: tileBounds(expected), requestedTileBounds: tileBounds(loaded),
            expectedRepresentation: "display: all additive source LOD partitions",
            requestedExactDecodedEstimates: decoded,
            loadedPrimitiveFragments: loaded.reduce((sum, tile) => sum + tile.primitiveCount, 0),
            loadedPartsByLod: Object.fromEntries([0, 1, 2].map(lod => [lod, loaded.filter(tile => tile.lod === lod).length])),
            pixels, canvasSize,
            pageJsHeapUsedBytes: metrics.find(metric => metric.name === "JSHeapUsedSize")?.value,
            canvasRgbaBytes: canvasSize.width * canvasSize.height * 4
          };
          measurements.push(measurement);
          console.log("provided CAD renderer", JSON.stringify({ artifact: index + 1, viewport, profile,
            ...measurement, rendering: rendering ? { ...rendering, activeTileKeys: undefined } : null }));
          expect.soft(rendering?.aggregateMaximumBytes, `${mode}: configured aggregate renderer budget`)
            .toBe((mobilePolicy || mode === "editor" ? 32 : 128) * 1024 * 1024);
          expect.soft(missing.length, `${mode}: missing expected visible LOD tile parts after settling`).toBe(0);
          expect.soft(notRendered.length, `${mode}: expected tiles must be rendered, not merely fetched`).toBe(0);
        }
        expect(errors).toEqual([]);
        expect(requests.mutations).toEqual([]);
        expect(workers.length).toBeGreaterThan(0);
      } finally {
        await session.detach();
        const evidencePath = resolve(evidenceDirectory, `provided-${index + 1}-${viewport.width}${profileSuffix}-evidence.json`);
        await mkdir(evidenceDirectory, { recursive: true });
        await writeFile(evidencePath, JSON.stringify({
            directory, viewport, profile, mobileWebViewPolicy: mobilePolicy,
            sceneId: artifact.manifest.sceneId, regionId: artifact.manifest.regionId,
            manifestSha256: artifact.manifest.sha256, mapWidth: artifact.manifest.width, mapHeight: artifact.manifest.height,
            sourceBounds: artifact.manifest.sourceBounds, manifestTileBounds: tileBounds(artifact.manifest.tiles),
            lod0TileParts: artifact.manifest.tiles.filter(tile => tile.lod === 0).length,
            manifestPrimitives: artifact.manifest.primitiveCount, manifestTileParts: artifact.manifest.tileCount,
            measurements, errors, workerCount: workers.length,
            finalRequestCounts: { loaded: requests.loaded.size, active: requests.active, servedTileBytes: requests.bytes,
              byLod: Object.fromEntries([0, 1, 2].map(lod => [lod, [...requests.loaded.values()].filter(tile => tile.lod === lod).length])) },
            scope: "Provided-file core artifacts in real Chromium editor/monitor; mocked shell/API only. Page JS heap excludes worker/GPU memory; canvas RGBA bytes are one-buffer arithmetic, not GPU allocation. Timings include settling/pixel proof. No accuracy percentage, backend persistence, FPS or physical-mobile claim."
          }, null, 2));
        await testInfo.attach("provided-artifact-evidence.json", { path: evidencePath, contentType: "application/json" });
      }
    });
  }
}

test("provided CAD native line edit persists through route-fixture reload", async ({ page }, testInfo) => {
  const directory = directories.at(-1);
  test.skip(!directory, "Set CAD_ARTIFACT_DIRS to completed provided-file core outputs");
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await installRendererProbe(page);
  const artifact = await loadArtifact(directory!);
  const target = await findNativeLine(artifact);
  const requests = await installArtifactRoutes(page, artifact, true);
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  const canvas = page.getByTestId("floor-editor-canvas");
  const properties = page.getByRole("complementary", { name: "CAD 요소 속성" });
  const strokeColor = "#12e6b7";
  const proofs: unknown[] = [];
  for (const reloaded of [false, true]) {
    if (reloaded) await page.reload({ waitUntil: "domcontentloaded" });
    else await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
    await expect(page.getByRole("heading", { name: "B2 맵 편집" })).toBeVisible();
    await page.getByRole("button", { name: "맵 맞춤", exact: true }).click();
    if (await page.getByRole("checkbox", { name: "격자 스냅" }).isChecked()) {
      await page.getByText("격자 스냅", { exact: true }).click();
    }
    await canvas.evaluate(element => element.scrollIntoView({ block: "center" }));
    await zoomToNativeLine(page, target.point);
    await expect.poll(() => requests.active === 0 && Date.now() - requests.lastTileAt > 2000,
      { timeout: 30_000 }).toBe(true);
    await expect(properties).toHaveCount(0);
    if (reloaded) {
      // No Konva selection overlay is present: the persisted color must come
      // from the actual native renderer, not merely the editor's edit preview.
      const pixels = await nativeStrokePixels(page, target.point, [18, 230, 183]);
      expect(pixels).toBeGreaterThan(5);
      const path = resolve(evidenceDirectory, "provided-native-line-after-reload.png");
      await page.screenshot({ path });
      await testInfo.attach("provided-native-line-after-reload", { path, contentType: "image/png" });
      proofs.push({ reloaded, nativeColorPixels: pixels });
    }
    // This actual source line has no group: single click must open properties.
    await canvas.click({ position: await editorPosition(page, target.point) });
    await expect(properties).toContainText(target.primitive.elementId, { timeout: 15_000 });
    if (reloaded) {
      await expect(properties.getByLabel("선 색상")).toHaveValue(strokeColor);
      break;
    }
    const path = resolve(evidenceDirectory, "provided-native-line-selected.png");
    await page.screenshot({ path });
    await testInfo.attach("provided-native-line-selected", { path, contentType: "image/png" });
    await properties.getByLabel("선 색상").fill(strokeColor);
    await properties.getByLabel("선 두께").fill("6");
    await properties.getByRole("button", { name: "CAD 속성 적용" }).click();
    await expect.poll(() => requests.cadEdits.length).toBe(1);
    expect(requests.cadEdits[0]).toMatchObject({ expectedRevision: 7,
      overrideMutations: [{ operation: "upsert", value: { elementId: target.primitive.elementId, strokeColor, strokeWidth: 6 } }]
    });
    await expect(properties.getByRole("button", { name: "CAD 속성 적용" })).toBeEnabled();
  }
  const bytes = await readFile(resolve(directory!, `${target.tile.assetId}.bin`));
  const sourceSha256 = createHash("sha256").update(bytes).digest("hex");
  expect(sourceSha256).toBe(target.tile.sha256);
  const source = (await decodeCadSceneTilePayload(bytes, target.tile)).find(primitive => primitive.elementId === target.primitive.elementId);
  expect(source).toEqual(target.primitive);
  expect(errors).toEqual([]);
  const evidencePath = resolve(evidenceDirectory, "provided-native-line-edit-evidence.json");
  await writeFile(evidencePath, JSON.stringify({ directory, sceneId: artifact.manifest.sceneId,
    target, sourceSha256, saved: requests.cadEdits, proofs, errors,
    scope: "Actual immutable CAD tile; real Chromium native selection/edit/render; persistence is in-memory API routing, not a real backend or user DB."
  }, null, 2));
  await testInfo.attach("provided-native-line-edit-evidence", { path: evidencePath, contentType: "application/json" });
});

async function findNativeLine(artifact: Awaited<ReturnType<typeof loadArtifact>>) {
  const { manifest, directory } = artifact;
  const distance = (tile: typeof manifest.tiles[number]) => Math.hypot(
    (tile.bounds.minX + tile.bounds.maxX - manifest.width) / 2,
    (tile.bounds.minY + tile.bounds.maxY - manifest.height) / 2
  );
  const tiles = manifest.tiles.filter(tile => tile.lod === 0).sort((left, right) => distance(left) - distance(right));
  for (const tile of tiles.slice(0, 30)) {
    const primitives = await decodeCadSceneTilePayload(await readFile(resolve(directory, `${tile.assetId}.bin`)), tile);
    for (const primitive of primitives) {
      if (primitive.type !== "line" || primitive.groupId !== null || !primitive.style.strokeColor || primitive.style.opacity === 0) continue;
      const { start, end } = primitive.geometry;
      if (Math.hypot(end.x - start.x, end.y - start.y) < 180) continue;
      return { tile, primitive, point: { x: (start.x + end.x) / 2, y: (start.y + end.y) / 2 } };
    }
  }
  throw new Error("No clear long native line found near the provided scene center");
}

async function editorPosition(page: Page, point: { x: number; y: number }) {
  return page.getByTestId("floor-editor-canvas").evaluate((element, point) => ({
    x: Number(element.dataset.panX) + point.x * Number(element.dataset.zoom),
    y: Number(element.dataset.panY) + point.y * Number(element.dataset.zoom)
  }), point);
}

async function zoomToNativeLine(page: Page, point: { x: number; y: number }) {
  const canvas = page.getByTestId("floor-editor-canvas");
  for (let attempt = 0; attempt < 40; attempt++) {
    const zoom = Number(await canvas.getAttribute("data-zoom"));
    if (zoom >= 0.5) return;
    const position = await editorPosition(page, point), box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + position.x, box.y + position.y);
    await page.mouse.wheel(0, -100);
    await expect.poll(async () => Number(await canvas.getAttribute("data-zoom"))).toBeGreaterThan(zoom);
  }
  throw new Error("Could not zoom to the native line through the editor wheel interaction");
}

async function nativeStrokePixels(page: Page, point: { x: number; y: number }, rgb: number[]) {
  let pixels = 0;
  await expect.poll(async () => {
    const position = await editorPosition(page, point);
    const screenshot = await page.getByTestId("cad-scene-canvas").screenshot({ scale: "css" });
    pixels = await page.evaluate(async ({ png, position, rgb }) => {
      const image = new Image(); image.src = `data:image/png;base64,${png}`; await image.decode();
      const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
      const context = canvas.getContext("2d")!; context.drawImage(image, 0, 0);
      const data = context.getImageData(Math.max(0, Math.floor(position.x) - 15), Math.max(0, Math.floor(position.y) - 15), 30, 30).data;
      let count = 0;
      for (let offset = 0; offset < data.length; offset += 4) {
        if (rgb.every((channel, index) => Math.abs(channel - data[offset + index]) < 30)) count++;
      }
      return count;
    }, { png: screenshot.toString("base64"), position, rgb });
    return pixels;
  }, { timeout: 15_000, message: "persisted native line color without selection overlay" }).toBeGreaterThan(5);
  return pixels;
}

async function installRendererProbe(page: Page) {
  // Test-only Vite instrumentation reads the real renderer's admission counters.
  // It does not replace rendering, mutate source files, or expose a product API.
  await page.route("**/src/features/cad-scene/CadSceneRenderer.ts*", async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}
const qaOriginalMount = CadSceneRenderer.prototype.mount;
CadSceneRenderer.prototype.mount = function(canvas) {
  const renderer = this, degraded = [];
  const originalDegraded = renderer.onDegraded;
  renderer.onDegraded = result => { degraded.push(result); originalDegraded(result); };
  (globalThis.__cadNativeQaProbes ??= []).push(() => canvas.isConnected && !renderer.destroyed ? {
    renderedTileCount: renderer.activeTileKeys.size,
    activeTileKeys: [...renderer.activeTileKeys],
    aggregateBytes: renderer.displayBudget.totalBytes,
    aggregateMaximumBytes: renderer.displayBudget.maximumBytes,
    displayTileCount: renderer.displayTiles.size,
    degraded
  } : null);
  return qaOriginalMount.call(this, canvas);
};
` });
  });
}

async function rendererSnapshot(page: Page) {
  return page.evaluate(() => {
    const probes = (globalThis as unknown as { __cadNativeQaProbes?: Array<() => {
      renderedTileCount: number; activeTileKeys: string[]; aggregateBytes: number;
      aggregateMaximumBytes: number; displayTileCount: number; degraded: unknown[];
    } | null> }).__cadNativeQaProbes ?? [];
    return probes.map(probe => probe()).find(Boolean) ?? null;
  });
}

function tileBounds(tiles: Array<{ bounds: { minX: number; minY: number; maxX: number; maxY: number } }>) {
  return {
    minX: Math.min(...tiles.map(tile => tile.bounds.minX)), minY: Math.min(...tiles.map(tile => tile.bounds.minY)),
    maxX: Math.max(...tiles.map(tile => tile.bounds.maxX)), maxY: Math.max(...tiles.map(tile => tile.bounds.maxY))
  };
}

async function currentCamera(page: Page, mode: "editor" | "monitor", size: { width: number; height: number }) {
  if (mode === "editor") return page.getByTestId("floor-editor-canvas").evaluate(element => {
    const box = element.getBoundingClientRect(), zoom = Number(element.dataset.zoom);
    return { centerX: (box.width / 2 - Number(element.dataset.panX)) / zoom,
      centerY: (box.height / 2 - Number(element.dataset.panY)) / zoom,
      zoom, viewportWidth: box.width, viewportHeight: box.height };
  });
  return page.locator("[data-floor-map-surface]").evaluate((surface, size) => {
    const box = surface.getBoundingClientRect();
    const viewport = surface.closest('[role="region"]')!.getBoundingClientRect();
    const contentLeft = box.left + surface.clientLeft, contentTop = box.top + surface.clientTop;
    const contentWidth = box.width - surface.clientLeft * 2, contentHeight = box.height - surface.clientTop * 2;
    const left = Math.max(viewport.left, contentLeft), top = Math.max(viewport.top, contentTop);
    const right = Math.min(viewport.right, contentLeft + contentWidth), bottom = Math.min(viewport.bottom, contentTop + contentHeight);
    const zoom = contentWidth / size.width;
    return { centerX: ((left + right) / 2 - contentLeft) / zoom, centerY: ((top + bottom) / 2 - contentTop) / zoom,
      zoom, viewportWidth: right - left, viewportHeight: bottom - top };
  }, size);
}

async function loadArtifact(directory: string) {
  const response = JSON.parse(await readFile(resolve(directory, "response.json"), "utf8"));
  expect(response.ok).toBe(true);
  const scene = response.result.scene;
  expect(basename(scene.manifestFilename)).toBe(scene.manifestFilename);
  const bytes = await readFile(resolve(directory, scene.manifestFilename));
  expect(bytes.length).toBe(scene.manifestByteSize);
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(scene.manifestSha256);
  // Production adds storage integrity metadata to the core manifest response.
  const manifest = cadSceneManifestSchema.parse({
    ...JSON.parse(bytes.toString("utf8")), byteSize: bytes.length, sha256: scene.manifestSha256
  });
  for (const tile of manifest.tiles) {
    expect((await stat(resolve(directory, `${tile.assetId}.bin`))).size).toBe(tile.byteSize);
  }
  const descriptor = buildCadSceneDescriptor("site-1", "floor-1", {
    id: manifest.sceneId, version: 1, sourceImportJobId: "00000000-0000-4000-8000-000000000001",
    ...manifest
  });
  return { directory, manifest, descriptor };
}

async function installArtifactRoutes(page: Page, artifact: Awaited<ReturnType<typeof loadArtifact>>, allowNativeEdit = false) {
  const { manifest, descriptor, directory } = artifact;
  const fixture = {
    id: "qa-unplaced", name: "QA unplaced fixture", x: 0, y: 0, size: 20, ratedWatt: 40,
    brightness: 0, status: "offline" as const, placementStatus: "unplaced" as const,
    health: null, rssi: null, hopCount: null, commandSuccessRate: null, lastSeenAt: null,
    gateway: null, controllable: false, controlBlockReason: "fixture_unmapped" as const
  };
  await installSettingsApiRoutes(page, "admin", { fixtures: [fixture], mapDimensions: manifest, mapObjects: [] });
  const floorPlan = {
    sourceType: "cad", imageUrl: null, originalFileUrl: null, renderedImageUrl: null,
    width: manifest.width, height: manifest.height, gridSize: manifest.gridSize, version: 1
  };
  const tiles = new Map(manifest.tiles.map(tile => [descriptor.tileContentPathTemplate
    .replace("{lod}", String(tile.lod)).replace("{tileX}", String(tile.tileX))
    .replace("{tileY}", String(tile.tileY)).replace("{part}", String(tile.part)), tile]));
  let revision = 7;
  const overrides: CadElementOverride[] = [];
  const requests = { loaded: new Map<string, typeof manifest.tiles[number]>(), bytes: 0, active: 0, lastTileAt: 0,
    mutations: [] as string[], cadEdits: [] as CadSceneEditInput[] };
  await page.route("**/api/**", async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname.replace(/^\/api/, "");
    if (allowNativeEdit && request.method() === "PUT" && path === descriptor.statePath) {
      const edit = cadSceneEditInputSchema.parse(request.postDataJSON());
      expect(edit.expectedRevision).toBe(revision);
      requests.cadEdits.push(edit);
      for (const mutation of edit.overrideMutations) {
        expect(mutation.operation).toBe("upsert");
        if (mutation.operation !== "upsert") continue;
        overrides.push({ hidden: false, transform: null, strokeColor: null, fillColor: null, strokeWidth: null,
          text: null, ...mutation.value, locator: mutation.locator });
      }
      revision++;
      return route.fulfill({ json: { revision, scene: descriptor, overrides, layers: [] } });
    }
    if (request.method() !== "GET" && !path.endsWith("/editor-lease")) {
      requests.mutations.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 405 });
    }
    if (path === descriptor.manifestContentPath) return route.fulfill({ json: manifest });
    if (path === descriptor.statePath) return route.fulfill({ json: { revision, scene: descriptor, overrides, layers: [] } });
    if (path === "/floors/floor-1/import-jobs/active") return route.fulfill({ json: { job: null } });
    if (path === "/floors/floor-1/import-jobs/applied-overlay") return route.fulfill({ json: { overlay: null } });
    const tile = tiles.get(path);
    if (tile) {
      requests.active++;
      try {
        const bytes = await readFile(resolve(directory, `${tile.assetId}.bin`));
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(tile.sha256);
        await route.fulfill({ contentType: "application/octet-stream", body: bytes });
        requests.loaded.set(path, tile);
        requests.bytes += bytes.length;
      } finally {
        requests.active--;
        requests.lastTileAt = Date.now();
      }
      return;
    }
    if (path === "/floors/floor-1/editor-state") return route.fulfill({ json: {
      floor: { id: "floor-1", siteId: "site-1", name: "B2", level: -2, mapRevision: revision, floorPlan, cadScene: descriptor },
      fixtures: [fixture], objects: [], lightSlots: []
    } });
    if (path === "/sites/site-1/floors/floor-1/map-snapshot") return route.fulfill({ json: {
      floorId: "floor-1", revision, width: manifest.width, height: manifest.height,
      floorPlan, cadScene: descriptor, objects: [], fixtures: []
    } });
    return route.fallback();
  });
  return requests;
}

async function nativePixelContribution(page: Page) {
  const canvas = page.getByTestId("cad-scene-canvas");
  let result = { changedPixels: 0, comparedPixels: 0 };
  await expect.poll(async () => {
    const visible = await canvas.screenshot({ scale: "css" });
    await canvas.evaluate(element => { element.style.opacity = "0"; });
    let hidden: Buffer;
    try { hidden = await canvas.screenshot({ scale: "css" }); }
    finally { await canvas.evaluate(element => { element.style.removeProperty("opacity"); }); }
    result = await page.evaluate(async ({ visible, hidden }) => {
      const decode = async (base64: string) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const surface = document.createElement("canvas");
        surface.width = image.width; surface.height = image.height;
        const context = surface.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, image.width, image.height).data;
      };
      const a = await decode(visible), b = await decode(hidden);
      let changedPixels = 0;
      for (let offset = 0; offset < a.length; offset += 4) {
        if (Math.max(...[0, 1, 2].map(channel => Math.abs(a[offset + channel] - b[offset + channel]))) > 12) changedPixels++;
      }
      return { changedPixels, comparedPixels: a.length / 4 };
    }, { visible: visible.toString("base64"), hidden: hidden.toString("base64") });
    return result.changedPixels;
  }, { timeout: 30_000, message: "real artifact WebGL contributes nonblank composited pixels" }).toBeGreaterThan(100);
  return result;
}
