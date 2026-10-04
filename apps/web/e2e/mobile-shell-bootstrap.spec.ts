import { expect, test } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./support/layout-assertions";

for (const width of [320, 390]) test(`native late bootstrap does not block window load or mount before handshake at${width}px`, async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, viewport: { width, height: 844 }, isMobile: true, hasTouch: true, userAgent: "Mobile LEDControlNative/1" });
  const page = await context.newPage(); let authReads = 0;
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await page.route("**/api/auth/me", route => { authReads++; return route.fulfill({ status: 401, json: { message: "unauthorized" } }); });
    // Real native early injection supplies markers only. onLoadEnd cannot run
    // until load; a top-level-await handshake would deadlock this exact flow.
    await page.addInitScript(() => document.addEventListener("DOMContentLoaded", () => {
      document.documentElement.dataset.ledControlNativeSafeArea = "true";
    }));
    await page.goto("/login", { waitUntil: "load" });
    await expect(page.getByRole("status")).toHaveText("앱 연결을 준비하고 있습니다."); expect(authReads).toBe(0);
    await page.evaluate(() => {
      const host = window as Window & { ReactNativeWebView?: { postMessage(raw: string): void }; __LED_CONTROL_NATIVE_DOCUMENT_ID__?: string; __LED_CONTROL_NATIVE_ENVIRONMENT__?: unknown };
      const environment = { version: 1, type: "mobile.bootstrap", documentId: "fresh-doc", requestId: "native-bootstrap", mobile: true, state: "active", online: true };
      host.ReactNativeWebView = { postMessage() {} }; host.__LED_CONTROL_NATIVE_DOCUMENT_ID__ = "fresh-doc"; host.__LED_CONTROL_NATIVE_ENVIRONMENT__ = environment;
      window.dispatchEvent(new CustomEvent("led-control:native-message", { detail: environment }));
    });
    const input = page.getByRole("textbox", { name: "아이디", exact: true });
    await expect(input).toBeVisible(); expect(authReads).toBeGreaterThan(0);
    expect(await input.evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(16);
    await input.tap(); await input.fill("mobile-user"); await expect(input).toHaveValue("mobile-user");
    const login = page.getByRole("button", { name: "로그인", exact: true }); const box = await login.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44);
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--led-control-safe-area-bottom").trim())).toBe("0px");
    await expectNoHorizontalOverflow(page); expect(errors).toEqual([]);
  } finally { await context.close(); }
});

test("native preparation timeout offers reload without mounting an authenticated app", async ({ browser, baseURL }) => {
  const context = await browser.newContext({ baseURL, userAgent: "LEDControlNative/1" }); const page = await context.newPage(); let requests = 0;
  const errors: string[] = []; page.on("pageerror", error => errors.push(error.message));
  try {
    await page.route("**/api/**", route => {
      // Vite source URLs also contain /src/api/. Mock only actual API routes.
      if (!new URL(route.request().url()).pathname.startsWith("/api/")) return route.continue();
      requests++; return route.fulfill({ status: 401, json: {} });
    });
    await page.goto("/login", { waitUntil: "load" });
    await expect(page.getByRole("status")).toContainText("앱 연결을 준비하고 있습니다.").catch(error => { throw new Error(`${error.message}\npage errors: ${errors.join("; ")}`); });
    await expect(page.getByRole("alert")).toContainText("앱 연결을 준비하지 못했습니다.", { timeout: 15_000 }).catch(error => { throw new Error(`${error.message}\npage errors: ${errors.join("; ")}`); });
    await expect(page.getByRole("button", { name: "다시 연결" })).toBeVisible(); expect(requests).toBe(0);
  } finally { await context.close(); }
});
