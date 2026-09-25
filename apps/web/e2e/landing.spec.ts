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

async function fillInquiry(page: import("@playwright/test").Page) {
  await page.goto("/#contact");
  await page.getByRole("textbox", { name: "회사명" }).fill("  킨다 시설  ");
  await page.getByRole("textbox", { name: "담당자 이름" }).fill("홍길동");
  await page.getByRole("textbox", { name: "회신 이메일" }).fill("owner@example.com");
  await page.getByRole("textbox", { name: "문의 내용" }).fill("B2 주차장 조명 상담");
  await page.getByRole("checkbox", { name: /개인정보 수집·이용에 동의/ }).press("Space");
}

test("consultation submits exact public payload and shows server reference", async ({ page }) => {
  const posted: Record<string, unknown>[] = [];
  await page.route("**/api/landing/inquiries", async (route) => {
    posted.push(route.request().postDataJSON());
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ reference: "KI-120", status: "received" }) });
  });
  await fillInquiry(page);
  await page.getByRole("button", { name: "상담 문의 보내기" }).click();
  await expect(page.getByText(/접수번호: KI-120/)).toBeVisible();
  expect(posted).toHaveLength(1);
  expect(posted[0]).toEqual({
    idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/i), companyName: "킨다 시설", contactName: "홍길동",
    email: "owner@example.com", phone: "", audience: null, message: "B2 주차장 조명 상담",
    consent: true, consentVersion: "landing-2026-09-v1-90d", website: ""
  });
  await expect(page.getByRole("button", { name: "상담 문의 보내기" })).toBeDisabled();
});

for (const [status, heading, offersMail] of [
  [429, "요청이 많습니다.", false],
  [503, "현재 온라인 상담을 접수할 수 없습니다.", true]
] as const) {
  test(`consultation ${status} preserves content with distinct recovery`, async ({ page }) => {
    await page.route("**/api/landing/inquiries", (route) => route.fulfill({ status, contentType: "application/json", body: "{}" }));
    await fillInquiry(page);
    await page.getByRole("button", { name: "상담 문의 보내기" }).click();
    await expect(page.getByRole("alert")).toContainText(heading);
    await expect(page.getByRole("textbox", { name: "회사명" })).toHaveValue("  킨다 시설  ");
    const mail = page.getByRole("link", { name: "이메일로 직접 문의하기" });
    if (offersMail) await expect(mail).toHaveAttribute("href", "mailto:kymkjh2002@dfkorealed.com");
    else await expect(mail).toHaveCount(0);
  });
}

test("consultation timeout retains key for retry and changes it after an edit", async ({ page }) => {
  const posted: Record<string, unknown>[] = [];
  let attempt = 0;
  await page.route("**/api/landing/inquiries", async (route) => {
    posted.push(route.request().postDataJSON());
    attempt += 1;
    if (attempt === 1) {
      // Keep the first response unresolved beyond the form's deadline to model a lost response.
      await new Promise((resolve) => setTimeout(resolve, 16_000));
      await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ reference: "KI-LATE", status: "received" }) }).catch(() => undefined);
      return;
    }
    if (attempt === 2) {
      await route.fulfill({ status: 500, contentType: "application/json", body: "{}" });
      return;
    }
    await route.fulfill({ status: 201, contentType: "application/json", body: JSON.stringify({ reference: "KI-NEW", status: "received" }) });
  });
  await fillInquiry(page);
  await page.getByRole("button", { name: "상담 문의 보내기" }).click();
  await expect(page.getByRole("button", { name: "접수 중" })).toBeDisabled();
  await expect(page.getByRole("alert")).toContainText("접수 결과를 확인하지 못했습니다.", { timeout: 20_000 });
  await expect(page.getByRole("textbox", { name: "문의 내용" })).toHaveValue("B2 주차장 조명 상담");
  await page.getByRole("button", { name: "상담 문의 보내기" }).click();
  await expect(page.getByRole("alert")).toContainText("접수 결과를 확인하지 못했습니다.");
  expect(posted[1].idempotencyKey).toBe(posted[0].idempotencyKey);
  await page.getByRole("textbox", { name: "문의 내용" }).fill("변경한 상담 내용");
  await page.getByRole("button", { name: "상담 문의 보내기" }).click();
  await expect(page.getByText(/접수번호: KI-NEW/)).toBeVisible();
  expect(posted[2].idempotencyKey).not.toBe(posted[0].idempotencyKey);
});
