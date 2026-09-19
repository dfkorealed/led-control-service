import { createHash } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { cadSceneManifestSchema, cadSceneStateSchema, normalizeCadMapSize } from "@led-control/shared/cad-scene-contracts";
import { encodeCadSceneTile } from "../../../../api/src/floor-import/cad-scene-codec";
import { cadSceneCodecGolden } from "../cad-scene/cad-scene-codec.golden";

const storageOrigin = "http://127.0.0.1:15177";
const appOrigin = "http://127.0.0.1:15176";
const angle = 20 * Math.PI / 180;
const redCenter = {
  x: 7400 + 30 * 20 * Math.cos(angle) - 25 * 20 * Math.sin(angle),
  y: 7400 + 30 * 20 * Math.sin(angle) + 25 * 20 * Math.cos(angle)
};

for (const device of [
  { name: "desktop", width: 1280, height: 800, dpr: 1.5, mobile: false },
  { name: "mobile", width: 390, height: 844, dpr: 2, mobile: true }
]) {
  test.describe(device.name, () => {
    test.use({ baseURL: appOrigin, viewport: { width: device.width, height: device.height }, deviceScaleFactor: device.dpr });
    test("cold moved CAD aligns through camera changes, lifecycle and revision reloads under scoped CSP", async ({ page }, testInfo) => {
      const errors: string[] = [];
      const workers: string[] = [];
      page.on("pageerror", error => errors.push(error.message));
      page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
      page.on("worker", worker => workers.push(worker.url()));
      await page.addInitScript(mobile => {
        (window as any).__cspViolations = [];
        document.addEventListener("securitypolicyviolation", event => {
          (window as any).__cspViolations.push(event.violatedDirective + ":" + event.blockedURI);
        });
        if (mobile) {
          (window as any).__LED_CONTROL_MOBILE_WEBVIEW__ = true;
          (window as any).__LED_CONTROL_NATIVE_APP_STATE__ = "active";
        }
      }, device.mobile);
      const requests = await installSceneRoutes(page);
      const response = await page.goto("/src/features/floor-map/floor-map-composition-smoke.html");
      expect(response?.headers()["content-security-policy"]).toContain("script-src 'self'");
      expect(response?.headers()["content-security-policy"]).toContain("connect-src 'self' " + storageOrigin);
      await zoomToDestination(page);
      expect(requests.tiles).toHaveLength(0);
      await page.getByRole("button", { name: "Load CAD", exact: true }).click();
      await expect.poll(async () => ({
        visible: await page.getByTestId("cad-scene-canvas").isVisible(), errors,
        violations: await page.evaluate(() => (window as any).__cspViolations),
        requests: { tiles: requests.tiles, storage: requests.storage }
      })).toEqual({ visible: true, errors: [], violations: [], requests: { tiles: ["0/0/0/0"], storage: 1 } });
      await assertComposition(page);
      // At 4x fit zoom, the source at (0,0) is many preload rings outside the
      // visible world bounds. Only the persisted locator can restore it.
      expect(requests.tiles).toEqual(["0/0/0/0"]);
      expect(requests.storage).toBeGreaterThan(0);
      expect(workers.some(url => /assets\/.*\.js/.test(url))).toBe(true);
      const canvasSize = await page.getByTestId("cad-scene-canvas").evaluate((element: HTMLCanvasElement) => ({
        width: element.width, cssWidth: element.getBoundingClientRect().width
      }));
      expect(canvasSize.width / canvasSize.cssWidth).toBeCloseTo(device.mobile ? 1 : 1.5, 1);

      for (let cycle = 0; cycle < 2; cycle++) {
        const retired = await page.getByTestId("cad-scene-canvas").elementHandle();
        await page.evaluate(() => window.dispatchEvent(new CustomEvent("led-control:webview-lifecycle", { detail: { state: "background" } })));
        await expect(page.getByTestId("cad-scene-canvas")).toHaveCount(0);
        expect(await retired!.evaluate(canvas => canvas.isConnected)).toBe(false);
        await page.evaluate(() => window.dispatchEvent(new CustomEvent("led-control:webview-lifecycle", { detail: { state: "active" } })));
        await assertComposition(page);
        await retired!.dispose();
      }
      for (let revision = 2; revision <= 3; revision++) {
        const retired = await page.getByTestId("cad-scene-canvas").elementHandle();
        requests.revision = revision;
        await page.getByRole("button", { name: "Reload scene", exact: true }).click();
        await expect.poll(() => retired!.evaluate(canvas => canvas.isConnected)).toBe(false);
        await assertComposition(page);
        await retired!.dispose();
      }

      await page.getByRole("button", { name: "지도 축소", exact: true }).click();
      await assertComposition(page);
      const viewport = page.getByRole("region", { name: "합성 지도" });
      const before = await viewport.evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop }));
      const box = (await viewport.boundingBox())!;
      await page.mouse.move(box.x + 70, box.y + 80);
      await page.mouse.down();
      await page.mouse.move(box.x + 50, box.y + 65, { steps: 3 });
      await page.mouse.up();
      await expect.poll(() => viewport.evaluate(el => el.scrollLeft)).toBeGreaterThan(before.x);
      await assertComposition(page);
      await page.setViewportSize({ width: device.mobile ? 360 : 1000, height: device.mobile ? 780 : 720 });
      await page.getByRole("button", { name: "지도 화면 맞춤", exact: true }).click();
      await zoomToDestination(page);
      await assertComposition(page);
      await testInfo.attach(device.name + "-composition", { body: await viewport.screenshot(), contentType: "image/png" });

      await page.getByRole("button", { name: "B1-L001 정상 80%", exact: true }).click();
      await expect(page.getByLabel("Fixture presses")).toHaveText("1");
      const oldCanvas = await page.getByTestId("cad-scene-canvas").elementHandle();
      await page.getByRole("button", { name: "Switch floor", exact: true }).click();
      await expect(page.getByTestId("cad-scene-canvas")).toHaveCount(0);
      expect(await oldCanvas!.evaluate(el => el.isConnected)).toBe(false);
      const legacyRequests = requests.tiles.length;
      await page.getByRole("button", { name: "지도 확대", exact: true }).click();
      expect(requests.tiles).toHaveLength(legacyRequests);
      await page.getByRole("button", { name: "Switch floor", exact: true }).click();
      await zoomToDestination(page);
      await page.getByRole("button", { name: "Load CAD", exact: true }).click();
      await assertComposition(page);
      expect(requests.tiles.length).toBeGreaterThan(legacyRequests);
      expect(await page.evaluate(() => (window as any).__cspViolations)).toEqual([]);
      expect(errors).toEqual([]);
    });
  });
}

async function zoomToDestination(page: Page) {
  const viewport = page.getByRole("region", { name: "합성 지도" });
  for (let index = 0; index < 16; index++) {
    await viewport.dispatchEvent("wheel", { ctrlKey: true, deltaY: -1, clientX: 180, clientY: 200 });
  }
  await expect(viewport).toHaveAttribute("data-zoom", "4");
  await viewport.evaluate(async element => {
    // Wheel zoom anchors are committed in animation frames; wait for that
    // layout work before positioning the independent cold-start viewport.
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    // The cold start is centered before FloorScene/renderer exists.
    element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2;
    element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
    element.dispatchEvent(new Event("scroll"));
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
  });
}

async function assertComposition(page: Page) {
  await expect.poll(async () => {
    const viewport = page.getByRole("region", { name: "합성 지도" });
    const clip = (await viewport.boundingBox())!;
    const screenshot = await viewport.screenshot();
    const result = await page.evaluate(async ({ base64, clip, redCenter }) => {
      const image = new Image();
      image.src = "data:image/png;base64," + base64;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const context = canvas.getContext("2d")!;
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const red = { x: 0, y: 0, count: 0 };
      const magenta = { x: 0, y: 0, count: 0 };
      for (let y = 0; y < canvas.height; y++) for (let x = 0; x < canvas.width; x++) {
        const i = (y * canvas.width + x) * 4;
        const target = pixels[i] > 200 && pixels[i + 1] < 180 && pixels[i + 2] < 180
          ? red : pixels[i] > 200 && pixels[i + 1] < 80 && pixels[i + 2] > 200 ? magenta : null;
        if (target) { target.x += x + 0.5; target.y += y + 0.5; target.count++; }
      }
      const scene = document.querySelector("[data-floor-scene]")!.getBoundingClientRect();
      const expected = (x: number, y: number) => ({ x: scene.left + x * scene.width / 16384, y: scene.top + y * scene.height / 16384 });
      const error = (actual: typeof red, point: { x: number; y: number }) => actual.count === 0 ? 9999 : Math.hypot(
        clip.x + actual.x / actual.count * clip.width / image.width - point.x,
        clip.y + actual.y / actual.count * clip.height / image.height - point.y
      );
      const fixture = document.querySelector("[data-spatial-map-marker]")!.getBoundingClientRect();
      const fixtureExpected = expected(8200, 8500);
      return {
        red: error(red, expected(redCenter.x, redCenter.y)),
        manual: error(magenta, expected(8450, 8000)),
        fixture: Math.hypot(fixture.x + fixture.width / 2 - fixtureExpected.x, fixture.y + fixture.height / 2 - fixtureExpected.y)
      };
    }, { base64: screenshot.toString("base64"), clip, redCenter });
    return Math.max(result.red, result.manual, result.fixture);
  }, { timeout: 10_000, message: "CAD pixel centroid, Konva centroid and fixture center must match map-to-screen transform" }).toBeLessThan(1);
}

async function installSceneRoutes(page: Page) {
  const requests = { tiles: [] as string[], storage: 0, revision: 1 };
  const sceneId = "11111111-1111-4111-8111-111111111111";
  const payloads = new Map<string, Buffer>();
  const tiles = [[0, 0], [1, 0], [0, 1], [1, 1]].map(([tileX, tileY], index) => {
    const x = tileX * 512 + 80, y = tileY * 512 + 80;
    const payload = index === 0 ? Buffer.from(cadSceneCodecGolden.payloadBase64, "base64") : encodeCadSceneTile([{
      elementId: "other-" + index, groupId: null, layerName: "OTHER", sourceType: "LWPOLYLINE",
      type: "rectangle", bounds: { minX: x, minY: y, maxX: x + 20, maxY: y + 20 }, clipBounds: null,
      style: { strokeColor: null, fillColor: "#000000", strokeWidth: 0, opacity: 1 },
      geometry: { origin: { x, y }, width: 20, height: 20, rotation: 0 }
    }]);
    payloads.set("0/" + tileX + "/" + tileY + "/0", payload);
    return {
      version: 1, sceneId, tileX, tileY, lod: 0, part: 0,
      assetId: "44444444-4444-4444-8444-" + String(index).padStart(12, "0"),
      primitiveCount: index === 0 ? 7 : 1, byteSize: payload.byteLength,
      sha256: createHash("sha256").update(payload).digest("hex"),
      bounds: { minX: tileX * 512, minY: tileY * 512, maxX: (tileX + 1) * 512, maxY: (tileY + 1) * 512 }
    };
  });
  const scene = {
    id: sceneId, version: 1, sourceImportJobId: "22222222-2222-4222-8222-222222222222",
    width: 16384, height: 16384, tileSize: 512, primitiveCount: 10, tileCount: 4,
    manifestAssetId: "33333333-3333-4333-8333-333333333333",
    manifestContentPath: "/smoke/manifest", tileContentPathTemplate: "/smoke/tiles/{lod}/{tileX}/{tileY}/{part}", statePath: "/smoke/state"
  };
  const sourceBounds = { minX: 0, minY: 0, maxX: 512, maxY: 512 };
  const size = normalizeCadMapSize(sourceBounds);
  const scale = (size.width - size.padding * 2) / 512;
  const manifest = cadSceneManifestSchema.parse({
    version: 1, sceneId, regionId: "smoke", manifestAssetId: scene.manifestAssetId,
    ...size, tileSize: 512, lodMode: "additive", primitiveCount: 10, tileCount: 4,
    byteSize: 1, sha256: "a".repeat(64), sourceBounds,
    transform: { scaleX: scale, scaleY: -scale, translateX: size.padding, translateY: size.height - size.padding }, tiles
  });
  await page.route("**/api/smoke/manifest", route => route.fulfill({ json: manifest }));
  const state = cadSceneStateSchema.parse({
    revision: 1, scene, layers: [],
    overrides: [{
      elementId: "polyline-golden", hidden: false, locator: { tileX: 0, tileY: 0, lod: 0, part: 0 },
      transform: { translateX: 7400, translateY: 7400, scaleX: 20, scaleY: 20, rotation: 20 },
      strokeColor: "#ff0000", fillColor: "#ff0000", strokeWidth: 0, text: null
    }]
  });
  await page.route("**/api/smoke/state", route => route.fulfill({ json: {
    ...state, revision: requests.revision, scene: { ...scene, version: requests.revision }
  } }));
  await page.route("**/api/smoke/tiles/**", route => {
    const key = route.request().url().split("/tiles/")[1];
    requests.tiles.push(key);
    return route.fulfill({ status: 302, headers: { Location: storageOrigin + "/signed/" + key + "?signature=smoke" } });
  });
  for (const [key, payload] of payloads) {
    const response = await page.request.put(storageOrigin + "/fixtures/" + key, { data: payload });
    expect(response.ok()).toBe(true);
  }
  page.on("response", response => {
    if (response.url().startsWith(storageOrigin + "/signed/") && response.ok()) requests.storage++;
  });
  return requests;
}
