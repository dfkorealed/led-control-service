import { expect, test } from "@playwright/test";
import { createRequire } from "node:module";
import { classifyLandingAxe, runLandingAxe } from "./support/landing-accessibility";
import { installDesignMemoryBoundary } from "./support/design-system-fixture";
const require = createRequire(import.meta.url);
test.use({ serviceWorkers: "block" });
const boundaries = new WeakMap<object, () => Promise<void>>();
test.beforeEach(async ({ context, baseURL }) => { boundaries.set(context, await installDesignMemoryBoundary(context, baseURL!)); });
test.afterEach(async ({ context }) => { await boundaries.get(context)!(); });

for (const [route, heading] of [["/", /현장의 하루.*한눈에 이어지다/], ["/features", "현장 운영에 필요한 네 가지 흐름"], ["/pricing", "현장에 맞는 운영 방식을 선택하세요."]] as const) {
  test(`standalone production ${route} direct load, reload and all contact actions`, async ({ page }) => {
    const api: string[] = [];
    page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) api.push(request.url()); });
    expect((await page.goto(route))!.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: heading })).toBeVisible();
    expect((await page.reload())!.status()).toBe(200);
    const prepared = page.getByRole("button", { name: "준비 중", exact: true });
    const configured = process.env.LANDING_EXPECT_SERVICE_URL;
    if (configured) await expect(page.getByRole("link", { name: /로그인/ })).toHaveAttribute("href", configured);
    else { await expect(prepared).toBeDisabled(); await expect(page.getByRole("link", { name: /로그인/ })).toHaveCount(0); }
    for (const trigger of await page.getByRole("button", { name: /도입 상담/ }).all()) {
      await trigger.focus(); await trigger.press("Enter");
      const dialog = page.getByRole("dialog", { name: "도입 상담" });
      await expect(dialog.getByRole("link", { name: "032-528-2953" })).toHaveAttribute("href", "tel:0325282953");
      await expect(dialog.getByRole("link", { name: "kymkjh2002@dfkorealed.com" })).toHaveAttribute("href", "mailto:kymkjh2002@dfkorealed.com");
      await expect(dialog.locator("form,input,textarea,select")).toHaveCount(0);
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("Escape"); await expect(trigger).toBeFocused();
      await expect(page).toHaveURL(new RegExp(`${route === "/" ? "/" : route}$`));
    }
    expect(api).toEqual([]);
  });
}

test("production unknown/internal/concept routes are true 404 public not-found", async ({ page, request, baseURL }) => {
  expect(new URL(baseURL!).port).toBe("15342");
  for (const path of ["/login", "/operator", "/control", "/api/auth/me", "/concepts/field-day.html", "/features/", "/unknown"]) {
    expect((await request.get(`${baseURL}${path}`)).status()).toBe(404);
    if (path.startsWith("/api/")) continue;
    expect((await page.goto(path))!.status()).toBe(404);
    await expect(page.getByRole("heading", { name: "페이지를 찾을 수 없습니다." })).toBeVisible();
    await expect(page.getByRole("link", { name: "킨다 홈으로" })).toHaveAttribute("href", "/");
  }
});

test("375px public pages and contact modal support touch, keyboard and axe", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, reducedMotion: "reduce", serviceWorkers: "block" });
  const closeBoundary = await installDesignMemoryBoundary(context, test.info().project.use.baseURL!);
  const page = await context.newPage();
  try {
    for (const route of ["/", "/features", "/pricing"]) {
      await page.goto(route);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
      const classified = await classifyLandingAxe(page, await runLandingAxe(page)); expect(classified.remaining).toEqual([]);
      await page.getByRole("button", { name: "도입 상담", exact: true }).first().tap();
      const dialog = page.getByRole("dialog", { name: "도입 상담" }); await expect(dialog).toBeVisible();
      const box = await dialog.boundingBox(); expect(box!.width).toBeLessThanOrEqual(375); expect(box!.height).toBeLessThanOrEqual(812);
      const modalAxe = await page.evaluate(async () => (await (window as unknown as { axe: { run: (scope: string) => Promise<{ violations: unknown[] }> } }).axe.run('[role="dialog"]')).violations);
      expect(modalAxe).toEqual([]);
      await page.keyboard.press("Escape");
      if (!process.env.LANDING_EXPECT_SERVICE_URL) {
        const prepared = page.getByRole("button", { name: "준비 중", exact: true }); await expect(prepared).toBeDisabled();
        await prepared.dispatchEvent("click"); await expect(page).toHaveURL(new RegExp(`${route}$`));
      }
    }
  } finally { await closeBoundary(); await context.close(); }
});
