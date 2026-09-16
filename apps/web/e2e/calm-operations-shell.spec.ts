import { expect, test } from "@playwright/test";
import {
  expectMinimumTouchTargets,
  expectNoHorizontalOverflow
} from "./support/layout-assertions";
import { installSettingsApiRoutes } from "./support/settings-api";

const responsiveViewports = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 320, height: 740 }
] as const;

for (const viewport of responsiveViewports) {
  test(`calm operations shell keeps its rail and navigation contract at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installSettingsApiRoutes(page, "admin");
    await page.goto("/monitoring?siteId=site-1");
    await expect(page.getByRole("button", { name: "맵 선택" })).toBeVisible();

    const rail = page.locator('[data-shell-navigation="desktop"]');
    const bottomNav = page.locator('[data-shell-navigation="compact"]');
    const topbar = page.locator("[data-shell-topbar]");

    if (viewport.width > 760) {
      await expect(rail).toBeVisible();
      await expect(bottomNav).toHaveCount(0);
      await expect(rail).toHaveCSS("width", "96px");
      await expect(topbar).toHaveCSS("min-height", "64px");
      await expect(page.getByRole("img", { name: "킨다 관제 센터" })).toBeVisible();

      const [railBounds, logoMarkBounds, navigationItemBounds] = await Promise.all([
        rail.boundingBox(),
        rail.locator("[data-kinda-logo-mark]").boundingBox(),
        rail.locator("[data-shell-navigation-item]").first().boundingBox()
      ]);
      expect(railBounds, "데스크톱 사이드바의 실제 경계 상자").not.toBeNull();
      expect(logoMarkBounds, "데스크톱 로고 마크의 실제 경계 상자").not.toBeNull();
      expect(navigationItemBounds, "데스크톱 탐색 항목의 실제 경계 상자").not.toBeNull();
      const railCenter = railBounds!.x + railBounds!.width / 2;
      const logoCenter = logoMarkBounds!.x + logoMarkBounds!.width / 2;
      const navigationCenter = navigationItemBounds!.x + navigationItemBounds!.width / 2;
      expect(Math.abs(logoCenter - railCenter), "로고와 사이드바 중심선의 거리").toBeLessThanOrEqual(0.5);
      expect(Math.abs(logoCenter - navigationCenter), "로고와 탐색 항목 중심선의 거리").toBeLessThanOrEqual(0.5);

      const logout = page.getByRole("button", { name: "로그아웃", exact: true });
      await logout.hover();
      const tooltip = page.getByRole("tooltip", { name: "로그아웃" });
      await expect(tooltip).toBeVisible();
      await tooltip.hover();
      await expect(tooltip).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(tooltip).toHaveCount(0);

      await page.mouse.move(0, 0);
      await logout.focus();
      await expect(tooltip).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(tooltip).toHaveCount(0);
    } else {
      await expect(rail).toHaveCount(0);
      await expect(bottomNav).toBeVisible();
      await expect(bottomNav.getByRole("link")).toHaveCount(4);
      await expect(bottomNav).toHaveCSS("position", "fixed");
      await expectMinimumTouchTargets(page, '[data-shell-navigation="compact"]');
      await expectMinimumTouchTargets(page, "[data-shell-actions]");

      const logoutBounds = await page.getByRole("button", { name: "로그아웃", exact: true }).boundingBox();
      expect(logoutBounds, "로그아웃 버튼의 실제 경계 상자").not.toBeNull();
      expect(logoutBounds!.width, "로그아웃 버튼 너비").toBeGreaterThanOrEqual(44);
      expect(logoutBounds!.height, "로그아웃 버튼 높이").toBeGreaterThanOrEqual(44);

      const logout = page.getByRole("button", { name: "로그아웃", exact: true });
      await logout.focus();
      const tooltip = page.getByRole("tooltip", { name: "로그아웃" });
      await expect(tooltip).toBeVisible();
      await expectNoHorizontalOverflow(page);
      await page.keyboard.press("Escape");
      await expect(tooltip).toHaveCount(0);

      const navigationHeight = (await bottomNav.boundingBox())?.height ?? 0;
      const paddingBottom = await page.locator("[data-app-shell]").evaluate((shell) => {
        const styles = getComputedStyle(shell);
        return Number.parseFloat(styles.paddingBottom);
      });
      expect(paddingBottom).toBeGreaterThanOrEqual(navigationHeight);
    }

    await expect(page.getByRole("link", { name: "모니터링" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("active-site-badge")).toHaveText("고객사 B2 현장");
    await expect(page.getByTestId("active-floor-badge")).toHaveCount(0);
    await expect(topbar.getByText(/게이트웨이 (정상|오프라인|미등록)/)).toHaveCount(0);
    await expectNoHorizontalOverflow(page);
  });
}

test("shell navigation updates when the viewport crosses the compact breakpoint", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await installSettingsApiRoutes(page, "admin");
  await page.goto("/monitoring?siteId=site-1");
  await expect(page.locator('[data-shell-navigation="desktop"]')).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });

  await expect(page.locator('[data-shell-navigation="desktop"]')).toHaveCount(0);
  const compactNavigation = page.locator('[data-shell-navigation="compact"]');
  await expect(compactNavigation).toBeVisible();
  await expect(compactNavigation.getByRole("link")).toHaveCount(4);
});
