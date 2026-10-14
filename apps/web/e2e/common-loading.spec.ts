import { expect, test, type Locator } from "@playwright/test";
import { installSettingsApiRoutes } from "./support/settings-api";
import { expectNoHorizontalOverflow } from "./support/layout-assertions";

function gate() {
  let release!: () => void;
  const pending = new Promise<void>(resolve => { release = resolve; });
  return { pending, release };
}

async function expectSpinner(status: Locator, reduced: boolean) {
  await expect(status).toHaveAttribute("aria-busy", "true");
  const icon = status.locator("svg");
  await expect(icon).toHaveAttribute("aria-hidden", "true");
  await expect(icon).toHaveCSS("width", "20px");
  await expect(icon).toHaveCSS("animation-name", reduced ? "none" : "spin");
}

for (const surface of [
  { width: 1440, height: 900, reduced: false },
  { width: 390, height: 844, reduced: false },
  { width: 320, height: 600, reduced: false },
  { width: 320, height: 600, reduced: true }
]) {
  test(`shared route/list/action loading settles without resizing its icon button ${surface.width} reduced=${surface.reduced}`, async ({ page }, info) => {
    await page.setViewportSize(surface);
    await page.emulateMedia({ reducedMotion: surface.reduced ? "reduce" : "no-preference" });
    const api = await installSettingsApiRoutes(page, "operator");
    const routeGate = gate(), listGate = gate(), logoutGate = gate();
    await page.route("**/src/features/operator/OperatorShell.tsx*", async route => { await routeGate.pending; await route.continue(); });
    await page.route("**/api/bio-sensor-profiles", async route => { await listGate.pending; await route.fulfill({ json: [] }); });
    await page.route("**/api/auth/logout", async route => { await logoutGate.pending; await route.fallback(); });
    try {
      await page.goto("/operator/sensor-profiles", { waitUntil: "domcontentloaded" });
      const routeStatus = page.getByRole("status").filter({ hasText: "화면을 불러오는 중입니다." });
      await expect(routeStatus).toBeVisible();
      await expect(page.getByRole("main")).toHaveCount(1);
      await expectSpinner(routeStatus, surface.reduced);
      routeGate.release();
      const listStatus = page.getByRole("status").filter({ hasText: "프로파일 목록을 불러오는 중입니다." });
      await expect(listStatus).toBeVisible();
      await expectSpinner(listStatus, surface.reduced);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath("list-pending.png") });
      listGate.release();
      await expect(page.getByText(/승인된 호환 프로파일이 없습니다/)).toBeVisible();
      await expect(listStatus).toHaveCount(0);
      const logout = page.getByRole("button", { name: "로그아웃", exact: true });
      const frame = await logout.boundingBox();
      expect(frame?.width).toBeGreaterThanOrEqual(44);
      expect(frame?.height).toBeGreaterThanOrEqual(44);
      await logout.click();
      const busy = page.getByRole("button", { name: "로그아웃 중", exact: true });
      await expect(busy).toBeDisabled();
      await expectSpinner(busy, surface.reduced);
      expect(await busy.boundingBox()).toEqual(frame);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath("action-pending.png") });
      logoutGate.release();
      await expect(page.getByRole("heading", { name: "킨다 로그인" })).toBeVisible();
      expect(api.logoutRequests).toBe(1);
      expect(api.dimmingRequests).toHaveLength(0);
    } finally {
      routeGate.release(); listGate.release(); logoutGate.release();
    }
  });

  test(`shared map pending preserves first-paint gating and list failure is not a spinner ${surface.width} reduced=${surface.reduced}`, async ({ page }, info) => {
    await page.setViewportSize(surface);
    await page.emulateMedia({ reducedMotion: surface.reduced ? "reduce" : "no-preference" });
    const api = await installSettingsApiRoutes(page, "viewer");
    const mapGate = gate(), imageGate = gate();
    await page.route("**/api/sites/site-1/floors/floor-1/map-snapshot", async route => { await mapGate.pending; await route.fallback(); });
    await page.route("**/demo/floor-b2.svg", async route => { await imageGate.pending; await route.fallback(); });
    try {
      await page.goto("/monitoring?siteId=site-1", { waitUntil: "domcontentloaded" });
      const loading = page.getByRole("status").filter({ hasText: "맵을 불러오는 중입니다." });
      await expect(loading).toHaveCount(1);
      await expectSpinner(loading, surface.reduced);
      mapGate.release();
      await expect(page.getByTestId("monitoring-map-viewport")).toBeVisible();
      await expect(loading).toHaveCount(1);
      await page.screenshot({ path: info.outputPath("map-pending.png") });
      imageGate.release();
      await expect(loading).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
      expect(api.dimmingRequests).toHaveLength(0);
    } finally {
      mapGate.release(); imageGate.release();
    }
    // A new principal is a fresh document. Keep the real default query retry
    // policy and wait for its fourth/final response before checking the error;
    // the first response does not mean the retry lifecycle has completed.
    await installSettingsApiRoutes(page, "operator");
    const failedList = gate();
    await page.route("**/api/bio-sensor-profiles", async route => { await failedList.pending; await route.fulfill({ status: 400, json: { message: "synthetic list failure" } }); });
    try {
      await page.goto("/operator/sensor-profiles", { waitUntil: "domcontentloaded" });
      const pending = page.getByRole("status").filter({ hasText: "프로파일 목록을 불러오는 중입니다." });
      await expect(pending).toBeVisible();
      let responses = 0;
      const exhausted = page.waitForResponse(response => new URL(response.url()).pathname === "/api/bio-sensor-profiles" && ++responses === 4);
      failedList.release();
      await exhausted;
      await expect(page.getByRole("alert")).toContainText("프로파일 목록을 불러오지 못했습니다.");
      await expect(pending).toHaveCount(0);
      await expectNoHorizontalOverflow(page);
      await page.screenshot({ path: info.outputPath("list-error.png") });
    } finally { failedList.release(); }
  });
}
