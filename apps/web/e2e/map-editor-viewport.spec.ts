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
    if (path === "/sites/site-2/monitoring-incidents") return route.fulfill({ json: {
      incidents: [], unreadCount: 0, activeCount: 0, nextCursor: null
    } });
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

async function expectReachable(target: Locator) {
  await expect(target).toBeVisible();
  await expect(target).toBeInViewport({ ratio: 1 });
  expect(await target.evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return node.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
  }), "control center must not be clipped or covered").toBe(true);
}

for (const width of [1039, 1434]) {
  test(`map editor comments ${width}x909 keep shell and information bounded with internal history pagination`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 909 });
    const historyRequests: string[] = [];
    await page.route("**/api/floors/floor-b2/editor-revisions**", async (route) => {
      const cursor = new URL(route.request().url()).searchParams.get("cursor");
      historyRequests.push(cursor ?? "first");
      return route.fulfill({ json: {
        items: Array.from({ length: cursor ? 10 : 30 }, (_, index) => ({
          revision: (cursor ? 10 : 40) - index, snapshotSha256: `history-${cursor ?? "first"}-${index}`,
          changeSummary: { floorPlanChanged: true }, restoredFromRevision: null,
          createdAt: "2026-08-06T03:00:00.000Z", actor: { displayName: "관리자" }
        })), nextCursor: cursor ? null : 11
      } });
    });
    await page.goto(editorPath);
    await expect(page.getByTestId("floor-editor-canvas")).toHaveAttribute("data-map-ready", "true");
    const topbar = page.locator("[data-shell-topbar]");
    const account = page.getByRole("region", { name: "내 계정", exact: true });
    await expect(topbar).toBeVisible();
    await expect(account).toBeVisible();
    await expectReachable(account.getByRole("button", { name: "로그아웃", exact: true }));
    await expectReachable(topbar.getByRole("link", { name: "내 계정 및 보안", exact: true }));
    if (width < 1280) await page.getByRole("button", { name: "편집 정보 패널" }).click();
    const information = page.getByRole("complementary", { name: "맵 편집 정보" });
    await expect(information).toBeVisible();
    for (const target of [topbar, account, information]) {
      const box = (await target.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(width + 1);
      expect(box.y + box.height).toBeLessThanOrEqual(910);
    }
    const topbarBox = (await topbar.boundingBox())!;
    const accountBox = (await account.boundingBox())!;
    const panelBox = (await information.boundingBox())!;
    expect(panelBox.y).toBeGreaterThanOrEqual(accountBox.y + accountBox.height);
    expect(accountBox.y).toBeGreaterThanOrEqual(topbarBox.y + topbarBox.height);
    for (const name of ["맵 너비", "맵 높이"]) {
      const input = information.getByLabel(name);
      await input.scrollIntoViewIfNeeded();
      await expectReachable(input);
      await input.focus();
      await expect(input).toBeFocused();
      await expectBoundedPage(page);
    }
    const applySettings = information.getByRole("button", { name: "맵 설정 적용", exact: true });
    await applySettings.scrollIntoViewIfNeeded();
    await expectReachable(applySettings);
    await page.screenshot({ path: testInfo.outputPath(`comments-information-${width}.png`) });
    await information.getByRole("tab", { name: "자료" }).click();
    const history = information.getByRole("region", { name: "맵 버전", exact: true });
    const list = history.getByTestId("editor-revision-list");
    await expect(list.locator("li")).toHaveCount(30);
    await history.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath(`comments-history-${width}.png`) });
    // The history's scrollport must be inside the history region: scrolling the
    // entire information panel would move its tabs out of reach.
    const scrollport = await list.evaluate((node) => {
      const region = node.closest('[aria-label="맵 버전"]')!;
      for (let current: Element | null = node; current; current = current.parentElement) {
        if (["auto", "scroll"].includes(getComputedStyle(current).overflowY)
          && current.scrollHeight > current.clientHeight) {
          if (!region.contains(current)) return null;
          current.scrollTop = current.scrollHeight;
          return { clientHeight: current.clientHeight, scrollHeight: current.scrollHeight, scrollTop: current.scrollTop };
        }
        if (current === region) break;
      }
      return null;
    });
    expect(scrollport, "long history must have its own internal scrollport").not.toBeNull();
    expect(scrollport!.scrollTop).toBeGreaterThan(0);
    await expectReachable(history.getByRole("button", { name: "리비전 11 복구", exact: true }));
    const more = history.getByRole("button", { name: "이전 버전 더 보기", exact: true });
    await more.scrollIntoViewIfNeeded();
    await expectReachable(more);
    await expectBoundedPage(page);
    await more.click();
    await expect.poll(() => historyRequests).toEqual(["first", "11"]);
    await expect(list.locator("li")).toHaveCount(40);
    await history.getByRole("button", { name: "리비전 1 복구", exact: true }).scrollIntoViewIfNeeded();
    await expectReachable(history.getByRole("button", { name: "리비전 1 복구", exact: true }));
    await expect(more).toHaveCount(0);
    await expectBoundedPage(page);
    await page.screenshot({ path: testInfo.outputPath(`comments-history-end-${width}.png`) });
  });
}

for (const viewport of viewports) {
  test(`editor viewport ${viewport.width} confines long panels and preserves camera gestures`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto(editorPath);
    const canvas = page.getByTestId("floor-editor-canvas");
    // Route hydration and WebGL document readiness are separate user stages.
    await expect(page.getByRole("img", { name: "맵 도형", exact: true })).toBeVisible();
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
    await information.getByTestId("editor-revision-list").evaluate((node) => { node.scrollTop = node.scrollHeight; });
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
    await canvas.hover({ position: { x: 20, y: 20 } });
    await page.mouse.wheel(0, -120);
    await expect.poll(async () => Number(await canvas.getAttribute("data-zoom"))).toBeGreaterThan(zoomBefore);
    if (narrow) await page.getByRole("button", { name: "도구 및 조명 패널" }).click();
    await page.getByRole("button", { name: "이동", exact: true }).click();
    const box = (await canvas.boundingBox())!;
    const panBefore = Number(await canvas.getAttribute("data-pan-x"));
    await page.mouse.move(box.x + 30, box.y + 30);
    await page.mouse.down();
    await expect(canvas).toHaveCSS("cursor", "grabbing");
    await page.mouse.move(box.x + 70, box.y + 60);
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
  await expect(page.getByRole("img", { name: "맵 도형", exact: true })).toBeVisible();
  await expect(canvas).toHaveAttribute("data-map-ready", "true");
  await page.getByRole("button", { name: "도구 및 조명 패널" }).click();
  await page.getByRole("button", { name: "텍스트", exact: true }).click();
  await expect(page.locator("#editor-tools-panel")).toBeHidden();
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
  await page.getByRole("button", { name: "맵으로 돌아가기", exact: true }).click();
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
    await expectMinimumTouchTargets(page, '[data-testid="floor-editor-canvas"] [role="alert"]');
    await page.getByRole("button", { name: "편집 정보 패널" }).click();
    const cancelGeometry = await page.getByRole("button", { name: "맵으로 돌아가기", exact: true }).evaluate((button) => {
      const rect = button.getBoundingClientRect();
      const hits = (x: number, y: number) => button.contains(document.elementFromPoint(x, y));
      return { width: rect.width, height: rect.height, radius: getComputedStyle(button).borderRadius,
        centerReachable: hits(rect.x + rect.width / 2, rect.y + rect.height / 2),
        cornerReachable: hits(rect.x + 0.5, rect.y + 0.5) };
    });
    await testInfo.attach("cancel-hit-geometry.json", { body: JSON.stringify(cancelGeometry), contentType: "application/json" });
    await expectMinimumTouchTargetsAfterScrolling(page, '[data-testid="editor-toolbar"]');
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
  await page.getByRole("button", { name: "맵으로 돌아가기", exact: true }).click();
  await page.getByRole("navigation", { name: "모바일 주 메뉴" }).getByRole("link", { name: "설정", exact: true }).click();
  await expect(page).toHaveURL(/\/settings\?siteId=site-2$/);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollHeight > innerHeight)).toBe(true);
  await page.mouse.wheel(0, 1000);
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
});
