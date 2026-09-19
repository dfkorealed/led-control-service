import { expect, test, type Page } from "@playwright/test";
import type { FloorEditorState } from "../src/features/floor-editor/editor-types";

const viewports = [
  { width: 1440, height: 900 }, { width: 1024, height: 768 },
  { width: 390, height: 844 }, { width: 320, height: 740 }
];
const editorPath = "/settings/floor-plans/floor-b2/edit?siteId=site-2";
const state: FloorEditorState = {
  floor: { id: "floor-b2", siteId: "site-2", name: "B2", level: -2, mapRevision: 7,
    floorPlan: { imageUrl: "", sourceType: "image", originalFileUrl: "", renderedImageUrl: "", width: 1200, height: 800, version: 1 } },
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
    await expect(canvas).toBeVisible();
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
  await expect(canvas).toBeVisible();
  await page.getByRole("button", { name: "도구 및 조명 패널" }).click();
  await page.getByRole("button", { name: "텍스트", exact: true }).click();
  const box = (await canvas.boundingBox())!;
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 150, box.y + 90);
  await page.mouse.up();
  await page.getByRole("button", { name: "편집 정보 패널" }).click();
  const text = page.getByRole("textbox", { name: "텍스트 내용" });
  await text.fill("Viewport draft");
  await expectBoundedPage(page);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "편집 정보 패널" }).click();
  await expect(text).toHaveValue("Viewport draft");
  await page.getByRole("button", { name: "취소", exact: true }).click();
  await expect(page.getByRole("alertdialog", { name: "맵 편집 종료" })).toBeVisible();
});

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
