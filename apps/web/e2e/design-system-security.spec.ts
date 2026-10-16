import { test, expect } from "./support/design-system-fixture";

for (const width of [320, 390, 759, 760, 1024, 1440]) {
  for (const principal of ["admin", "operator"] as const) {
    test(`${principal} security regular inset and modal return focus at ${width}px`, async ({ page, designScenario }) => {
      await page.setViewportSize({ width, height: 900 });
      await designScenario({ principal, state: "ready", ...(principal === "admin" ? { theme: "light" as const } : {}) });
      await page.route("**/api/auth/mfa", route => route.fulfill({ json: { enabled: false, enabledAt: null } }));
      await page.route("**/api/auth/sessions", route => route.fulfill({ json: { sessions: [] } }));
      await page.goto(principal === "admin" ? "/settings/security" : "/operator/security");
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
      await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("font-size", width < 760 ? "24px" : "26px");
      await expect(page.locator('[data-testid="account-security-layout"]')).toHaveCSS("gap", "18px");
      for (const card of ["mfa", "sessions"]) await expect(page.locator(`[data-security-card="${card}"]`)).toHaveCSS("padding", width < 760 ? "16px" : "20px");
      for (const name of ["비밀번호", "2단계 인증", "활성 세션"]) await expect(page.getByRole("heading", { name, exact: true })).toHaveCSS("font-size", "16px");
      if (principal === "operator") {
        await expect(page.getByRole("main")).toHaveCSS("padding", width < 760 ? "18px 14px" : "24px 28px");
        await expect(page.getByRole("main")).toHaveCSS("max-width", "1160px");
      }
      const trigger = page.getByRole("button", { name: "비밀번호 변경", exact: true });
      await trigger.click();
      const dialog = page.getByRole("dialog", { name: "비밀번호 변경" });
      await expect(dialog).toHaveCSS("padding", width < 760 ? "16px" : "20px");
      await expect(page.getByLabel("현재 비밀번호")).toBeFocused();
      await page.keyboard.press("Tab");
      expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
      await page.keyboard.press("Escape");
      await expect(trigger).toBeFocused();
    });
  }
}

for (const width of [320, 1440]) {
  test(`operator profile and inquiry consumers use functional roles at ${width}px`, async ({ page, designScenario }) => {
    await page.setViewportSize({ width, height: 900 });
    await designScenario({ principal: "operator", state: "ready" });
    await page.route("**/api/bio-sensor-profiles", route => route.fulfill({ json: [] }));
    await page.route("**/api/operator/landing-mail/status", route => route.fulfill({ json: { connected: false } }));
    await page.route("**/api/operator/landing-inquiries?*", route => route.fulfill({ json: { items: [], nextCursor: null } }));
    const inset = width < 760 ? "16px" : "20px";
    await page.goto("/operator/sensor-profiles");
    const profiles = page.getByRole("region", { name: "센서 호환 프로파일 관리", exact: true });
    await expect(profiles).toHaveCSS("gap", "20px");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("font-size", width < 760 ? "24px" : "26px");
    await expect(page.getByText("승인된 호환 프로파일이 없습니다. 미검증 조명은 호환 확인이 필요합니다.", { exact: true })).toBeVisible();
    await expect(page.getByLabel("승인 프로파일 JSON").locator("xpath=ancestor::section[1]")).toHaveCSS("padding", inset);
    await expect(page.getByRole("button", { name: "프로파일 승인 등록", exact: true })).toBeDisabled();
    await page.getByRole("link", { name: "상담 문의", exact: true }).click();
    const inquiries = page.getByRole("region", { name: "상담 문의 관리", exact: true });
    await expect(inquiries).toHaveCSS("gap", "20px");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("font-size", width < 760 ? "24px" : "26px");
    await expect(page.getByRole("heading", { name: "최근 상담 문의", exact: true })).toHaveCSS("font-size", "20px");
    const mailHeading = page.getByRole("heading", { name: "NAVER WORKS 메일 연결", exact: true });
    await expect(mailHeading).toHaveCSS("font-size", "16px");
    await expect(mailHeading.locator("xpath=ancestor::section[1]")).toHaveCSS("padding", inset);
    await expect(page.getByText("접수된 상담 문의가 없습니다.", { exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  });

  test(`auth ready pending error TOTP and recovery keep regular form at ${width}px`, async ({ page, designScenario }) => {
    await page.setViewportSize({ width, height: 900 });
    await designScenario({ principal: "anonymous", state: "ready" });
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let fail = true;
    await page.route("**/api/auth/login", async route => {
      await pending;
      await route.fulfill(fail ? { status: 401, json: { message: "invalid" } } : { json: { mfaRequired: true, challengeToken: "fixture-challenge", expiresAt: "2026-10-16T12:10:00Z" } });
    });
    await page.goto("/login");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("font-size", width < 760 ? "24px" : "26px");
    const card = page.getByTestId("auth-stage-card");
    const inset = width < 760 ? "16px" : "20px";
    await expect(card).toHaveCSS("padding", inset);
    await page.getByLabel("아이디", { exact: true }).fill("admin");
    await page.getByLabel("비밀번호", { exact: true }).fill("fixture-password");
    try {
      await page.getByRole("button", { name: "로그인", exact: true }).click();
      await expect(card).toHaveAttribute("data-auth-status", "pending");
      await expect(card).toHaveCSS("padding", inset);
      await expect(page.getByRole("button", { name: "로그인 중" })).toBeDisabled();
    } finally { release(); }
    await expect(card).toHaveAttribute("data-auth-status", "error");
    await expect(card).toHaveCSS("padding", inset);
    await expect(page.getByRole("alert")).toHaveCSS("padding", inset);
    fail = false;
    await page.getByRole("button", { name: "로그인", exact: true }).click();
    await expect(card).toHaveAttribute("data-auth-stage", "totp");
    await expect(card).toHaveCSS("padding", inset);
    await expect(page.getByLabel("인증 앱 코드")).toBeFocused();
    await page.getByRole("button", { name: "복구 코드 사용", exact: true }).click();
    await expect(card).toHaveAttribute("data-auth-stage", "recovery");
    await expect(card).toHaveCSS("padding", inset);
    await expect(page.getByLabel("복구 코드", { exact: true })).toBeVisible();
  });

  test(`operator pending error empty use one functional section at ${width}px`, async ({ page, designScenario }) => {
    await page.setViewportSize({ width, height: 900 });
    await designScenario({ principal: "operator", state: "ready" });
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let fail = true;
    let failedResponses = 0;
    // Operator lists retain React Query's three retries. Wait for the final
    // fourth HTTP response before applying the ordinary assertion deadline.
    const finalFailure = page.waitForResponse(response => new URL(response.url()).pathname === "/api/operator/site-admins" && response.status() === 403 && ++failedResponses === 4);
    await page.route("**/api/operator/site-admins", async route => {
      await pending;
      await route.fulfill(fail ? { status: 403, json: { message: "fixture denied" } } : { json: [] });
    });
    await page.goto("/operator/site-admins");
    const section = page.getByRole("region", { name: "현장 관리자 계정", exact: true });
    const inset = width < 760 ? "16px" : "20px";
    try {
      await expect(section.getByRole("status")).toContainText("현장 관리자 목록을 불러오는 중입니다.");
      await expect(section).toHaveCSS("gap", "20px");
      await expect(section.getByRole("status")).toHaveCSS("padding", inset);
    } finally { release(); }
    await finalFailure;
    await expect(section.getByRole("alert")).toContainText("현장 관리자 목록을 불러오지 못했습니다.");
    await expect(section.getByRole("alert")).toHaveCSS("padding", inset);
    await expect(section).toHaveCSS("gap", "20px");
    fail = false;
    await page.getByRole("button", { name: "다시 시도", exact: true }).click();
    await expect(section.getByText("관리할 현장이 없습니다.", { exact: true })).toBeVisible();
    await expect(section).toHaveCSS("gap", "20px");
    await expect(page.getByTestId("operator-summary-strip")).toHaveCSS("gap", "18px");
    for (const card of await page.locator("[data-metric-card]").all()) await expect(card).toHaveCSS("padding", inset);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  });
}
