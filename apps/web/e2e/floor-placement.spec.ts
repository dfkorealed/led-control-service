import { expect, test, type Page } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { cpus } from "node:os";
import type Konva from "konva";
import type { FloorEditorState } from "../src/features/floor-editor/editor-types";
import { expectNoHorizontalOverflow } from "./support/layout-assertions";

async function editorFixture(page: Page, count = 24, alreadyPlaced = false, cadViewport?: { width: number; height: number }, slotCount = 0, objectCount = 0) {
  page.on("pageerror", (error) => console.error("Editor browser error", error.message));
  const states: Record<string, FloorEditorState> = Object.fromEntries([1, 2].map((floor) => [`floor-${floor}`, {
    floor: {
      id: `floor-${floor}`, siteId: "site-1", name: `B${floor}`, level: -floor, mapRevision: 1,
      floorPlan: cadViewport && floor === 1 ? {
        sourceType: "image", imageUrl: "/api/floors/floor-1/assets/cad/content", originalFileUrl: "/api/floors/floor-1/assets/source/content",
        renderedImageUrl: "/api/floors/floor-1/assets/cad/content", ...cadViewport, gridSize: 10, version: 1
      } : null
    }, objects: floor === 1 ? Array.from({ length: objectCount }, (_, index) => ({
      id: `object-${index + 1}`,
      floorId: "floor-1",
      type: "rectangle" as const,
      x: index === 0 ? 1_000 : 20 + ((index - 1) % 40) * 28,
      y: index === 0 ? 200 : 20 + Math.floor((index - 1) / 40) * 18,
      width: index === 0 ? 40 : 12,
      height: index === 0 ? 300 : 12,
      rotation: index === 0 ? 90 : index % 4 * 90,
      strokeColor: "#334155",
      fillColor: index % 2 === 0 ? "#e2e8f0" : "transparent",
      strokeWidth: 1,
      text: "",
      fontSize: null,
      zIndex: index,
      locked: false,
      visible: true
    })) : [], lightSlots: floor === 1 ? Array.from({ length: slotCount }, (_, index) => ({
      id: `slot-${index + 1}`,
      x: index === 0 ? 200 : 20 + ((index - 1) % 50) * 22,
      y: index === 0 ? 180 : 20 + Math.floor((index - 1) / 50) * 19,
      rotation: index % 4 * 90,
      assignedFixtureId: null
    })) : [],
    fixtures: Array.from({ length: floor === 1 ? count : 2 }, (_, i) => ({ id: `f${floor}-${i + 1}`, name: `B${floor}-L${String(i + 1).padStart(4, "0")}`, x: alreadyPlaced ? 20 + i % 40 * 25 : 0, y: alreadyPlaced ? 20 + Math.floor(i / 40) * 25 : 0, size: 20, ratedWatt: 40, brightness: 70, status: "online", placementStatus: alreadyPlaced ? "placed" : "unplaced", positionVerifiedAt: null }))
  }]));
  const saves: unknown[] = [];
  await page.route("**/api/**", async (route) => {
    if (!new URL(route.request().url()).pathname.startsWith("/api/")) return route.continue();
    const path = new URL(route.request().url()).pathname.replace(/^\/api/, "");
    if (path === "/auth/me") return route.fulfill({ json: { user: { id: "user-1", organizationId: "org-1", organizationType: "customer", loginId: "admin", name: "관리자", role: "admin", status: "active" } } });
    if (path === "/sites") return route.fulfill({ json: [{ id: "site-1", name: "검증 현장" }] });
    if (path === "/sites/site-1/dashboard") return route.fulfill({ json: { capabilities: { read: true, control: true, manage: true, commission: true }, site: { id: "site-1", name: "검증 현장", customerName: "고객사", installationStatus: "installed", address: null, tariffKwhRate: 160, timeZone: "Asia/Seoul" }, summary: { totalFixtures: count + 2, onlineFixtures: count + 2, faultFixtures: 0, averageBrightness: 70 }, floors: Object.values(states).map((s) => ({ ...s.floor, fixtures: [], meshControlGroups: [] })), groups: [], gateways: [] } });
    const floorId = path.match(/\/floors\/(floor-\d)/)?.[1];
    if (floorId === "floor-1" && path.endsWith("/import-jobs/applied-overlay")) return route.fulfill({ json: cadViewport ? {
      overlay: {
        floorId, jobId: "00000000-0000-4000-8000-000000000020", revision: 1,
        renderedAssetId: "00000000-0000-4000-8000-000000000040", renderedAssetPath: "/api/floors/floor-1/assets/cad/content",
        renderedViewport: cadViewport, appliedAt: "2026-09-17T00:00:00.000Z", candidates: []
      }
    } : { overlay: null } });
    if (path === "/floors/floor-1/assets/cad/content") return route.fulfill({
      contentType: "image/svg+xml",
      body: `<svg xmlns="http://www.w3.org/2000/svg" width="${cadViewport?.width ?? 1}" height="${cadViewport?.height ?? 1}"><rect width="100%" height="100%" fill="#fff"/><path d="M40 400H2360" stroke="#111827"/></svg>`
    });
    if (floorId && path.endsWith("/editor-lease")) return route.fulfill({ json: { editable: true, token: `lease-${floorId}`, fence: 1 } });
    if (floorId && path.endsWith("/editor-revisions")) return route.fulfill({ json: { items: [], nextCursor: null } });
    if (floorId && path.endsWith("/editor-state")) {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        expect(body.leaseToken).toBe(`lease-${floorId}`);
        expect(body.expectedRevision).toBe(states[floorId].floor.mapRevision);
        saves.push(body);
        states[floorId].fixtures = states[floorId].fixtures.map((f) => ({ ...f, ...body.fixtureUpdates.find((p: { id: string }) => p.id === f.id) }));
        states[floorId].floor.mapRevision++;
      }
      return route.fulfill({ json: states[floorId] });
    }
    return route.fulfill({ status: 404, json: { message: path } });
  });
  await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
  await expect(page.getByTestId("floor-editor-canvas")).toHaveAttribute("aria-disabled", "false");
  return { states, saves };
}

test("a normalized CAD map fits once and preserves subsequent user zoom", async ({ page }) => {
  await page.setViewportSize({ width: 1_440, height: 900 });
  await editorFixture(page, 24, false, { width: 2_400, height: 800 });
  const canvas = page.getByTestId("floor-editor-canvas");
  await expect(canvas).toHaveAttribute("data-map-width", "2400");
  await expect(canvas).toHaveAttribute("data-map-height", "800");

  const box = (await canvas.boundingBox())!;
  const expectedZoom = Math.max(0.1, Math.min(2, (box.width - 48) / 2_400, (box.height - 48) / 800));
  await expect.poll(async () => Number(await canvas.getAttribute("data-zoom"))).toBeCloseTo(expectedZoom, 3);

  await canvas.hover();
  await page.mouse.wheel(0, -100);
  const userZoom = Number(await canvas.getAttribute("data-zoom"));
  expect(userZoom).toBeGreaterThan(expectedZoom);
  await page.waitForTimeout(200);
  expect(Number(await canvas.getAttribute("data-zoom"))).toBeCloseTo(userZoom, 6);
});
async function currentState(page: Page) {
  return page.evaluate(async () => { const path = "/src/features/floor-editor/editor-store.ts"; return (await import(path)).useFloorEditorStore.getState().state as FloorEditorState; });
}

async function renderedLabels(page: Page) {
  return page.evaluate(() => {
    const konva = (window as unknown as { Konva: { stages: Konva.Stage[] } }).Konva;
    const stage = konva.stages.find((node) => node.container().closest('[data-testid="floor-editor-canvas"]'))!;
    return {
      bulkCount: stage.find(".fixture-name").length,
      focused: stage.find<Konva.Text>(".selected-fixture-name").map((node) => ({ text: node.text(), fontSize: node.fontSize() * node.getAbsoluteScale().x, width: node.getClientRect().width, height: node.getClientRect().height }))
    };
  });
}

async function fixturePixel(page: Page, x: number, y: number) {
  return page.evaluate((point) => {
    const konva = (window as unknown as { Konva: { stages: Konva.Stage[] } }).Konva;
    const stage = konva.stages.find((node) => node.container().closest('[data-testid="floor-editor-canvas"]'))!;
    const canvas = stage.findOne<Konva.Layer>(".editor-fixture-layer")!.getCanvas()._canvas;
    const ratio = canvas.width / canvas.getBoundingClientRect().width;
    return Array.from(canvas.getContext("2d")!.getImageData(Math.round(point.x * ratio), Math.round(point.y * ratio), 1, 1).data);
  }, { x, y });
}

test("1000 fixtures, 2000 slots and 2000 objects become canvas-ready within 3s p95 across 20 warm reloads", async ({ page, browser }, testInfo) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    const originalDecode = HTMLImageElement.prototype.decode;
    const decodeCounts: Record<string, number> = {};
    Object.defineProperty(window, "__floorPlanDecodeCounts", { value: decodeCounts, configurable: true });
    HTMLImageElement.prototype.decode = function decodeOnceForMeasurement() {
      const key = new URL(this.src, location.href).pathname;
      decodeCounts[key] = (decodeCounts[key] ?? 0) + 1;
      return originalDecode.call(this);
    };
    const check = () => {
      const container = document.querySelector<HTMLElement>('[data-testid="floor-editor-canvas"][data-floor-id="floor-1"]');
      const konva = (window as unknown as { Konva?: { stages: Konva.Stage[] } }).Konva;
      const stage = konva?.stages.find((node) => container?.contains(node.container()));
      const fixtureLayer = stage?.findOne<Konva.Layer>(".editor-fixture-layer");
      const objectLayer = stage?.findOne<Konva.Layer>(".editor-object-layer");
      const canvas = fixtureLayer?.getCanvas()._canvas;
      if (container?.getAttribute("aria-disabled") === "false" && fixtureLayer?.getChildren().length === 1000 && objectLayer?.getChildren().length === 2000 && stage?.find(".cad-placement-slot").length === 2000 && canvas && canvas.width > 0) {
        const ratio = canvas.width / canvas.getBoundingClientRect().width;
        const pixel = canvas.getContext("2d")!.getImageData(Math.round(20 * ratio), Math.round(20 * ratio), 1, 1).data;
        // Count actual fixture nodes and wait for a rendered marker, not just
        // the route, an empty Stage, or a loaded-but-unplaced fixture list.
        if (pixel[0] === 21 && pixel[1] === 159 && pixel[2] === 129 && pixel[3] === 255) {
          performance.mark("floor-editor-ready-1000");
          return;
        }
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  });
  await editorFixture(page, 1000, true, { width: 1_200, height: 800 }, 2_000, 2_000);
  await page.waitForFunction(() => performance.getEntriesByName("floor-editor-ready-1000").length === 1);
  const samples: Array<{ iteration: number; readyMs: number; fixtureNodeCount: number; slotNodeCount: number; objectNodeCount: number; layerCount: number; imageDecodeCount: number }> = [];
  for (let iteration = 1; iteration <= 20; iteration++) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => performance.getEntriesByName("floor-editor-ready-1000").length === 1);
    const sample = await page.evaluate(() => {
      const konva = (window as unknown as { Konva: { stages: Konva.Stage[] } }).Konva;
      const stage = konva.stages.find((node) => node.container().closest('[data-testid="floor-editor-canvas"]'))!;
      const decodeCounts = (window as unknown as { __floorPlanDecodeCounts: Record<string, number> }).__floorPlanDecodeCounts;
      return {
        readyMs: performance.getEntriesByName("floor-editor-ready-1000")[0].startTime,
        fixtureNodeCount: stage.findOne<Konva.Layer>(".editor-fixture-layer")!.getChildren().length,
        slotNodeCount: stage.find(".cad-placement-slot").length,
        objectNodeCount: stage.findOne<Konva.Layer>(".editor-object-layer")!.getChildren().length,
        layerCount: stage.getLayers().length,
        imageDecodeCount: decodeCounts["/api/floors/floor-1/assets/cad/content"] ?? 0
      };
    });
    samples.push({ iteration, ...sample });
  }
  const sorted = samples.map(({ readyMs }) => readyMs).sort((a, b) => a - b);
  const p95ReadyMs = sorted[Math.ceil(sorted.length * 0.95) - 1];
  const path = testInfo.outputPath("ready-1000-placed-p95.json");
  await writeFile(path, JSON.stringify({
    sampleCount: samples.length, fixtureCount: 1000, slotCount: 2000, objectCount: 2000, placementStatus: "placed", p95ReadyMs,
    percentileMethod: "nearest rank: ceil(20 * 0.95), 19th sorted sample",
    timing: "navigation start to editable Stage with 1000 fixture, 2000 slot and 2000 map-object nodes plus a painted fixture marker",
    scope: "mock API, warm local Vite/OS caches after one excluded warm-up, reused browser context; Playwright routing disables browser HTTP cache; not production or cold-start performance",
    viewport: "1440x900", browser: browser.version(), platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, samples
  }, null, 2));
  await testInfo.attach("ready-1000-placed-p95", { path, contentType: "application/json" });
  const screenshotPath = testInfo.outputPath("ready-1000-placed.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach("ready-1000-placed", { path: screenshotPath, contentType: "image/png" });
  expect(samples).toHaveLength(20);
  expect(samples.every(({ fixtureNodeCount, slotNodeCount, objectNodeCount, layerCount, imageDecodeCount, readyMs }) => fixtureNodeCount === 1000 && slotNodeCount === 2000 && objectNodeCount === 2000 && layerCount <= 5 && imageDecodeCount === 1 && Number.isFinite(readyMs) && readyMs > 0)).toBe(true);
  expect(p95ReadyMs).toBeLessThanOrEqual(3000);
});

for (const zoom of [0.5, 1, 2]) {
  test(`pointer drop uses pan and ${zoom}x zoom, Escape restores the rendered transform`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await editorFixture(page);
    // This case measures unsnapped fractional transforms for both drops;
    // default grid snapping has its own editor-layout regression.
    // React Aria owns a visually-hidden native input; activate its visible label
    // so this remains a real user interaction rather than a hidden-input action.
    const snap = page.getByRole("checkbox", { name: "격자 스냅" });
    await snap.locator("xpath=ancestor::label[1]").click();
    await expect(snap).not.toBeChecked();
    const canvas = page.getByTestId("floor-editor-canvas");
    for (let step = 0; step < Math.round(Math.abs(zoom - 1) * 10); step++) {
      await page.getByRole("button", { name: zoom < 1 ? "축소" : "확대", exact: true }).click();
    }
    expect(Number(await canvas.getAttribute("data-zoom"))).toBeCloseTo(zoom);
    await page.getByRole("button", { name: "이동", exact: true }).click();
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 60, box.y + 80);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 120, { steps: 8 });
    await page.mouse.up();
    await expect(canvas).toHaveAttribute("data-pan-x", "60");
    await expect(canvas).toHaveAttribute("data-pan-y", "40");

    // Record the real drop coordinates, including any scrolling and fractional CSS origin.
    await canvas.evaluate((element) => element.addEventListener("drop", (event) => {
      const rect = element.getBoundingClientRect();
      const drop = event as DragEvent;
      (element as HTMLElement).dataset.lastDrop = JSON.stringify({ x: drop.clientX - rect.left, y: drop.clientY - rect.top });
    }));
    await page.getByTestId("placement-fixture-f1-1").dragTo(canvas, { targetPosition: { x: 180, y: 220 } });
    const pointer = JSON.parse((await canvas.getAttribute("data-last-drop"))!) as { x: number; y: number };
    const first = (await currentState(page)).fixtures[0];
    expect(first.placementStatus).toBe("placed");
    expect(first.x).toBeCloseTo((pointer.x - 60) / zoom, 6);
    expect(first.y).toBeCloseTo((pointer.y - 40) / zoom, 6);
    await expect.poll(() => fixturePixel(page, pointer.x, pointer.y)).toEqual([21, 159, 129, 255]);

    await page.getByRole("button", { name: "이동", exact: true }).click();
    const currentBox = (await canvas.boundingBox())!;
    await page.mouse.move(currentBox.x + 60, currentBox.y + 80);
    await page.mouse.down();
    await page.mouse.move(currentBox.x + 160, currentBox.y + 120, { steps: 8 });
    await expect.poll(() => fixturePixel(page, pointer.x + 100, pointer.y + 40)).toEqual([21, 159, 129, 255]);
    await page.keyboard.press("Escape");
    await page.mouse.up();
    await expect(canvas).toHaveAttribute("data-pan-x", "60");
    await expect(canvas).toHaveAttribute("data-pan-y", "40");
    await expect.poll(() => fixturePixel(page, pointer.x, pointer.y)).toEqual([21, 159, 129, 255]);
    await expect.poll(async () => (await fixturePixel(page, pointer.x + 100, pointer.y + 40))[3]).toBe(0);

    await page.getByTestId("placement-fixture-f1-2").dragTo(canvas, { targetPosition: { x: 280, y: 310 } });
    const secondPointer = JSON.parse((await canvas.getAttribute("data-last-drop"))!) as { x: number; y: number };
    const state = await currentState(page);
    expect(state.fixtures).toHaveLength(24);
    expect(state.fixtures[0]).toEqual(first);
    expect(state.fixtures[1].x).toBeCloseTo((secondPointer.x - 60) / zoom, 6);
    expect(state.fixtures[1].y).toBeCloseTo((secondPointer.y - 40) / zoom, 6);
    await expect.poll(() => fixturePixel(page, secondPointer.x, secondPointer.y)).toEqual([21, 159, 129, 255]);
    await expect(page.getByRole("button", { name: "배치 해제", exact: true })).toBeVisible();
    const path = testInfo.outputPath(`selected-popup-zoom-${zoom}.png`);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach("selected-popup", { path, contentType: "image/png" });
  });
}

for (const zoom of [0.5, 2]) {
  test(`CAD slot hit radius uses screen distance and exact world snap at ${zoom}x with pan`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await editorFixture(page, 24, false, undefined, 1);
    const canvas = page.getByTestId("floor-editor-canvas");
    for (let step = 0; step < Math.round(Math.abs(zoom - 1) * 10); step++) {
      await page.getByRole("button", { name: zoom < 1 ? "축소" : "확대", exact: true }).click();
    }
    await page.getByRole("button", { name: "이동", exact: true }).click();
    const box = (await canvas.boundingBox())!;
    await page.mouse.move(box.x + 60, box.y + 80);
    await page.mouse.down();
    await page.mouse.move(box.x + 120, box.y + 120, { steps: 8 });
    await page.mouse.up();
    await expect(canvas).toHaveAttribute("data-pan-x", "60");
    await expect(canvas).toHaveAttribute("data-pan-y", "40");

    await page.getByTestId("placement-fixture-f1-1").dragTo(canvas, {
      targetPosition: { x: 60 + 200 * zoom + 12, y: 40 + 180 * zoom }
    });
    const state = await currentState(page);
    expect(state.fixtures[0]).toMatchObject({ placementStatus: "placed", x: 200, y: 180 });
    expect(state.lightSlots[0]).toMatchObject({ id: "slot-1", assignedFixtureId: "f1-1" });
  });
}

test("real pointer list drop, cancel/unplace, undo, save and floor isolation", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const { states, saves } = await editorFixture(page);
  const canvas = page.getByTestId("floor-editor-canvas");
  const source = page.getByTestId("placement-fixture-f1-1");
  await source.dragTo(canvas, { targetPosition: { x: 180, y: 220 } });
  await expect(page.getByRole("button", { name: "배치 해제", exact: true })).toBeVisible();
  let state = await currentState(page);
  expect(state.fixtures[0]).toMatchObject({ placementStatus: "placed" });
  expect(state.fixtures[0].x).toBeCloseTo(180, 0);
  expect(state.fixtures[0].y).toBeCloseTo(220, 0);
  expect(states["floor-1"].fixtures[0].placementStatus).toBe("unplaced");
  await page.getByRole("button", { name: "배치 해제", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const dialogPath = testInfo.outputPath("unplace-confirmation.png");
  await page.screenshot({ path: dialogPath, fullPage: true });
  await testInfo.attach("unplace-confirmation", { path: dialogPath, contentType: "image/png" });
  await page.getByRole("dialog").getByRole("button", { name: "취소" }).click();
  expect((await currentState(page)).fixtures[0].placementStatus).toBe("placed");
  await page.getByRole("button", { name: "배치 해제", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "배치 해제" }).click();
  await expect(source).toBeVisible();
  await page.getByRole("button", { name: "실행 취소", exact: true }).click();
  expect((await currentState(page)).fixtures[0]).toEqual(state.fixtures[0]);
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  await expect(page.getByRole("heading", { name: "B1 맵 편집" })).toBeVisible();
  expect(saves).toHaveLength(1);
  await page.getByRole("button", { name: "층 선택" }).click();
  await page.getByRole("option", { name: "B2", exact: true }).click();
  await expect(page.getByTestId("floor-editor-canvas")).toHaveAttribute("data-floor-id", "floor-2");
  expect((await currentState(page)).fixtures).toHaveLength(2);
  await expect(page.getByRole("button", { name: "실행 취소", exact: true })).toBeDisabled();
  await expectNoHorizontalOverflow(page);
});

test("1000 fixtures, 2000 slots and 2000 objects cull, pan, zoom and pointer-commit within p95 bounds", async ({ page }, testInfo) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1440, height: 900 });
  const start = Date.now();
  await editorFixture(page, 1000, false, undefined, 2_000, 2_000);
  const readyMs = Date.now() - start;
  expect(await page.getByTestId("placement-list").getByRole("button").count()).toBeLessThan(20);
  await page.getByLabel("조명 검색").fill("1000");
  await expect(page.getByTestId("placement-fixture-f1-1000")).toBeVisible();
  await page.getByLabel("조명 검색").fill("");
  await page.getByRole("button", { name: "전체 선택", exact: true }).click();
  await page.getByRole("tablist", { name: "편집 패널" }).getByRole("tab", { name: "배치", exact: true }).click();
  for (const [label, value] of [["시작 X", "20"], ["시작 Y", "20"], ["열", "40"], ["행", "25"], ["가로 간격", "25"], ["세로 간격", "25"]]) await page.getByRole("region", { name: "일괄 배치" }).getByLabel(label, { exact: true }).fill(value);
  await page.getByRole("button", { name: "배치 미리보기" }).click();
  await expect(page.getByText("1000개 배치 예정")).toBeVisible();
  expect((await currentState(page)).fixtures[0].placementStatus).toBe("unplaced");
  await page.getByRole("button", { name: "배치 적용" }).click();
  expect((await currentState(page)).fixtures.filter((f) => f.placementStatus === "placed")).toHaveLength(1000);
  expect(Number(await page.getByTestId("floor-editor-canvas").getAttribute("data-zoom"))).toBe(1);
  expect(await renderedLabels(page)).toEqual({ bulkCount: 0, focused: [] });
  await page.getByRole("button", { name: "실행 취소", exact: true }).click();
  expect((await currentState(page)).fixtures[0].placementStatus).toBe("unplaced");
  await page.getByRole("button", { name: "다시 실행" }).click();
  const canvas = page.getByTestId("floor-editor-canvas");
  const box = (await canvas.boundingBox())!;
  await page.getByRole("button", { name: "이동", exact: true }).click();
  await expect.poll(async () => Number(await canvas.getAttribute("data-rendered-fixture-count"))).toBeLessThan(1000);
  await expect.poll(async () => Number(await canvas.getAttribute("data-rendered-object-count"))).toBeLessThan(2_000);
  expect(Number(await canvas.getAttribute("data-rendered-object-count"))).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => {
    const konva = (window as unknown as { Konva: { stages: Konva.Stage[] } }).Konva;
    const stage = konva.stages.find((node) => node.container().closest('[data-testid="floor-editor-canvas"]'))!;
    return stage.find(".map-object-object-1").length;
  })).toBe(1);
  await page.evaluate(async () => {
    const { useFloorEditorStore } = await import("/src/features/floor-editor/editor-store.ts");
    useFloorEditorStore.getState().selectObject("object-2000");
  });
  await expect.poll(() => page.evaluate(() => {
    const konva = (window as unknown as { Konva: { stages: Konva.Stage[] } }).Konva;
    const stage = konva.stages.find((node) => node.container().closest('[data-testid="floor-editor-canvas"]'))!;
    return stage.find(".map-object-object-2000").length;
  })).toBe(1);
  await page.evaluate(async () => {
    const { useFloorEditorStore } = await import("/src/features/floor-editor/editor-store.ts");
    useFloorEditorStore.getState().setZoom(2);
    useFloorEditorStore.getState().setPan({ x: 0, y: 0 });
  });
  await expect(canvas).toHaveAttribute("data-zoom", "2");
  await expect.poll(async () => Number(await canvas.getAttribute("data-rendered-object-count"))).toBeLessThan(500);
  await page.getByRole("button", { name: "이동", exact: true }).click();
  const originalNodes = await page.evaluateHandle(() => {
    const konva = (window as unknown as { Konva: { stages: Konva.Stage[] } }).Konva;
    const stage = konva.stages.find((node) => node.container().closest('[data-testid="floor-editor-canvas"]'))!;
    return { stage, node: stage.findOne<Konva.Group>(".fixture-f1-1")! };
  });
  await page.mouse.move(box.x + 80, box.y + 100);
  await page.mouse.down();
  const frames = await page.evaluateHandle(() => {
    const samples: number[] = [];
    let previous = performance.now(), request = 0;
    const tick = (now: number) => { samples.push(now - previous); previous = now; request = requestAnimationFrame(tick); };
    request = requestAnimationFrame(tick);
    return { samples, stop: () => cancelAnimationFrame(request) };
  });
  await page.mouse.move(box.x + 200, box.y + 140, { steps: 120 });
  await page.mouse.up();
  for (let step = 0; step < 6; step++) await page.mouse.wheel(0, step < 3 ? -80 : 80);
  const sample = await frames.evaluate((measurement) => { measurement.stop(); return measurement.samples.slice(2); });
  await frames.dispose();
  const stableNodes = await originalNodes.evaluate(({ stage, node }) => {
    return node === stage.findOne<Konva.Group>(".fixture-f1-1");
  });
  await originalNodes.dispose();
  const sorted = [...sample].sort((a, b) => a - b);
  const elapsedMs = sample.reduce((sum, value) => sum + value, 0);
  const meanFps = sample.length * 1000 / elapsedMs;
  const p95FrameMs = sorted[Math.ceil(sorted.length * 0.95) - 1];
  const maxFrameMs = Math.max(...sample);
  let slowSpanMs = 0, longestSlowSpanMs = 0;
  for (const ms of sample) {
    slowSpanMs = ms > 1000 / 30 + 1 ? slowSpanMs + ms : 0;
    longestSlowSpanMs = Math.max(longestSlowSpanMs, slowSpanMs);
  }
  await page.evaluate(async () => {
    const { useFloorEditorStore } = await import("/src/features/floor-editor/editor-store.ts");
    useFloorEditorStore.getState().selectFixture("f1-1");
    useFloorEditorStore.getState().setSnap(false);
    Object.defineProperty(window, "__floorDragReleaseTimes", { value: [] as number[], configurable: true });
    window.addEventListener("mouseup", () => {
      (window as unknown as { __floorDragReleaseTimes: number[] }).__floorDragReleaseTimes.push(performance.now());
    }, { capture: true });
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
  const dragCommitSamplesMs: number[] = [];
  for (let iteration = 0; iteration < 20; iteration++) {
    const drag = await page.evaluate((direction) => {
      const konva = (window as unknown as { Konva: { stages: Konva.Stage[] } }).Konva;
      const stage = konva.stages.find((node) => node.container().closest('[data-testid="floor-editor-canvas"]'))!;
      const node = stage.findOne<Konva.Group>(".fixture-f1-1")!;
      const absolute = node.getAbsolutePosition();
      return { absolute, beforeX: node.x(), beforeY: node.y(), screenDeltaX: direction * 4 * node.getAbsoluteScale().x };
    }, iteration % 2 === 0 ? 1 : -1);
    await page.mouse.move(box.x + drag.absolute.x, box.y + drag.absolute.y);
    await page.mouse.down();
    await page.mouse.move(box.x + drag.absolute.x + drag.screenDeltaX, box.y + drag.absolute.y, { steps: 4 });
    await page.mouse.up();
    const duration = await page.evaluate(async ({ beforeX, beforeY }) => {
      const { useFloorEditorStore } = await import("/src/features/floor-editor/editor-store.ts");
      const releaseTimes = (window as unknown as { __floorDragReleaseTimes: number[] }).__floorDragReleaseTimes;
      const releasedAt = releaseTimes.at(-1)!;
      const deadline = releasedAt + 500;
      while (performance.now() < deadline) {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        const fixture = useFloorEditorStore.getState().state!.fixtures.find((item) => item.id === "f1-1")!;
        const konva = (window as unknown as { Konva: { stages: Konva.Stage[] } }).Konva;
        const stage = konva.stages.find((node) => node.container().closest('[data-testid="floor-editor-canvas"]'))!;
        const node = stage.findOne<Konva.Group>(".fixture-f1-1")!;
        const absolute = node.getAbsolutePosition();
        const canvas = stage.findOne<Konva.Layer>(".editor-fixture-layer")!.getCanvas()._canvas;
        const ratio = canvas.width / canvas.getBoundingClientRect().width;
        const pixel = canvas.getContext("2d")!.getImageData(Math.round(absolute.x * ratio), Math.round(absolute.y * ratio), 1, 1).data;
        if ((Math.abs(fixture.x - beforeX) >= 0.01 || Math.abs(fixture.y - beforeY) >= 0.01)
          && Math.abs(node.x() - fixture.x) < 0.01 && Math.abs(node.y() - fixture.y) < 0.01
          && pixel[0] === 21 && pixel[1] === 159 && pixel[2] === 129 && pixel[3] === 255) {
          return performance.now() - releasedAt;
        }
      }
      throw new Error("pointer drag did not reach a painted committed state within 500ms");
    }, { beforeX: drag.beforeX, beforeY: drag.beforeY });
    dragCommitSamplesMs.push(duration);
  }
  const sortedDragCommits = [...dragCommitSamplesMs].sort((a, b) => a - b);
  const p95DragCommitMs = sortedDragCommits[Math.ceil(sortedDragCommits.length * 0.95) - 1];
  expect((await currentState(page)).fixtures).toHaveLength(1000);
  const viewportBeforeSave = await canvas.evaluate((element) => ({ zoom: element.getAttribute("data-zoom"), x: element.getAttribute("data-pan-x"), y: element.getAttribute("data-pan-y") }));
  const saveStart = Date.now();
  await page.getByRole("button", { name: "저장", exact: true }).click();
  await expect.poll(async () => (await currentState(page)).floor.mapRevision).toBe(2);
  await expect(page.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
  await expect.poll(() => canvas.evaluate((element) => ({ zoom: element.getAttribute("data-zoom"), x: element.getAttribute("data-pan-x"), y: element.getAttribute("data-pan-y") }))).toEqual(viewportBeforeSave);
  const saveMs = Date.now() - saveStart;
  const metricsPath = testInfo.outputPath("performance.json");
  await writeFile(metricsPath, JSON.stringify({ readyMs, saveMs, timingScope: "single mock-API run for this interaction test; readiness p95 is recorded by the 20-reload test", dragTiming: "real Playwright mouseup to matching store and Konva position with the fixture color painted on the layer canvas", frames: sample.length, elapsedMs, meanFps, p95FrameMs, maxFrameMs, longestSlowSpanMs, dragCommitSampleCount: dragCommitSamplesMs.length, p95DragCommitMs, percentileMethod: "nearest rank: ceil(N * 0.95) - 1", stableNodes, frameSamplesMs: sample, dragCommitSamplesMs, viewport: "1440x900", browser: "Chromium", fixtureCount: 1000, slotCount: 2000, objectCount: 2000, platform: process.platform, arch: process.arch }, null, 2));
  await testInfo.attach("performance", { path: metricsPath, contentType: "application/json" });
  await page.getByRole("button", { name: "100%", exact: true }).click();
  const labelsAfterDragMeasurement = await renderedLabels(page);
  expect(labelsAfterDragMeasurement.bulkCount).toBe(0);
  expect(labelsAfterDragMeasurement.focused).toEqual([expect.objectContaining({ text: "B1-L0001", fontSize: 12 })]);
  await page.getByRole("complementary", { name: "맵 편집 정보" }).evaluate((element) => { element.scrollTop = 0; });
  const screenshotPath = testInfo.outputPath("editor-1000.png");
  await page.screenshot({ path: screenshotPath, fullPage: true });
  await testInfo.attach("editor-1000", { path: screenshotPath, contentType: "image/png" });

  await page.getByRole("button", { name: "선택", exact: true }).click();
  const firstPosition = await page.evaluate(() => {
    const konva = (window as unknown as { Konva: { stages: Konva.Stage[] } }).Konva;
    const stage = konva.stages.find((node) => node.container().closest('[data-testid="floor-editor-canvas"]'))!;
    return stage.findOne(".fixture-f1-1")!.getAbsolutePosition();
  });
  const currentBox = (await canvas.boundingBox())!;
  await page.mouse.click(currentBox.x + firstPosition.x, currentBox.y + firstPosition.y);
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 390, height: 844 }, { width: 320, height: 740 }]) {
    await page.setViewportSize(viewport);
    await page.getByRole("button", { name: "맵 맞춤" }).click();
    await expect(page.getByRole("button", { name: "배치 해제", exact: true })).toBeVisible();
    const labels = await renderedLabels(page);
    expect(labels.bulkCount).toBe(0);
    expect(labels.focused).toHaveLength(1);
    expect(labels.focused[0].text).toBe("B1-L0001");
    expect(labels.focused[0].fontSize).toBeCloseTo(12);
    expect(labels.focused[0].height).toBeGreaterThanOrEqual(28);
    await expectNoHorizontalOverflow(page);
    await page.getByRole("complementary", { name: "맵 편집 정보" }).evaluate((element) => { element.scrollTop = 0; });
    const path = testInfo.outputPath(`editor-1000-selected-${viewport.width}.png`);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(`editor-1000-selected-${viewport.width}`, { path, contentType: "image/png" });
  }
  // Keep artifacts even when a performance bound fails. These are local browser
  // regression limits, not claims about production API latency or device hardware.
  expect(stableNodes, "the visible anchor fixture reference survives pan/zoom culling").toBe(true);
  expect(sample.length).toBeGreaterThan(60);
  expect(meanFps).toBeGreaterThanOrEqual(30);
  expect(p95FrameMs).toBeLessThanOrEqual(33);
  expect(dragCommitSamplesMs).toHaveLength(20);
  expect(p95DragCommitMs).toBeLessThanOrEqual(100);
  expect(maxFrameMs, "no quarter-second UI freeze").toBeLessThanOrEqual(250);
  expect(longestSlowSpanMs, "no sustained half-second sub-30fps interval").toBeLessThan(500);
  expect(readyMs, "single-run readiness bound, not readiness p95").toBeLessThanOrEqual(3000);
  expect(saveMs, "single mocked-save bound, not production save p95").toBeLessThanOrEqual(3000);
});
