import { expect, test, type Locator, type Page } from "@playwright/test";
import type { FloorEditorState } from "../src/features/floor-editor/editor-types";
import { expectMinimumTouchTargets, expectMinimumTouchTargetsAfterScrolling } from "./support/layout-assertions";

const viewports = [
  { width: 1440, height: 900 }, { width: 1024, height: 768 },
  { width: 390, height: 844 }, { width: 320, height: 740 }
];
const editorPath = "/settings/floor-plans/floor-b2/edit?siteId=site-2";
const state: FloorEditorState = {
  floor: { id: "floor-b2", siteId: "site-2", name: "B2", level: -2, mapRevision: 7,
    floorPlan: { imageUrl: "", sourceType: "none", width: 1200, height: 800, gridSize: 10, version: 1 },
    mapDocument: { formatVersion: 1, generationId: "viewport-map", revision: 7, width: 1200, height: 800, gridSize: 10, elementCount: 0,
      manifest: { assetId: "00000000-0000-4000-8000-000000000002", sha256: "a".repeat(64), byteSize: 1, decodedByteSize: 1 } } },
  fixtures: Array.from({ length: 100 }, (_, index) => ({
    id: `fixture-${index}`, name: `B2-L${index}`, x: 0, y: 0, size: 20, ratedWatt: 40,
    brightness: 70, status: "online", placementStatus: "unplaced"
  })),
  objects: [], lightSlots: []
};

test.beforeEach(async ({ page }) => {
  await page.route("**/api/**", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.startsWith("/api/")) return route.continue();
    const path = pathname.replace(/^\/api/, "");
    if (path === "/auth/me") return route.fulfill({ json: { user: {
      id: "user-1", organizationId: "org-1", organizationType: "customer", loginId: "demo_admin",
      name: "관리자", role: "admin", status: "active"
    } } });
    if (path === "/sites") return route.fulfill({ json: [{ id: "site-2", name: "물류센터", customerName: "고객사" }] });
    if (path === "/sites/site-2/dashboard") return route.fulfill({ json: {
      capabilities: { read: true, control: true, manage: true, commission: true },
      site: { id: "site-2", name: "물류센터", customerName: "고객사", installationStatus: "installed", address: "서울", tariffKwhRate: 160, timeZone: "Asia/Seoul" },
      summary: { totalFixtures: 100, onlineFixtures: 100, faultFixtures: 0, averageBrightness: 70 },
      floors: [{ ...state.floor, meshControlGroups: [], fixtures: [] }], groups: [], gateways: []
    } });
    if (path === "/floors/floor-b2/editor-state") return route.fulfill({ json: state });
    if (path === "/floors/floor-b2/editor-lease") return route.fulfill({ json: { editable: true, token: "viewport-lease", fence: 1 } });
    if (path === "/floors/floor-b2/map-document") return route.fulfill({ json: state.floor.mapDocument });
    if (path === "/floors/floor-b2/map-document/manifest") {
      const document = state.floor.mapDocument!;
      return route.fulfill({ json: { generationId: document.generationId, revision: document.revision, canonical: document.manifest,
        groups: [], layers: [{ id: "map", name: "Map", order: 0, visible: true, locked: false }], displayLayerBindings: [],
        display: { version: 2, sceneId: "00000000-0000-4000-8000-000000000001", regionId: "manual", manifestAssetId: document.manifest.assetId,
          width: document.width, height: document.height, padding: 0, gridSize: document.gridSize, tileSize: 512,
          lodMode: "additive", primitiveCount: 0, tileCount: 0, byteSize: 1, sha256: "a".repeat(64),
          sourceBounds: { minX: 0, minY: 0, maxX: document.width, maxY: document.height },
          transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 }, tiles: [] } } });
    }
    if (path === "/floors/floor-b2/map-document/changes") return route.fulfill({ json: {
      generationId: state.floor.mapDocument!.generationId, revision: state.floor.mapDocument!.revision,
      operations: [], nextCursor: null
    } });
    if (path === "/floors/floor-b2/map-document/elements") return route.fulfill({ json: [] });
    if (path === "/floors/floor-b2/map-document/selection") return route.fulfill({ json: {
      generationId: state.floor.mapDocument!.generationId, revision: state.floor.mapDocument!.revision,
      ids: [], nextCursor: null
    } });
    if (path === "/floors/floor-b2/editor-revisions") return route.fulfill({ json: {
      items: Array.from({ length: 30 }, (_, index) => ({ revision: 30 - index, snapshotSha256: `hash-${index}`,
        changeSummary: { floorPlanChanged: true }, restoredFromRevision: null, createdAt: "2026-08-06T03:00:00.000Z", actor: { displayName: "관리자" } })), nextCursor: null
    } });
    if (path === "/floors/floor-b2/import-overlay") return route.fulfill({ json: { overlay: null } });
    return route.fulfill({ status: 404, json: { message: `Unhandled viewport fixture: ${path}` } });
  });
});

async function expectBoundedPage(page: Page) {
  await expect.poll(() => page.evaluate(() => ({
    height: Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - innerHeight,
    width: Math.max(document.documentElement.scrollWidth, document.body.scrollWidth) - innerWidth,
    scroll: window.scrollY
  }))).toEqual({ height: 0, width: 0, scroll: 0 });
  const canvas = await page.getByTestId("floor-editor-canvas").boundingBox();
  expect(canvas).not.toBeNull();
  expect(canvas!.height).toBeGreaterThan(120);
  expect(canvas!.width).toBeGreaterThan(200);
  expect(canvas!.y + canvas!.height).toBeLessThanOrEqual((page.viewportSize()?.height ?? 0) - (page.viewportSize()!.width < 760 ? 68 : 0));
}

for (const viewport of viewports) {
  test(`editor viewport ${viewport.width} confines long panels and preserves camera gestures`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto(editorPath);
    const canvas = page.getByTestId("floor-editor-canvas");
    await expect(canvas).toHaveAttribute("data-map-ready", "true");
    await expectBoundedPage(page);
    const narrow = viewport.width < 1280;
    if (narrow) await page.getByRole("button", { name: "도구 및 조명 패널" }).click();
    const fixtures = page.getByTestId("placement-list");
    await fixtures.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await expect(page.getByTestId("placement-fixture-fixture-99")).toBeVisible();
    await page.getByTestId("placement-fixture-fixture-99").scrollIntoViewIfNeeded();
    await expect(page.getByTestId("placement-fixture-fixture-99")).toBeInViewport();
    if (narrow) await page.getByRole("button", { name: "도구 및 조명 패널" }).click();
    const toolbar = page.getByTestId("editor-toolbar");
    const toolbarBefore = await toolbar.boundingBox();
    if (narrow) await page.getByRole("button", { name: "편집 정보 패널" }).click();
    const information = page.getByRole("complementary", { name: "맵 편집 정보" });
    await information.getByLabel("맵 너비").focus();
    await expectBoundedPage(page);
    await page.screenshot({ path: testInfo.outputPath(`information-${viewport.width}.png`), fullPage: true });
    await information.getByRole("tab", { name: "자료" }).click();
    await information.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    await expect(page.getByRole("button", { name: "리비전 1 복구", exact: true })).toBeInViewport();
    if (narrow) {
      await information.focus();
      await page.keyboard.press("Tab");
      await expect.poll(() => information.evaluate((node) => node.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("Escape");
      await expect(information).toBeHidden();
      await expect(page.getByRole("button", { name: "편집 정보 패널" })).toBeFocused();
    }
    expect(await toolbar.boundingBox()).toEqual(toolbarBefore);
    const zoomBefore = Number(await canvas.getAttribute("data-zoom"));
    await canvas.hover();
    await page.mouse.wheel(0, -120);
    await expect.poll(async () => Number(await canvas.getAttribute("data-zoom"))).toBeGreaterThan(zoomBefore);
    if (narrow) await page.getByRole("button", { name: "도구 및 조명 패널" }).click();
    await page.getByRole("button", { name: "이동", exact: true }).click();
    const box = (await canvas.boundingBox())!;
    const panBefore = Number(await canvas.getAttribute("data-pan-x"));
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await expect(canvas).toHaveCSS("cursor", "grabbing");
    await page.mouse.move(box.x + box.width / 2 + 40, box.y + box.height / 2 + 30);
    await page.mouse.up();
    await expect.poll(async () => Number(await canvas.getAttribute("data-pan-x"))).not.toBe(panBefore);
    await expect(canvas).toHaveCSS("background-image", "none");
    await expectBoundedPage(page);
    await page.screenshot({ path: testInfo.outputPath(`viewport-${viewport.width}.png`), fullPage: true });
  });
}

test("compact text focus and panel toggles preserve unsaved edits and the leave guard", async ({ page }) => {
  await page.setViewportSize(viewports[3]);
  await page.goto(editorPath);
  const canvas = page.getByTestId("floor-editor-canvas");
  await expect(canvas).toHaveAttribute("data-map-ready", "true");
  await page.getByRole("button", { name: "도구 및 조명 패널" }).click();
  await page.getByRole("button", { name: "텍스트", exact: true }).click();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 90);
  await page.mouse.up();
  await page.getByRole("button", { name: "편집 정보 패널" }).click();
  const text = page.getByRole("textbox", { name: "텍스트" });
  await text.fill("Viewport draft");
  await expectBoundedPage(page);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "편집 정보 패널" }).click();
  await expect(text).toHaveValue("Viewport draft");
  await page.getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByRole("alertdialog", { name: "맵 편집 종료" })).toBeVisible();
});

async function dragToCanvasCenter(page: Page, source: Locator) {
  await source.scrollIntoViewIfNeeded();
  const liveSource = await source.elementHandle();
  const sourceBox = (await source.boundingBox())!;
  const canvasBox = (await page.getByTestId("floor-editor-canvas").boundingBox())!;
  const center = { x: canvasBox.x + canvasBox.width / 2, y: canvasBox.y + canvasBox.height / 2 };
  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(sourceBox.x + sourceBox.width / 2 + 10, sourceBox.y + sourceBox.height / 2, { steps: 3 });
  await page.mouse.move(center.x, center.y, { steps: 10 });
  await page.mouse.move(center.x, center.y);
  // A layout fix must not terminate native DnD by removing its live source.
  expect(await liveSource!.evaluate((node) => node.isConnected)).toBe(true);
  return center;
}

for (const viewport of viewports.slice(2)) {
  test(`mobile ${viewport.width} toolbar has continuous reachable touch targets`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.route("**/api/floors/floor-b2/editor-state", (route) => route.fulfill({ json: {
      ...state, floor: { ...state.floor, mapDocument: null, floorPlan: { ...state.floor.floorPlan!, sourceType: "image",
        imageUrl: "/viewport-missing.svg", renderedImageUrl: "/viewport-missing.svg" } }
    } }));
    await page.route("**/viewport-missing.svg", (route) => route.fulfill({ status: 404, body: "" }));
    await page.goto(editorPath);
    await expect(page.getByTestId("floor-editor-canvas")).toBeVisible();
    const retry = page.getByRole("button", { name: "도면 다시 시도" });
    await expect(retry).toBeVisible();
    await page.getByRole("button", { name: "편집 정보 패널" }).click();
    const cancelGeometry = await page.getByRole("button", { name: "취소", exact: true }).evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const hits = (x: number, y: number) => button.contains(document.elementFromPoint(x, y));
      return { width: rect.width, height: rect.height, radius: getComputedStyle(button).borderRadius,
        centerReachable: hits(rect.x + rect.width / 2, rect.y + rect.height / 2),
        cornerReachable: hits(rect.x + 0.5, rect.y + 0.5) };
    });
    await testInfo.attach("cancel-hit-geometry.json", { body: JSON.stringify(cancelGeometry), contentType: "application/json" });
    await expectMinimumTouchTargetsAfterScrolling(page, '[data-testid="editor-toolbar"]');
    await expectMinimumTouchTargets(page, '[data-testid="floor-editor-canvas"] [role="alert"]');
    await expectMinimumTouchTargets(page, '[aria-label="편집 패널"]');
    await expect(page.getByRole("button", { name: "미니맵" })).toBeHidden();
    await expectBoundedPage(page);
    await page.screenshot({ path: testInfo.outputPath(`retry-panel-${viewport.width}.png`) });
    await page.getByRole("button", { name: "편집 정보 패널" }).click();
    const minimap = page.getByRole("button", { name: "미니맵" });
    await expect(minimap).toBeVisible();
    await expectMinimumTouchTargets(page, 'canvas[role="button"]');
    await minimap.focus();
    await page.keyboard.press("Enter");
    await expectBoundedPage(page);
  });

  for (const kind of ["fixture", "shape"] as const) {
    test(`mobile ${viewport.width} ${kind} drag reaches canvas center and restores tools after drop and cancel`, async ({ page }, testInfo) => {
      await page.setViewportSize(viewport);
      await page.goto(editorPath);
      const canvas = page.getByTestId("floor-editor-canvas");
      await expect(canvas).toHaveAttribute("data-map-ready", "true");
      const toggle = page.getByRole("button", { name: "도구 및 조명 패널" });
      await toggle.click();
      const panel = page.locator("#editor-tools-panel");
      const source = kind === "fixture" ? page.getByTestId("placement-fixture-fixture-0")
        : panel.getByRole("button", { name: "사각형", exact: true });
      const center = await dragToCanvasCenter(page, source);
      await page.screenshot({ path: testInfo.outputPath(`drag-${kind}-${viewport.width}.png`) });
      await page.mouse.up();
      const countAttribute = kind === "fixture" ? "data-rendered-fixture-count" : "data-map-selection-count";
      await expect(canvas).toHaveAttribute(countAttribute, "1", { timeout: 5000 });
      await expect(panel).toHaveCSS("opacity", "1");
      await expect(panel).toHaveCSS("pointer-events", "auto");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      if (kind === "fixture") {
        await expect(panel.getByText("배치 1", { exact: true })).toBeVisible();
        await expect(panel.getByText("미배치 99", { exact: true })).toBeVisible();
        await expect(panel).toBeFocused();
      } else {
        await expect(source).toBeFocused();
      }

      const cancelledSource = kind === "fixture" ? page.getByTestId("placement-fixture-fixture-1") : source;
      await dragToCanvasCenter(page, cancelledSource);
      await expect.poll(() => page.evaluate(({ x, y }) => Boolean(
        document.elementFromPoint(x, y)?.closest('[data-testid="floor-editor-canvas"]')
      ), center)).toBe(true);
      await page.keyboard.press("Escape");
      await page.mouse.up();
      await expect(panel).toHaveCSS("opacity", "1");
      await expect(panel).toHaveCSS("pointer-events", "auto");
      await expect(toggle).toHaveAttribute("aria-expanded", "true");
      await expect(cancelledSource).toBeFocused();
      if (kind === "fixture") await expect(canvas).toHaveAttribute(countAttribute, "1");
      else {
        // Starting another tool drag clears selection, not the first saved-in-draft shape.
        await expect(page.getByRole("button", { name: "저장", exact: true })).toBeEnabled();
        await page.getByRole("button", { name: "실행 취소" }).click();
        await expect(page.getByRole("button", { name: "저장", exact: true })).toBeDisabled();
      }
      await expectBoundedPage(page);
      await panel.focus();
      await page.keyboard.press("Escape");
      await expect(panel).toBeHidden();
      await expect(toggle).toBeFocused();
      await expectMinimumTouchTargetsAfterScrolling(page, '[data-testid="editor-toolbar"]');
    });
  }
}

test("resizing the editor and leaving it restores normal settings scrolling", async ({ page }) => {
  await page.setViewportSize(viewports[0]);
  await page.goto(editorPath);
  await expect(page.getByTestId("floor-editor-canvas")).toBeVisible();
  for (const viewport of [...viewports.slice(1), viewports[0]]) {
    await page.setViewportSize(viewport);
    await expectBoundedPage(page);
  }
  await page.setViewportSize({ width: 390, height: 500 });
  await page.getByRole("button", { name: "취소", exact: true }).click();
  await page.getByRole("link", { name: "설정 개요" }).click();
  await expect(page).toHaveURL(/\/settings\?siteId=site-2$/);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight > innerHeight)).toBe(true);
  await page.mouse.wheel(0, 1000);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
});
