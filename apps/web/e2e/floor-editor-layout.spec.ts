import { expect, test, type Page } from "@playwright/test";

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
  { name: "desktop", width: 1440, height: 1000 },
  { name: "mobile", width: 390, height: 844 }
]) {
  test(`floor editor remains usable on ${viewport.name}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/settings/floor-plans/floor-b2/edit?siteId=site-2");

    await expect(page.getByRole("heading", { name: "B2 도면 편집" })).toBeVisible();
    await expect(page.getByRole("toolbar", { name: "도면 편집 도구" })).toBeVisible();
    await expect(page.getByLabel("B2 편집 캔버스")).toBeVisible();
    await expect(page.getByRole("complementary", { name: "속성 패널" })).toBeVisible();
    await expect(page.getByRole("region", { name: "도면 버전" })).toBeVisible();

    const layout = await page.evaluate(() => ({
      viewportWidth: window.innerWidth,
      bodyWidth: document.body.scrollWidth,
      shellWidth: document.querySelector<HTMLElement>(".floor-editor-shell")?.getBoundingClientRect().width ?? 0
    }));
    expect(layout.bodyWidth).toBeLessThanOrEqual(layout.viewportWidth);
    expect(layout.shellWidth).toBeGreaterThan(viewport.width < 500 ? viewport.width - 40 : 800);

    await page.screenshot({ path: `test-results/task-9-${viewport.name}.png`, fullPage: true });
  });
}

async function mockEditorApi(page: Page) {
  await page.route("**/*", async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.startsWith("/api/")) return route.continue();
    const path = pathname.replace(/^\/api/, "");
    if (path === "/auth/me") {
      return route.fulfill({ json: { user: {
        id: "user-1", organizationId: "org-1", email: "admin@example.com",
        name: "관리자", role: "admin", status: "active"
      } } });
    }
    if (path === "/sites") return route.fulfill({ json: [{ id: "site-2", name: "물류센터" }] });
    if (path === "/sites/site-2/dashboard") {
      return route.fulfill({ json: {
        site: { id: "site-2", name: "물류센터" },
        summary: { totalFixtures: 1, onlineFixtures: 1, faultFixtures: 0, averageBrightness: 70 },
        floors: [{ id: "floor-b2", name: "B2", level: -2, floorPlan: editorState.floor.floorPlan, meshControlGroups: [], fixtures: [] }],
        groups: [],
        gateways: []
      } });
    }
    if (path === "/floors/floor-b2/editor-state") return route.fulfill({ json: editorState });
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
