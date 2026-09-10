import { expect, test, type Page } from "@playwright/test";
import { expectMinimumTouchTargets, expectNoHorizontalOverflow } from "./support/layout-assertions";

const editorState = {
  floor: {
    id: "floor-b2",
    siteId: "site-2",
    name: "B2",
    level: -2,
    mapRevision: 7,
    floorPlan: {
      imageUrl: "/demo/floor-b2.svg",
      sourceType: "image",
      originalFileUrl: "/demo/floor-b2.svg",
      renderedImageUrl: "/demo/floor-b2.svg",
      width: 1200,
      height: 800,
      version: 1
    }
  },
  fixtures: [{
    id: "fixture-1", name: "B2-L01", x: 120, y: 140, size: 20, ratedWatt: 40,
    brightness: 70, status: "online"
  }],
  objects: []
};

test.beforeEach(async ({ page }) => {
  await mockEditorApi(page);
});

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "tablet", width: 1024, height: 768 },
  { name: "mobile", width: 390, height: 844 },
  { name: "compact", width: 320, height: 740 }
]) {
  test(`floor editor remains usable on ${viewport.name}`, async ({ page }, testInfo) => {
    await page.setViewportSize(viewport);
    await page.goto("/settings/floor-plans/floor-b2/edit?siteId=site-2");

    await expect(page.getByRole("heading", { name: "B2 맵 편집" })).toBeVisible();
    await expect(page.getByRole("toolbar", { name: "맵 편집 도구" })).toBeVisible();
    await expect(page.getByLabel("B2 편집 캔버스")).toBeVisible();
    await expect(page.getByRole("complementary", { name: "속성 패널" })).toBeVisible();
    await expect(page.getByRole("region", { name: "맵 버전" })).toBeVisible();

    const layout = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      bodyWidth: document.body.scrollWidth,
      shellWidth: document.querySelector<HTMLElement>(".floor-editor-shell")?.getBoundingClientRect().width ?? 0
    }));
    expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.shellWidth).toBeGreaterThan(viewport.width < 500 ? viewport.width - 40 : 800);
    await expectNoHorizontalOverflow(page);
    if (viewport.width <= 760) await expectMinimumTouchTargets(page, ".app-shell");
    const path = testInfo.outputPath(`editor-panels-${viewport.width}.png`);
    await page.screenshot({ path, fullPage: true });
    await testInfo.attach(`editor-panels-${viewport.width}`, { path, contentType: "image/png" });
  });
}

test("map settings drive absolute grid snapping and contextual shape properties", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/settings/floor-plans/floor-b2/edit?siteId=site-2");

  const properties = page.getByRole("complementary", { name: "속성 패널" });
  await expect(properties.getByRole("heading", { name: "맵 설정" })).toBeVisible();
  await properties.getByLabel("격자 간격").fill("20");
  await properties.getByRole("button", { name: "맵 설정 적용" }).click();
  await page.getByLabel("격자 스냅").check();

  const canvas = page.getByLabel("B2 편집 캔버스");
  await expect(canvas).toHaveAttribute("data-snap", "true");
  await expect(canvas).toHaveAttribute("data-grid-size", "20");
  const box = await canvas.boundingBox();
  if (!box) throw new Error("editor canvas has no layout box");

  await page.getByRole("button", { name: "사각형" }).click();
  await page.mouse.move(box.x + 203, box.y + 163);
  await page.mouse.down();
  await page.mouse.move(box.x + 297, box.y + 242);
  await page.mouse.up();

  await expect(properties.getByRole("heading", { name: "네모" })).toBeVisible();
  await expect(properties.getByLabel("X")).toHaveValue("200");
  await expect(properties.getByLabel("Y")).toHaveValue("160");
  await expect(properties.getByLabel("너비")).toHaveValue("100");
  await expect(properties.getByLabel("높이")).toHaveValue("80");
  await expect(properties.getByLabel("채우기 색상")).toBeVisible();
  await expect(properties.getByLabel("텍스트 내용")).toHaveCount(0);
});

async function mockEditorApi(page: Page) {
  await page.route("**/*", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.startsWith("/api/")) return route.continue();
    const path = pathname.replace(/^\/api/, "");
    if (path === "/auth/me") {
      return route.fulfill({ json: { user: {
        id: "user-1", organizationId: "org-1", organizationType: "customer", loginId: "demo_admin",
        name: "관리자", role: "admin", status: "active"
      } } });
    }
    if (path === "/sites") return route.fulfill({ json: [{ id: "site-2", name: "물류센터", customerName: "고객사" }] });
    if (path === "/sites/site-2/dashboard") {
      return route.fulfill({ json: {
        site: {
          id: "site-2",
          name: "물류센터",
          customerName: "고객사",
          installationStatus: "installed",
          address: "서울시 강남구",
          tariffKwhRate: 160,
          timeZone: "Asia/Seoul"
        },
        summary: { totalFixtures: 1, onlineFixtures: 1, faultFixtures: 0, averageBrightness: 70 },
        floors: [{ id: "floor-b2", name: "B2", level: -2, floorPlan: editorState.floor.floorPlan, meshControlGroups: [], fixtures: [] }],
        groups: [],
        gateways: []
      } });
    }
    if (path === "/floors/floor-b2/editor-state") return route.fulfill({ json: editorState });
    if (path === "/floors/floor-b2/editor-lease") return route.fulfill({ json: { editable: true, token: "test-lease", fence: 1 } });
    if (path === "/floors/floor-b2/editor-revisions") {
      return route.fulfill({ json: { items: [{
        revision: 7,
        snapshotSha256: "hash-7",
        changeSummary: { floorPlanChanged: true },
        restoredFromRevision: null,
        createdAt: "2026-08-06T03:00:00.000Z",
        actor: { displayName: "관리자" }
      }], nextCursor: null } });
    }
    return route.fulfill({ status: 404, json: { message: `Unhandled mock route: ${path}` } });
  });
}
