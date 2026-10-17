import { test, expect, withFoundationFixture } from "./support/design-system-fixture";

test("fixture blocks unknown API and external POST", async ({ page }) => {
  test.info().annotations.push({ type: "boundary-sentinels", description: JSON.stringify(["API GET /api/not-configured", "EXTERNAL POST https://blocked.invalid/"]) });
  await page.goto("/");
  const result = await page.evaluate(async () => ({
    api: await fetch("/api/not-configured").then(r => r.status),
    external: await fetch("https://blocked.invalid/", { method: "POST" }).then(() => "sent", () => "blocked")
  }));
  expect(result).toEqual({ api: 404, external: "blocked" });
});

test("fixture blocks WebSocket and sendBeacon", async ({ page }) => {
  test.info().annotations.push({ type: "boundary-sentinels", description: JSON.stringify(["WebSocket", "sendBeacon"]) });
  await page.goto("/");
  expect(await page.evaluate(() => {
    let socket = "sent";
    try { new WebSocket("wss://blocked.invalid/"); } catch { socket = "blocked"; }
    return { socket, beacon: navigator.sendBeacon("https://blocked.invalid/", "payload") };
  })).toEqual({ socket: "blocked", beacon: false });
});

test("fixture reports same-host non-HMR sockets while real Vite boot stays exempt", async ({ page }) => {
  test.info().annotations.push({ type: "boundary-sentinels", description: JSON.stringify(["WebSocket", "WebSocket", "WebSocket"]) });
  await page.goto("/");
  // Actual /@vite/client boots before this evaluation; its denied handshake
  // must not pollute the sentinel list. A product cannot borrow its hostname.
  expect(await page.evaluate(() => [
    [`ws://${location.host}/product-live`, undefined],
    [`ws://${location.host}/`, "product-live"],
    [`ws://${location.host}/product-live`, "vite-hmr"]
  ].map(([url, protocol]) => {
    try { new WebSocket(url!, protocol); return "sent"; } catch { return "blocked"; }
  }))).toEqual(["blocked", "blocked", "blocked"]);
});

test("fixture rejects unsupported theme setup", async ({ designScenario }) => {
  await expect(designScenario({ principal: "admin", state: "ready", theme: "sepia" as "light" })).rejects.toThrow("Unsupported design theme");
});

test("fixture keeps registered page routes ahead of the context boundary", async ({ page }) => {
  await page.route("**/api/design-fixture-known", route => route.fulfill({ json: { ready: true } }));
  await page.goto("/");
  expect(await page.evaluate(() => fetch("/api/design-fixture-known").then(response => response.json()))).toEqual({ ready: true });
});

test("fixture guards manually created touch contexts before their first request", async ({ browser, baseURL }) => {
  test.info().annotations.push({ type: "boundary-sentinels", description: JSON.stringify(["API GET /api/not-configured"]) });
  const context = await browser.newContext({ baseURL, isMobile: true, hasTouch: true });
  try {
    const page = await context.newPage();
    await page.goto("/");
    expect(await page.evaluate(() => fetch("/api/not-configured").then(response => response.status))).toBe(404);
  } finally { await context.close(); }
});

test("functional computed spacing typography and actual control size", async ({ page }) => {
  await withFoundationFixture(page, async () => {
    for (const width of [320, 390, 759, 760, 1024, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByTestId("page-stack")).toHaveCSS("gap", "20px");
      await expect(page.getByTestId("card-grid")).toHaveCSS("gap", "18px");
      for (const name of ["regular-panel", "customer-panel", "side-panel"]) {
        await expect(page.getByTestId(name)).toHaveCSS("padding", width < 760 ? "16px" : "20px");
      }
      await expect(page.getByTestId("compact-panel")).toHaveCSS("padding", "16px");
      await expect(page.getByTestId("none-panel")).toHaveCSS("padding", "0px");
      await expect(page.getByRole("heading", { name: "페이지", level: 1 })).toHaveCSS("font-size", width < 760 ? "24px" : "26px");
      await expect(page.getByRole("heading", { name: "페이지", level: 1 })).toHaveCSS("line-height", width < 760 ? "32px" : "35.1px");
      await expect(page.getByRole("heading", { name: "구역", level: 3 })).toHaveCSS("font-size", "20px");
      await expect(page.getByRole("heading", { name: "구역", level: 3 })).toHaveCSS("line-height", "28px");
      await expect(page.getByRole("heading", { name: "작은 카드", level: 4 })).toHaveCSS("font-size", "16px");
      await expect(page.getByRole("heading", { name: "작은 카드", level: 4 })).toHaveCSS("line-height", "24px");
      for (const name of ["확인", "md", "lg", "아이콘", "큰 아이콘", "큰 버튼"]) {
        const button = page.getByRole("button", { name, exact: true });
        await button.scrollIntoViewIfNeeded();
        const box = (await button.boundingBox())!;
        expect(box.width, `${width}px ${name} width`).toBeGreaterThanOrEqual(name === "큰 아이콘" || name === "큰 버튼" ? 52 : 44);
        expect(box.height, `${width}px ${name} height`).toBeGreaterThanOrEqual(name === "큰 아이콘" || name === "큰 버튼" ? 52 : name === "lg" ? 48 : 44);
        expect(await button.evaluate(element => {
          const rect = element.getBoundingClientRect();
          return [[4, 4], [rect.width - 4, 4], [4, rect.height - 4], [rect.width - 4, rect.height - 4], [rect.width / 2, rect.height / 2]]
            .every(([x, y]) => { const hit = document.elementFromPoint(rect.x + x, rect.y + y); return hit === element || !!hit && element.contains(hit); });
        }), `${width}px ${name} visible hit points`).toBe(true);
      }
      const confirm = page.getByRole("button", { name: "확인", exact: true });
      await confirm.click();
      expect(await page.evaluate(() => (window as unknown as { foundationClicks: number }).foundationClicks)).toBe([320, 390, 759, 760, 1024, 1440].indexOf(width) + 1);
      await expect(page.getByRole("button", { name: "브랜드 점" })).toHaveCSS("width", "18px");
    }
  });
});
