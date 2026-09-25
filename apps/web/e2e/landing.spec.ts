import { expect, test } from "@playwright/test";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

for (const width of [1440, 1024, 390, 320]) {
  test(`public landing remains usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const authRequests: string[] = [];
    page.on("request", (request) => { if (request.url().includes("/auth/me")) authRequests.push(request.url()); });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("조명 운영을 간단하게.");
    await expect(page.getByRole("figure", { name: "제품 화면 예시" })).toBeVisible();
    await expect(page.getByText("제품 화면 예시", { exact: true })).toBeInViewport();
    expect(authRequests).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    for (const [name, anchor] of [["제품 소개", "product"], ["활용 안내", "benefits"], ["상담 문의", "contact"]]) {
      await page.getByRole("navigation", { name: "주요 메뉴" }).getByRole("link", { name }).click();
      await expect(page).toHaveURL(new RegExp(`#${anchor}$`));
      await expect(page.locator(`#${anchor}`)).toBeInViewport();
    }
    await page.goto("/");
    await page.getByRole("link", { name: "도입 상담하기" }).click();
    await expect(page).toHaveURL(/#contact$/);
    await expect(page.getByRole("heading", { name: /우리 현장에 맞는 시작/ })).toBeInViewport();

    // All real navigation controls provide a full, reachable 44px touch target.
    for (const link of await page.getByRole("link").all()) {
      if (await link.textContent() === "본문으로 이동") continue;
      await link.scrollIntoViewIfNeeded();
      const hitTarget = await link.evaluate((element) => {
        const bounds = element.getBoundingClientRect();
        const hit = document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        return { width: bounds.width, height: bounds.height, reachable: hit !== null && element.contains(hit) };
      });
      expect(hitTarget.width).toBeGreaterThanOrEqual(44);
      expect(hitTarget.height).toBeGreaterThanOrEqual(44);
      expect(hitTarget.reachable).toBe(true);
    }
    await page.goto("/");
    await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
    const accessibilityViolations = await page.evaluate(async () => {
      const axe = (window as unknown as { axe: { run(): Promise<{ violations: { id: string; impact: string }[] }> } }).axe;
      return (await axe.run()).violations.filter(({ impact }) => impact === "serious" || impact === "critical");
    });
    expect(accessibilityViolations).toEqual([]);
    const screenshotDir = resolve(".local/landing-visuals");
    await mkdir(screenshotDir, { recursive: true });
    await page.screenshot({ path: resolve(screenshotDir, `landing-${width}.png`), fullPage: true });
  });
}

test("keyboard navigation reaches content, product and contact with reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "본문으로 이동" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "도입 상담하기" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("#contact")).toBeFocused();
  const animatedElements = await page.locator("a").evaluateAll((elements) => elements.filter((element) => {
    const style = getComputedStyle(element);
    return style.transitionDuration !== "0s" || style.animationName !== "none";
  }).length);
  expect(animatedElements).toBe(0);
});
