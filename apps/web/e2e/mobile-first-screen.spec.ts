import { expect, test } from "@playwright/test";
import { installSettingsApiRoutes } from "./support/settings-api";
import { expectNoHorizontalOverflow } from "./support/layout-assertions";

for (const width of [320, 390, 430, 1280]) test(`common header and eager account at ${width}px`, async ({ page }) => {
  await page.setViewportSize({ width, height: width === 320 ? 568 : width === 390 ? 844 : 932 });
  await installSettingsApiRoutes(page, "viewer", { readyMapDocument: true });
  await page.goto("/settings?siteId=site-1");
  const header = page.locator("[data-shell-topbar]");
  const site = header.locator("[data-shell-context] button");
  const bell = header.getByRole("button", { name: /^알람센터/ });
  await expect(site).toBeVisible(); await expect(bell).toBeVisible();
  if (width < 760) {
    const siteBox = (await site.boundingBox())!; const bellBox = (await bell.boundingBox())!;
    expect(Math.abs(siteBox.y + siteBox.height / 2 - bellBox.y - bellBox.height / 2)).toBeLessThan(3);
    expect(siteBox.height).toBeGreaterThanOrEqual(44); expect(bellBox.height).toBeGreaterThanOrEqual(44);
  }
  await expect(page.getByRole("button", { name: "로그아웃", exact: true })).toBeVisible();
  await bell.click();
  await expect(page.getByRole("dialog", { name: "알람센터" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "최근 알림" })).toBeVisible();
  await page.getByRole("button", { name: "알람센터 닫기", exact: true }).click();
  await expectNoHorizontalOverflow(page);
});

test("monitoring compact disclosure and single center during full view", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await installSettingsApiRoutes(page, "admin", { readyMapDocument: true });
  await page.goto("/monitoring?siteId=site-1");
  const disclosure = page.getByRole("button", { name: "현장 전체 보기", exact: true });
  await expect(disclosure).toHaveAttribute("aria-expanded", "false");
  await disclosure.click(); await expect(page.getByRole("button", { name: "현장 전체 접기", exact: true })).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "현장 전체 접기", exact: true }).click();
  await page.getByRole("button", { name: "지도 전체 보기", exact: true }).click();
  await expect(page.locator("[data-shell-topbar]")).toBeHidden();
  await expect(page.getByRole("button", { name: "전체 보기 종료", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "알람센터", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "알람센터" })).toHaveCount(1);
  await page.getByRole("button", { name: "알람센터 닫기", exact: true }).click();
  await page.getByRole("button", { name: "전체 보기 종료", exact: true }).click();
  await expect(page.locator("[data-shell-topbar]")).toBeVisible();
  await expectNoHorizontalOverflow(page);
});
