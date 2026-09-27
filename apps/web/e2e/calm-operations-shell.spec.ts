import { expect, test } from "@playwright/test";
import {
  expectMinimumTouchTargets,
  expectNoHorizontalOverflow
} from "./support/layout-assertions";
import { installSettingsApiRoutes } from "./support/settings-api";

const responsiveViewports = [
  { width: 1440, height: 900 },
  { width: 1378, height: 1237 },
  { width: 1024, height: 768 },
  { width: 760, height: 844 },
  { width: 390, height: 844 },
  { width: 320, height: 720 }
] as const;

for (const viewport of responsiveViewports) {
  test(`calm operations shell keeps its rail and navigation contract at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const safeAreaBottom = viewport.width === 390 ? 20 : 0;
    if (safeAreaBottom > 0) {
      const session = await page.context().newCDPSession(page);
      await session.send("Emulation.setSafeAreaInsetsOverride", { insets: { bottom: safeAreaBottom } });
    }
    await installSettingsApiRoutes(page, "admin");
    await page.goto("/monitoring?siteId=site-1");
    await expect(page.getByRole("button", { name: "맵 선택" })).toBeVisible();

    const rail = page.locator('[data-shell-navigation="desktop"]');
    const bottomNav = page.locator('[data-shell-navigation="compact"]');
    const topbar = page.locator("[data-shell-topbar]");

    if (viewport.width >= 760) {
      await expect(rail).toBeVisible();
      await expect(bottomNav).toHaveCount(0);
      await expect(rail).toHaveCSS("width", "88px");
      await expect(topbar).toHaveCSS("min-height", "64px");
      await expect(topbar).toHaveCSS("position", "sticky");
      await expect(topbar).toHaveCSS("top", "0px");
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
      await expect(bottomNav).toHaveCSS("height", `${68 + safeAreaBottom}px`);
      await expect(bottomNav).toHaveCSS("padding-bottom", `${safeAreaBottom}px`);
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
      expect(paddingBottom).toBe(68 + safeAreaBottom);
      expect(navigationHeight).toBe(68 + safeAreaBottom);
    }

    await expect(page.getByRole("link", { name: "모니터링" })).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("shell-current-menu")).toHaveText("모니터링");
    await expect(page.getByTestId("active-site-badge")).toHaveText("고객사 B2 현장");
    await expect(page.getByTestId("active-floor-badge")).toHaveCount(0);
    await expect(page.getByRole("button", { name: /게이트웨이 .*상태 센터 열기/ })).toHaveCount(0);
    await expect(topbar.getByText(/게이트웨이 (정상|오프라인|미등록)/)).toHaveCount(0);
    const statusTrigger = page.getByRole("button", { name: /상태 센터, 미해결/ });
    await statusTrigger.click();
    const statusDrawer = page.getByRole("dialog", { name: "현재 세션 상태" });
    await expect(statusDrawer).toContainText("Gateway 연결");
    await statusDrawer.getByRole("button", { name: "상태 센터 닫기" }).click();
    await expect(statusTrigger).toBeFocused();
    await expectNoHorizontalOverflow(page);
  });
}

test("shell navigation updates when the viewport crosses the compact breakpoint", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await installSettingsApiRoutes(page, "admin");
  await page.goto("/monitoring?siteId=site-1");
  await expect(page.locator('[data-shell-navigation="desktop"]')).toBeVisible();

  await page.setViewportSize({ width: 760, height: 844 });
  await expect(page.locator('[data-shell-navigation="desktop"]')).toBeVisible();
  await expect(page.locator('[data-shell-navigation="compact"]')).toHaveCount(0);

  await page.setViewportSize({ width: 759, height: 844 });

  await expect(page.locator('[data-shell-navigation="desktop"]')).toHaveCount(0);
  const compactNavigation = page.locator('[data-shell-navigation="compact"]');
  await expect(compactNavigation).toBeVisible();
  await expect(compactNavigation.getByRole("link")).toHaveCount(4);
});

test("shell titles follow the current customer route", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await installSettingsApiRoutes(page, "admin");

  for (const [path, title] of [
    ["/monitoring?siteId=site-1", "모니터링"],
    ["/control?siteId=site-1", "제어"],
    ["/statistics/overview?siteId=site-1", "통계"],
    ["/settings?siteId=site-1", "설정"]
  ] as const) {
    await page.goto(path);
    await expect(page.getByTestId("shell-current-menu")).toHaveText(title);
    await expect(page.getByText("현장 관제", { exact: true })).toHaveCount(0);
  }
});

test("sticky topbar does not cover settings content at desktop atlas widths", async ({ page }) => {
  await installSettingsApiRoutes(page, "admin");
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1378, height: 1237 }]) {
    await page.setViewportSize(viewport);
    for (const path of ["/settings?siteId=site-1", "/settings/site?siteId=site-1"] as const) {
      await page.goto(path);
      const contentTarget = page.locator("[data-shell-content] h1, [data-shell-content] h2, [data-shell-content] [data-page-header]").first();
      await expect(contentTarget).toBeVisible();
      const topbarBox = await page.locator("[data-shell-topbar]").boundingBox();
      const firstContentBox = await page.locator("[data-shell-content] > *").first().boundingBox();
      expect(topbarBox).not.toBeNull();
      expect(firstContentBox).not.toBeNull();
      expect(firstContentBox!.y).toBeGreaterThanOrEqual(topbarBox!.y + topbarBox!.height);
      const hitEvidence = await contentTarget.evaluate((target) => {
        const topbar = document.querySelector<HTMLElement>("[data-shell-topbar]");
        if (!topbar) return { passes: false, reason: "missing-topbar", target: target.tagName, hit: null };
        const rect = target.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.left + Math.min(8, rect.width / 2), rect.top + Math.min(8, rect.height / 2));
        return {
          passes: Boolean(hit && !topbar.contains(hit) && (hit === target || target.contains(hit))),
          reason: "measured",
          target: `${target.tagName}.${target.className}`,
          hit: hit ? `${hit.tagName}.${(hit as HTMLElement).className}` : null,
          targetRect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          topbarRect: topbar.getBoundingClientRect().toJSON()
        };
      });
      expect(hitEvidence, JSON.stringify(hitEvidence)).toMatchObject({ passes: true });
    }
  }
});

test("320px content can scroll above the fixed bottom navigation", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await installSettingsApiRoutes(page, "admin");
  await page.goto("/settings/site?siteId=site-1");
  const appShell = page.locator("[data-app-shell]");
  const bottomNavigation = page.locator('[data-shell-navigation="compact"]');
  const bottomNavigationBox = await bottomNavigation.boundingBox();
  expect(bottomNavigationBox).not.toBeNull();
  expect(await appShell.evaluate((element) => Number.parseFloat(getComputedStyle(element).paddingBottom)))
    .toBeGreaterThanOrEqual(bottomNavigationBox!.height);
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const lastVisibleControl = page.locator('[data-shell-content] :is(a,button,input,select,textarea):visible').last();
  const lastVisibleControlBox = await lastVisibleControl.boundingBox();
  expect(lastVisibleControlBox).not.toBeNull();
  expect(lastVisibleControlBox!.y + lastVisibleControlBox!.height).toBeLessThanOrEqual(bottomNavigationBox!.y);
  await expectNoHorizontalOverflow(page);
});
