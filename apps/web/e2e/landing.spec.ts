import { expect, test } from "@playwright/test";
import { installSettingsApiRoutes } from "./support/settings-api";
import { mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

for (const width of [1440, 1024, 390, 320]) {
  test(`public landing remains usable at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const authRequests: string[] = [];
    page.on("request", request => {
      const pathname = new URL(request.url()).pathname;
      if (pathname === "/api/auth/me") authRequests.push(pathname);
    });
    await page.goto("/");
    await expect(page.getByRole("heading", { level: 1, name: /현장의 하루.*한눈에 이어지다/ })).toBeVisible();
    await expect(page.locator(".scene")).toHaveCount(5);
    await expect(page.locator(".site-header")).toHaveCSS("position", "fixed");
    await expect(page.locator(".hero-copy__second-line")).toHaveCSS("display", "block");
    await expect(page.locator(".hero-contact")).toHaveCSS("border-top-width", "0px");
    await expect(page.locator(".hero-contact")).toHaveCSS("line-height", "22px");
    await expect(page.locator(".header-contact")).toHaveCSS("line-height", "22px");
    await expect(page.locator(".hero h1")).toHaveCSS("font-size", width <= 430 ? "46px" : width === 1024 ? "55px" : "76.32px");
    await expect(page.getByRole("link", { name: /로그인/ })).toHaveAttribute("href", "/login");
    for (const id of ["monitoring", "control", "statistics", "report", "map-editor"]) {
      await expect(page.locator(`#${id}`)).toBeVisible();
    }
    expect(authRequests).toEqual([]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

    await page.getByRole("button", { name: "도입 상담", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "도입 상담" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText(/90일간 보관/)).toBeVisible();
    const viewport = page.viewportSize()!;
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.height).toBeLessThanOrEqual(viewport.height);
    await expect(dialog).toHaveCSS("border-radius", "14px");
    await expect(dialog).toHaveCSS("overflow-y", "auto");
    const submit = dialog.getByRole("button", { name: "상담 문의 보내기" });
    await submit.focus();
    await expect(submit).toBeFocused();
    await expect(submit).toBeInViewport();
    await dialog.getByRole("button", { name: "상담 팝업 닫기" }).click();
    await expect(page.getByRole("button", { name: "도입 상담", exact: true }).first()).toBeFocused();

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
    const violations = await page.evaluate(async () => {
      const axe = (window as unknown as { axe: { run(): Promise<{ violations: { id: string; impact: string; nodes: { target: string[] }[] }[] }> } }).axe;
      return (await axe.run()).violations.filter(({ impact }) => impact === "serious" || impact === "critical")
        .map(({ id, nodes }) => ({ id, targets: nodes.map(({ target }) => target) }));
    });
    expect(violations).toEqual([]);
    const screenshotDir = resolve(".local/landing-visuals");
    await mkdir(screenshotDir, { recursive: true });
    await page.screenshot({ path: resolve(screenshotDir, `landing-${width}.png`), fullPage: true });
  });
}

test("reduced motion keeps examples complete and keyboard can open the inquiry", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.getByRole("link", { name: "본문으로 이동" })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("main")).toBeFocused();
  await page.getByRole("button", { name: "도입 상담", exact: true }).first().focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("dialog", { name: "도입 상담" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "도입 상담" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "도입 상담", exact: true }).first()).toBeFocused();
  await expect(page.locator("#statistics .chart-line")).toHaveCSS("stroke-dashoffset", "0px");
});

async function fillInquiry(page: import("@playwright/test").Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "도입 상담", exact: true }).first().click();
  await expect(page.getByRole("dialog", { name: "도입 상담" })).toBeVisible();
  await expect(page.getByRole("button", { name: /고객 유형/ })).toContainText("선택해 주세요");
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
  await expect(page.getByRole("button", { name: "상담 문의 보내기" })).toHaveAttribute("aria-disabled", "true");
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
  await expect(page.getByRole("button", { name: "접수 중" })).toHaveAttribute("aria-disabled", "true");
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

test("authenticated operator can inspect inquiry delivery without starting OAuth or resending", async ({ page }) => {
  const calls: string[] = [];
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    calls.push(`${request.method()} ${url.pathname}`);
    if (url.pathname === "/api/auth/me") return route.fulfill({ json: { user: {
      id: "operator-1", organizationId: "provider-1", organizationType: "service_provider",
      loginId: "operator", name: "운영자", role: "operator", status: "active", mustChangePassword: false
    } } });
    if (url.pathname === "/api/operator/landing-mail/status") return route.fulfill({ json: { connected: false } });
    if (url.pathname === "/api/operator/landing-inquiries") return route.fulfill({ json: { items: [{
      reference: "K-E2E-1", companyName: "예시 시설", contactName: "담당자", email: "reply@example.com",
      phone: "", audience: "facility", message: "상담 내용", createdAt: "2026-09-25T00:00:00.000Z",
      expiresAt: "2026-12-24T00:00:00.000Z", deliveryStatus: "delivery_uncertain", attemptCount: 1,
      lastErrorCode: "MAIL_ACCEPTANCE_UNKNOWN", providerAcceptedAt: null
    }], nextCursor: null } });
    if (url.pathname === "/api/operator/landing-mail/authorize") return route.fulfill({ json: { authorizationUrl: "https://evil.example/authorize" } });
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/operator/landing-inquiries");
  await expect(page.getByRole("heading", { name: "상담 문의 관리" })).toBeVisible();
  await expect(page.getByText("K-E2E-1")).toBeVisible();
  await expect(page.getByText("수락 여부 불확실", { exact: true })).toBeVisible();
  await expect(page.getByText(/받은편지함 도착을 뜻하지 않습니다/)).toBeVisible();
  await expect(page.getByRole("button", { name: /재발송/ })).toHaveCount(0);
  expect(calls).not.toContain("POST /api/operator/landing-mail/authorize");
  await page.getByRole("button", { name: "NAVER WORKS 연결" }).click();
  await expect(page.getByRole("alert")).toContainText("연결을 시작하지 못했습니다");
  await expect(page).toHaveURL(/\/operator\/landing-inquiries$/);
  expect(calls).toContain("POST /api/operator/landing-mail/authorize");
});

test("connected operator can reconnect and return after a later inquiry page fails", async ({ page }) => {
  let authorizations = 0;
  await page.route("**/api/**", async route => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/auth/me") return route.fulfill({ json: { user: {
      id: "operator-1", organizationId: "provider-1", organizationType: "service_provider",
      loginId: "operator", name: "운영자", role: "operator", status: "active", mustChangePassword: false
    } } });
    if (url.pathname === "/api/operator/landing-mail/status") return route.fulfill({ json: { connected: true } });
    if (url.pathname === "/api/operator/landing-inquiries") return url.searchParams.has("cursor")
      ? route.fulfill({ status: 503, json: {} }) : route.fulfill({ json: { items: [], nextCursor: "unavailable-page" } });
    if (url.pathname === "/api/operator/landing-mail/authorize") {
      authorizations += 1;
      return route.fulfill({ status: 503, json: {} });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("/operator/landing-inquiries");
  await expect(page.getByText("연결됨", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "NAVER WORKS 다시 연결" })).toBeEnabled();
  expect(authorizations).toBe(0);
  await page.getByRole("button", { name: "NAVER WORKS 다시 연결" }).click();
  await expect(page.getByText("연결을 시작하지 못했습니다.")).toBeVisible();
  expect(authorizations).toBe(1);
  await page.getByRole("button", { name: "다음 문의" }).click();
  // React Query exhausts its normal 1s/2s/4s retry backoff before showing failure.
  await expect(page.getByText("문의 목록을 불러오지 못했습니다.")).toBeVisible({ timeout: 12_000 });
  await page.getByRole("button", { name: "이전 문의" }).click();
  await expect(page.getByRole("button", { name: "다음 문의" })).toBeVisible();
});

for (const role of ["admin", "viewer"] as const) {
  test(`${role} deep link never mounts the operator inquiry route`, async ({ page }) => {
    const operatorRequests: string[] = [];
    page.on("request", (request) => {
      const pathname = new URL(request.url()).pathname;
      if (pathname.startsWith("/api/operator/landing-")) operatorRequests.push(pathname);
    });
    await installSettingsApiRoutes(page, role);
    await page.goto("/operator/landing-inquiries");
    await expect(page).toHaveURL(/\/monitoring$/);
    await expect(page.getByRole("heading", { name: "상담 문의 관리" })).toHaveCount(0);
    expect(operatorRequests).toEqual([]);
  });
}

for (const width of [320, 390, 1024, 1440]) {
  test(`public styles keep the real signed-out login unchanged at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.route("**/api/auth/me", route => route.fulfill({ status: 401, json: { message: "unauthorized" } }));
    await page.goto("/");
    await page.getByRole("link", { name: /로그인/ }).click();
    const login = page.getByRole("button", { name: "로그인", exact: true });
    await expect(login).toBeVisible();
    await expect(login).toHaveCSS("font-size", "14px");
    await expect(login).toHaveCSS("line-height", "22px");
    await expect(login).toHaveCSS("border-radius", "10px");
    await expect(login).toHaveCSS("background-color", "rgb(37, 111, 161)");
    await expect(page.locator("[data-kinda-logo] strong")).toHaveCSS("color", "rgb(21, 50, 74)");
    await expect(page.locator("[data-kinda-logo] img")).toHaveCSS("width", "40px");
    await expect(page.locator("body")).toHaveCSS("word-break", "normal");
    await expect(page.locator(".field-day")).toHaveCount(0);
    const font = await login.evaluate(element => getComputedStyle(element).fontFamily);
    expect(font).not.toContain("Pretendard");
    await page.reload();
    await expect(login).toHaveCSS("border-radius", "10px");
  });
}
