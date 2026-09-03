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
    await expect(page.getByRole("heading", { name: "운영 현황" })).toBeVisible();

    const rail = page.locator(".sidebar");
    const bottomNav = page.locator(".bottom-nav");
    const topbar = page.locator(".topbar");

    if (viewport.width > 760) {
      await expect(rail).toBeVisible();
      await expect(bottomNav).toHaveCount(0);
      await expect(rail).toHaveCSS("width", "92px");
      await expect(topbar).toHaveCSS("min-height", "72px");
      await expect(page.locator(".brand-mark")).toBeVisible();
    } else {
      await expect(rail).toHaveCount(0);
      await expect(bottomNav).toBeVisible();
      await expect(bottomNav.locator(".nav-item")).toHaveCount(4);
      await expect(bottomNav).toHaveCSS("position", "fixed");
      await expectMinimumTouchTargets(page, ".bottom-nav");
      await expectMinimumTouchTargets(page, ".topbar-actions");

      const logoutBounds = await page.getByRole("button", { name: "로그아웃", exact: true }).boundingBox();
      expect(logoutBounds, "로그아웃 버튼의 실제 경계 상자").not.toBeNull();
      expect(logoutBounds!.width, "로그아웃 버튼 너비").toBeGreaterThanOrEqual(44);
      expect(logoutBounds!.height, "로그아웃 버튼 높이").toBeGreaterThanOrEqual(44);

      const geometry = await page.locator(".app-shell").evaluate((shell, selector) => {
        const navigation = document.querySelector(selector)?.getBoundingClientRect();
        const styles = getComputedStyle(shell);
        return {
          paddingBottom: Number.parseFloat(styles.paddingBottom),
          navigationHeight: navigation?.height ?? 0
        };
      }, ".bottom-nav");
      expect(geometry.paddingBottom).toBeGreaterThanOrEqual(geometry.navigationHeight);
    }

    await expect(bottomNav.locator(".nav-item.active")).toHaveCount(viewport.width <= 760 ? 1 : 0);
    await expect(page.locator(".topbar .status-pill")).toHaveAttribute("data-tone", "success");
    await expect(page.locator(".topbar .status-pill svg")).toHaveAttribute("aria-hidden", "true");
    await expectNoHorizontalOverflow(page);
  });
}

test("shell navigation updates when the viewport crosses the compact breakpoint", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await installSettingsApiRoutes(page, "admin");
  await page.goto("/monitoring?siteId=site-1");
  await expect(page.locator(".sidebar")).toBeVisible();

  await page.setViewportSize({ width: 390, height: 844 });

  await expect(page.locator(".sidebar")).toHaveCount(0);
  await expect(page.locator(".bottom-nav")).toBeVisible();
  await expect(page.locator(".bottom-nav .nav-item")).toHaveCount(4);
});
