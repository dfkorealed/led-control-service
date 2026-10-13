import { expect, test } from "@playwright/test";
import { classifyLandingAxe, runLandingAxe } from "./support/landing-accessibility";
import { landingDecorationSourceIssues } from "./support/landing-decoration-source";
import { installSettingsApiRoutes } from "./support/settings-api";
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

for (const width of [1440, 1024, 390, 320]) {
  test(`public landing remains usable at ${width}px`, async ({ page }, testInfo) => {
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
    await expect(dialog.getByRole("link", { name: "kymkjh2002@dfkorealed.com" })).toHaveAttribute("href", "mailto:kymkjh2002@dfkorealed.com");
    const viewport = page.viewportSize()!;
    const box = await dialog.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeLessThanOrEqual(viewport.width);
    expect(box!.height).toBeLessThanOrEqual(viewport.height);
    await expect(dialog).toHaveCSS("border-radius", "14px");
    await expect(dialog).toHaveCSS("overflow-y", "auto");
    const submit = dialog.getByRole("link", { name: "032-528-2953" });
    await submit.focus();
    await expect(submit).toBeFocused();
    await expect(submit).toBeInViewport();
    await dialog.getByRole("button", { name: "상담 팝업 닫기" }).click();
    await expect(page.getByRole("button", { name: "도입 상담", exact: true }).first()).toBeFocused();

    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.reload();
    await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
    await page.evaluate(() => document.fonts.ready);
    const raw = await runLandingAxe(page);
    const classified = await classifyLandingAxe(page, raw);
    const rawDir = resolve(".local/landing-visuals/task8-final-axe");
    await mkdir(rawDir, { recursive: true });
    const rawPath = resolve(rawDir, `home-${width}.json`);
    await writeFile(rawPath, JSON.stringify({ raw, classified }, null, 2));
    await testInfo.attach("landing-axe-raw-and-incidental-classification", { path: rawPath, contentType: "application/json" });
    // Raw axe results remain intact; SC 1.4.3 incidental artwork is checked separately.
    expect(classified.remaining).toEqual([]);
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
    await expect(page).toHaveURL(/\/login$/);
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

for (const [width, selector] of [[1024, "#map-editor > .scene-watermark"], [320, ".control-visual__caption"]] as const) {
  test(`incidental classification rejects changed decoration at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/");
    await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
    await page.evaluate(() => document.fonts.ready);
    const raw = await runLandingAxe(page);
    const node = page.locator(selector);
    const original = await node.evaluate(e => e.outerHTML);
    const hiddenOwner = width === 320 ? page.locator(".control-visual") : node;
    expect((await classifyLandingAxe(page, raw)).incidental).toHaveLength(1);
    for (const mutation of ["text", "hidden", "focus", "role", "handler", "readable-role", "picture", "position", "css-hidden", "css-transparent", "heading-hidden", "picture-clipped", "picture-moved"] as const) {
      const pictureOriginal = await page.locator(".control-visual").evaluate(e => e.outerHTML);
      await node.evaluate((e, mutation) => {
        if (mutation === "text") e.textContent = "새로운 운영 안내";
        if (mutation === "hidden") (e.closest("[aria-hidden='true']") ?? e).removeAttribute("aria-hidden");
        if (mutation === "focus") e.setAttribute("tabindex", "0");
        if (mutation === "role") e.setAttribute("role", "button");
        if (mutation === "handler") e.setAttribute("onclick", "void 0");
        if (mutation === "readable-role") e.classList.add("map-save");
        if (mutation === "picture") {
          if (e.matches(".control-visual__caption")) e.parentElement!.querySelector(".control-visual__lamp")!.remove();
          else e.parentElement!.querySelector("h2")!.setAttribute("aria-hidden", "true");
        }
        if (mutation === "heading-hidden") e.closest(".scene")!.querySelector<HTMLElement>("h2")!.style.visibility = "hidden";
        if (mutation === "position") e.style.position = "static";
        if (mutation === "css-hidden" || mutation === "css-transparent") {
          const artwork = e.matches(".control-visual__caption") ? e.parentElement!.querySelector<HTMLElement>(".control-visual__lamp")! : e;
          if (mutation === "css-hidden") artwork.style.visibility = "hidden";
          else artwork.style.opacity = "0";
        }
        if (mutation === "picture-clipped" || mutation === "picture-moved") {
          const artwork = e.matches(".control-visual__caption")
            ? [...e.parentElement!.querySelectorAll<HTMLElement>(":scope > div")] : [e as HTMLElement];
          for (const part of artwork) {
            if (mutation === "picture-clipped") part.style.clipPath = "inset(100%)";
            else part.style.transform = "translate(10000px,10000px)";
          }
        }
      }, mutation);
      expect((await classifyLandingAxe(page, raw)).remaining.length, mutation).toBeGreaterThan(0);
      await node.evaluate((e, original) => { e.outerHTML = original; }, original);
      await hiddenOwner.evaluate(e => e.setAttribute("aria-hidden", "true"));
      await page.locator(".control-visual").evaluate((e, original) => { e.outerHTML = original; }, pictureOriginal);
      await page.locator("#map-editor h2").evaluate(e => e.removeAttribute("aria-hidden"));
      await page.locator("#control h2,#map-editor h2").evaluateAll(headings => headings.forEach(e => { (e as HTMLElement).style.visibility = ""; }));
    }
    // An unrelated serious rule and a critical contrast result never become incidental.
    for (const change of [{ id: "new-serious-rule" }, { impact: "critical" as const }]) {
      const altered = { ...raw, violations: raw.violations.map(v => ({ ...v, ...change })) };
      expect((await classifyLandingAxe(page, altered)).remaining.length).toBeGreaterThan(0);
    }
  });
}

test("decorative JSX owners and their owned ancestors reject delegated event props and spreads", () => {
  const paths = ["features/landing/field-day/ControlDemo.tsx", "features/landing/field-day/Scene.tsx",
    "features/landing/LandingPage.tsx", "features/landing/FieldDayConceptPage.tsx",
    "features/landing/PublicSiteLayout.tsx", "components/ui/Card.tsx"];
  const sources = Object.fromEntries(paths.map(path => [path, readFileSync(resolve("src", path), "utf8")]));
  expect(landingDecorationSourceIssues(sources)).toEqual([]);
  for (const [path, original, replacement] of [
    [paths[0], '<span className="control-visual__caption', '<span onClick={() => {}} className="control-visual__caption'],
    [paths[0], '<div className="control-content', '<div onPointerDown={() => {}} className="control-content'],
    [paths[0], '<div className="control-visual relative', '<div {...pictureProps} className="control-visual relative'],
    [paths[1], '<span aria-hidden="true" className={`scene-watermark', '<span onClick={() => {}} aria-hidden="true" className={`scene-watermark'],
    [paths[1], '<Card variant="landingDemo"', '<Card {...pictureProps} variant="landingDemo"'],
    [paths[4], '<div className={`${concept', '<div onClickCapture={() => {}} className={`${concept'],
    [paths[5], '<section {...props}', '<section onClick={() => {}} {...props}']
  ]) {
    expect(sources[path]).toContain(original);
    expect(landingDecorationSourceIssues({ ...sources, [path]: sources[path].replace(original, replacement) }), replacement).not.toEqual([]);
  }
});

test("readable contrast violations remain blocking when their exact DOM targets exist", async ({ page }) => {
  await page.goto("/");
  // Conditional classifier input, NOT a claim of a current raw axe failure.
  // Exercise currently readable roles; the removed DemoCard footer is no longer
  // a live DOM target. Synthetic contrast input must still block the chart legend
  // and map-save hint rather than classify either as incidental picture text.
  const recorded = { violations: [{ id: "color-contrast", impact: "serious" as const, nodes: [
    { target: [".chart-foot > span:first-child"] },
    { target: [".map-save"] }
  ] }] };
  for (const [index, role] of [".chart-foot > span", ".map-save"].entries()) {
    const target = page.locator(recorded.violations[0].nodes[index].target[0]);
    await expect(target).toHaveCount(1);
    expect(await target.evaluate((e, role) => e.matches(role), role)).toBe(true);
    await expect(target).toHaveCSS("color", "rgb(21, 50, 74)");
  }
  const classified = await classifyLandingAxe(page, recorded);
  expect(classified.incidental).toEqual([]);
  expect(classified.remaining).toEqual(recorded.violations[0].nodes.map(({ target }) => ({
    id: "color-contrast", impact: "serious", target
  })));
});
