import { expect, test, type Page } from "@playwright/test";
import { expectNoHorizontalOverflow } from "./support/layout-assertions";

const operator = {
  id: "operator-1",
  organizationId: "provider-1",
  organizationType: "service_provider",
  loginId: "operator",
  name: "운영자",
  role: "operator",
  status: "active",
  mustChangePassword: false
};

test("MFA 로그인 후 계정 보안에서 MFA 등록과 세션 종료를 완료한다", async ({ page }) => {
  const requests: Array<{ path: string; body: unknown }> = [];
  const secrets = {
    password: "operator-password",
    loginCode: "123456",
    enrollmentSecret: "PLAYWRIGHTSECRET",
    enrollmentCode: "654321",
    recoveryCode: "recovery-once"
  };
  let authenticated = false;
  let sessions = [
    {
      id: "current-session",
      rememberMe: true,
      userAgent: "Chrome current",
      ipAddress: "192.0.2.10",
      createdAt: "2026-09-12T10:00:00.000Z",
      expiresAt: "2026-10-12T10:00:00.000Z",
      current: true,
      mfaVerified: true
    },
    {
      id: "other-session",
      rememberMe: false,
      userAgent: "Safari other",
      ipAddress: "192.0.2.11",
      createdAt: "2026-09-11T10:00:00.000Z",
      expiresAt: "2026-09-13T10:00:00.000Z",
      current: false,
      mfaVerified: false
    }
  ];

  await installSecurityApi(page, async ({ path, method, body }) => {
    requests.push({ path, body });
    if (path === "/auth/me") {
      return authenticated
        ? { json: { user: operator } }
        : { status: 401, json: { message: "unauthorized" } };
    }
    if (path === "/auth/login" && method === "POST") {
      return { json: { mfaRequired: true, challengeToken: "login-challenge", expiresAt: "2026-09-12T12:10:00.000Z" } };
    }
    if (path === "/auth/login/mfa" && method === "POST") {
      authenticated = true;
      return { json: { user: operator, recoveryCodeUsed: false } };
    }
    if (path === "/operator/site-admins" && method === "GET") return { json: [] };
    if (path === "/auth/mfa" && method === "GET") return { json: { enabled: false, enabledAt: null } };
    if (path === "/auth/mfa/enrollment" && method === "POST") {
      return { json: {
        enrollmentToken: "enrollment-token",
        secret: secrets.enrollmentSecret,
        otpauthUri: `otpauth://totp/LED%20Control:operator?secret=${secrets.enrollmentSecret}`,
        expiresAt: "2026-09-12T12:20:00.000Z"
      } };
    }
    if (path === "/auth/mfa/enrollment/confirm" && method === "POST") {
      return { json: { mfaEnabled: true, recoveryCodes: [secrets.recoveryCode] } };
    }
    if (path === "/auth/sessions" && method === "GET") return { json: { sessions } };
    if (path === "/auth/sessions/other-session" && method === "DELETE") {
      sessions = sessions.filter((session) => session.id !== "other-session");
      return { json: { ok: true } };
    }
    return { status: 404, json: { message: `Unhandled fixture route: ${method} ${path}` } };
  });

  await page.goto("/");
  await page.getByLabel("아이디").fill(operator.loginId);
  await page.getByLabel("비밀번호").fill(secrets.password);
  await page.getByRole("button", { name: "로그인" }).click();
  await expect(page.getByRole("heading", { name: "2단계 인증" })).toBeVisible();
  await page.getByLabel("인증 앱 코드").fill(secrets.loginCode);
  await page.getByRole("button", { name: "인증하고 로그인" }).click();

  await expect(page).toHaveURL(/\/operator\/site-admins$/);
  await page.getByRole("link", { name: "계정 보안" }).click();
  await expect(page.getByRole("heading", { name: "계정 보안" })).toBeVisible();
  await expect(page.getByText("Chrome current")).toBeVisible();
  await expect(page.getByText("Safari other")).toBeVisible();

  await page.setViewportSize({ width: 1440, height: 900 });
  const mfaCard = page.locator('[data-security-card="mfa"]');
  const sessionsCard = page.locator('[data-security-card="sessions"]');
  const mfaBox = await mfaCard.boundingBox();
  const sessionsBox = await sessionsCard.boundingBox();
  expect(mfaBox).not.toBeNull();
  expect(sessionsBox).not.toBeNull();
  expect(Math.abs(mfaBox!.y - sessionsBox!.y)).toBeLessThanOrEqual(1);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileMfaBox = await mfaCard.boundingBox();
  const mobileSessionsBox = await sessionsCard.boundingBox();
  expect(mobileMfaBox).not.toBeNull();
  expect(mobileSessionsBox).not.toBeNull();
  expect(mobileSessionsBox!.y).toBeGreaterThan(mobileMfaBox!.y + mobileMfaBox!.height);
  await expectNoHorizontalOverflow(page);
  await page.setViewportSize({ width: 1440, height: 900 });

  await page.getByRole("button", { name: "2단계 인증 설정" }).click();
  await expect(page.getByText(secrets.enrollmentSecret)).toBeVisible();
  await page.getByLabel("인증 앱 코드").fill(secrets.enrollmentCode);
  await page.getByRole("button", { name: "설정 완료" }).click();
  await expect(page.getByText(secrets.recoveryCode)).toBeVisible();
  await page.getByRole("button", { name: "복구 코드를 안전하게 보관했습니다" }).click();
  await expect(page.getByText(secrets.recoveryCode)).toHaveCount(0);

  await page.getByRole("button", { name: "이 세션 종료" }).click();
  await expect(page.getByText("Safari other")).toHaveCount(0);
  await expect(page.getByRole("status")).toContainText("선택한 세션을 종료했습니다.");

  expect(requests.find((request) => request.path === "/auth/login")?.body).toEqual({
    loginId: operator.loginId,
    password: secrets.password,
    rememberMe: true
  });
  expect(requests.find((request) => request.path === "/auth/login/mfa")?.body).toEqual({
    challengeToken: "login-challenge",
    code: secrets.loginCode
  });
  expect(requests.find((request) => request.path === "/auth/mfa/enrollment/confirm")?.body).toEqual({
    enrollmentToken: "enrollment-token",
    code: secrets.enrollmentCode
  });

  const browserStorage = await page.evaluate(() => JSON.stringify({
    localStorage: { ...localStorage },
    sessionStorage: { ...sessionStorage }
  }));
  for (const secret of Object.values(secrets)) expect(browserStorage).not.toContain(secret);
});

type SecurityApiRequest = { path: string; method: string; body: unknown };
type SecurityApiResponse = { status?: number; json: unknown };

async function installSecurityApi(
  page: Page,
  handle: (request: SecurityApiRequest) => Promise<SecurityApiResponse>
) {
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith("/api/")) return route.continue();
    const path = pathname.replace(/^\/api/, "");
    const body = request.method() === "GET" ? null : request.postDataJSON();
    const response = await handle({ path, method: request.method(), body });
    await route.fulfill(response);
  });
}
