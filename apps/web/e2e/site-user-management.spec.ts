import { randomUUID } from "node:crypto";
import { expect, test, type Browser, type Page, type Route } from "@playwright/test";

test.describe.configure({ mode: "serial" });
test.use({ trace: "off", screenshot: "off" });

const siteId = "11111111-1111-4111-8111-111111111111";
const floorId = "22222222-2222-4222-8222-222222222222";
const fixtureId = "33333333-3333-4333-8333-333333333333";
const commandId = "44444444-4444-4444-8444-444444444444";

test("admin이 일반 유저의 전체 관리 여정을 완료하고 평문 비밀번호를 남기지 않는다", async ({ page }) => {
  const api = await installProductApi(page, "admin");
  const temporaryPassword = runtimePassword("create");
  const resetPassword = runtimePassword("reset");

  await page.goto(`/settings/users?siteId=${siteId}`);
  await expect(page.getByRole("heading", { name: "유저 관리" })).toBeVisible();
  await expect(page.getByText("0 / 100명")).toBeVisible();

  await page.getByRole("button", { name: "사용자 추가" }).click();
  const createDialog = page.getByRole("dialog", { name: "사용자 추가" });
  await createDialog.getByLabel("이름").fill("김현수");
  await createDialog.getByLabel("로그인 아이디").fill("user_read");
  await createDialog.getByLabel("임시 비밀번호").fill(temporaryPassword);
  await createDialog.getByRole("button", { name: "사용자 생성" }).click();
  await expect(page.getByText("사용자를 생성했습니다.", { exact: true })).toBeVisible();
  await expect(page.getByText("user_read")).toBeVisible();
  await expect(page.getByText("1 / 100명")).toBeVisible();
  expect(api.createdPasswordInputs).toEqual([temporaryPassword]);
  expect(api.responseBodies.some((body) => body.includes(temporaryPassword))).toBe(false);
  await expect(page.locator("body")).not.toContainText(temporaryPassword);

  await page.getByRole("button", { name: "김현수 수정" }).click();
  const editDialog = page.getByRole("dialog", { name: "김현수 사용자 수정" });
  await editDialog.getByLabel("이름").fill("김현수 수정");
  await editDialog.getByRole("button", { name: "제어" }).click();
  await editDialog.getByRole("button", { name: "변경사항 저장" }).click();
  await expect(page.getByText("김현수 수정")).toBeVisible();
  const editedRow = page.getByRole("row").filter({ hasText: "user_read" });
  await expect(editedRow).toContainText("제어");

  await page.getByRole("button", { name: "김현수 수정 비활성화" }).click();
  await expect(editedRow).toContainText("비활성");
  await page.getByRole("button", { name: "김현수 수정 활성화" }).click();
  await expect(editedRow).toContainText("활성");

  await page.getByRole("button", { name: "김현수 수정 비밀번호 초기화" }).click();
  const resetDialog = page.getByRole("dialog", { name: "김현수 수정 비밀번호 초기화" });
  await resetDialog.getByLabel("새 임시 비밀번호").fill(resetPassword);
  await resetDialog.getByLabel("임시 비밀번호 확인").fill(resetPassword);
  await resetDialog.getByRole("button", { name: "비밀번호 초기화" }).click();
  await expect(page.getByText("비밀번호를 초기화했습니다. 사용자의 기존 세션이 종료되었습니다.", { exact: true })).toBeVisible();
  expect(api.resetPasswordInputs).toEqual([resetPassword]);
  expect(api.responseBodies.some((body) => body.includes(resetPassword))).toBe(false);
  await expect(page.locator("body")).not.toContainText(resetPassword);

  await page.getByRole("button", { name: "김현수 수정 영구 삭제" }).click();
  const deleteDialog = page.getByRole("alertdialog", { name: "김현수 수정 사용자 영구 삭제" });
  await expect(deleteDialog.getByRole("button", { name: "영구 삭제" })).toBeDisabled();
  await deleteDialog.getByLabel("확인 로그인 아이디").fill("user_read");
  await deleteDialog.getByRole("button", { name: "영구 삭제" }).click();
  await expect(page.getByText("0 / 100명")).toBeVisible();
  await expect(page.getByText("user_read")).toHaveCount(0);

  const browserStorage = await page.evaluate(() => JSON.stringify({
    localStorage: { ...localStorage },
    sessionStorage: { ...sessionStorage }
  }));
  expect(browserStorage).not.toContain(temporaryPassword);
  expect(browserStorage).not.toContain(resetPassword);
});

test("신규 일반 유저가 최초 로그인 비밀번호를 변경한 뒤 모니터링에 진입한다", async ({ page }) => {
  const temporaryPassword = runtimePassword("temporary");
  const permanentPassword = runtimePassword("permanent");
  const api = await installProductApi(page, null, {
    accounts: [{ role: "read", loginId: "first_login_user", password: temporaryPassword, mustChangePassword: true }]
  });

  await page.goto("/");
  await login(page, "first_login_user", temporaryPassword);
  await expect(page.getByRole("heading", { name: "비밀번호를 변경해 주세요" })).toBeVisible();
  await expect(page.getByRole("navigation")).toHaveCount(0);

  await page.getByLabel("현재 임시 비밀번호").fill(temporaryPassword);
  await page.getByLabel("새 비밀번호", { exact: true }).fill(permanentPassword);
  await page.getByLabel("새 비밀번호 확인").fill(permanentPassword);
  await page.getByRole("button", { name: "비밀번호 변경" }).click();

  await expect(page).toHaveURL(/\/monitoring$/);
  await expect(page.getByRole("combobox", { name: "맵 선택" })).toBeVisible();
  expect(api.accounts[0]?.mustChangePassword).toBe(false);
  expect(api.responseBodies.some((body) => body.includes(temporaryPassword) || body.includes(permanentPassword))).toBe(false);
  await expect(page.locator("body")).not.toContainText(temporaryPassword);
  await expect(page.locator("body")).not.toContainText(permanentPassword);
});

test("read, control, admin의 메뉴와 직접 경로 및 수동 제어 API 권한이 일치한다", async ({ browser, baseURL }) => {
  const read = await actorPage(browser, baseURL, "read");
  try {
    await read.page.goto(`/monitoring?siteId=${siteId}`);
    await expect(read.page.getByRole("link", { name: "제어", exact: true })).toHaveCount(0);
    await read.page.goto(`/control?siteId=${siteId}&mode=schedule`);
    await expect(read.page).toHaveURL(new RegExp(`/monitoring\\?siteId=${siteId}`));
    expect(await manualCommandStatus(read.page)).toBe(403);
  } finally {
    await read.page.close();
  }

  const control = await actorPage(browser, baseURL, "control");
  try {
    await control.page.goto(`/control?siteId=${siteId}&mode=schedule`);
    await expect(control.page).toHaveURL(new RegExp(`/control\\?siteId=${siteId}&mode=manual`));
    await expect(control.page.getByRole("tab", { name: "수동 제어" })).toBeVisible();
    await expect(control.page.getByRole("tab", { name: "스케줄 제어" })).toHaveCount(0);
    await expect(control.page.getByRole("tab", { name: "이벤트 제어" })).toHaveCount(0);
    await expect(control.page.getByRole("button", { name: "구역 관리" })).toHaveCount(0);
    await expect(control.page.getByRole("button", { name: "구역 현황" })).toBeVisible();
    expect(await manualCommandStatus(control.page)).toBe(201);

    await control.page.getByRole("checkbox", { name: "B2-L01 선택" }).check();
    await control.page.getByRole("button", { name: "30%", exact: true }).click();
    await control.page.getByRole("button", { name: "밝기 적용" }).click();
    await expect(control.page.getByText("조명 적용 완료")).toBeVisible();
    expect(control.api.commandRequests).toHaveLength(2);
  } finally {
    await control.page.close();
  }

  const admin = await actorPage(browser, baseURL, "admin");
  try {
    await admin.page.goto(`/control?siteId=${siteId}&mode=schedule`);
    await expect(admin.page.getByRole("tab", { name: "수동 제어" })).toBeVisible();
    await expect(admin.page.getByRole("tab", { name: "스케줄 제어" })).toBeVisible();
    await expect(admin.page.getByRole("tab", { name: "이벤트 제어" })).toBeVisible();
    await admin.page.goto(`/settings/users?siteId=${siteId}`);
    await expect(admin.page.getByRole("heading", { name: "유저 관리" })).toBeVisible();
    expect(await manualCommandStatus(admin.page)).toBe(201);
  } finally {
    await admin.page.close();
  }
});

type ActorRole = "admin" | "read" | "control";
type Account = {
  id: string;
  role: ActorRole;
  loginId: string;
  password: string;
  mustChangePassword: boolean;
  status: "active" | "disabled";
};
type SiteUser = {
  id: string;
  name: string;
  loginId: string;
  accessLevel: "read" | "control";
  status: "active" | "disabled";
  lastLoginAt: string | null;
  createdAt: string;
  updatedAt: string;
};

interface ProductApiState {
  accounts: Account[];
  users: SiteUser[];
  createdPasswordInputs: string[];
  resetPasswordInputs: string[];
  responseBodies: string[];
  commandRequests: unknown[];
}

async function actorPage(browser: Browser, baseURL: string | undefined, role: ActorRole) {
  const page = await browser.newPage({ baseURL });
  return { page, api: await installProductApi(page, role) };
}

async function installProductApi(
  page: Page,
  initialRole: ActorRole | null,
  options: { accounts?: Array<Pick<Account, "role" | "loginId" | "password" | "mustChangePassword">> } = {}
): Promise<ProductApiState> {
  const now = "2026-09-11T00:00:00.000Z";
  const accounts: Account[] = (options.accounts ?? [
    { role: initialRole ?? "read", loginId: `${initialRole ?? "read"}_user`, password: runtimePassword("actor"), mustChangePassword: false }
  ]).map((account) => ({ ...account, id: randomUUID(), status: "active" }));
  let principal = initialRole ? accounts.find((account) => account.role === initialRole) ?? accounts[0] : null;
  const state: ProductApiState = {
    accounts,
    users: [],
    createdPasswordInputs: [],
    resetPasswordInputs: [],
    responseBodies: [],
    commandRequests: []
  };

  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    const path = url.pathname.slice(4);
    const method = request.method();

    if (path === "/auth/me") return respond(route, principal ? { user: authUser(principal) } : { code: "UNAUTHORIZED" }, principal ? 200 : 401, state);
    if (path === "/auth/login" && method === "POST") {
      const body = request.postDataJSON() as { loginId: string; password: string };
      const account = accounts.find((candidate) => candidate.loginId === body.loginId && candidate.password === body.password && candidate.status === "active");
      principal = account ?? null;
      return respond(route, account ? { user: authUser(account) } : { code: "INVALID_CREDENTIALS" }, account ? 201 : 401, state);
    }
    if (path === "/auth/change-password" && method === "POST") {
      const body = request.postDataJSON() as { currentPassword: string; newPassword: string };
      if (!principal || principal.password !== body.currentPassword) return respond(route, { code: "INVALID_CURRENT_PASSWORD" }, 400, state);
      principal.password = body.newPassword;
      principal.mustChangePassword = false;
      return respond(route, { ok: true, user: authUser(principal) }, 201, state);
    }
    if (path === "/auth/logout" && method === "POST") {
      principal = null;
      return respond(route, { ok: true }, 201, state);
    }
    if (!principal) return respond(route, { code: "UNAUTHORIZED" }, 401, state);
    if (principal.mustChangePassword) return respond(route, { code: "PASSWORD_CHANGE_REQUIRED" }, 403, state);

    if (path === "/sites") return respond(route, [{ id: siteId, name: "B2 테스트 현장", customerName: "테스트 고객사" }], 200, state);
    if (path === "/sites/default/dashboard" || path === `/sites/${siteId}/dashboard`) return respond(route, dashboardFor(principal.role), 200, state);
    if (path === `/sites/${siteId}/floors/${floorId}/fixtures`) return respond(route, { items: dashboardFixture(), nextCursor: null }, 200, state);
    if (path === `/sites/${siteId}/floors/${floorId}/map-snapshot`) return respond(route, { floorId, revision: 1, width: 1200, height: 800, floorPlan: null, objects: [] }, 200, state);

    if (path === `/sites/${siteId}/users` && method === "GET") {
      return principal.role === "admin" ? respond(route, { users: state.users, count: state.users.length, limit: 100 }, 200, state) : respond(route, { code: "SITE_CAPABILITY_DENIED" }, 403, state);
    }
    if (path === `/sites/${siteId}/users` && method === "POST") {
      if (principal.role !== "admin") return respond(route, { code: "SITE_CAPABILITY_DENIED" }, 403, state);
      const body = request.postDataJSON() as { name: string; loginId: string; temporaryPassword: string; accessLevel: "read" | "control"; status: "active" | "disabled" };
      state.createdPasswordInputs.push(body.temporaryPassword);
      const user = { id: randomUUID(), name: body.name, loginId: body.loginId, accessLevel: body.accessLevel, status: body.status, lastLoginAt: null, createdAt: now, updatedAt: now };
      state.users.push(user);
      accounts.push({ id: user.id, role: user.accessLevel, loginId: user.loginId, password: body.temporaryPassword, mustChangePassword: true, status: user.status });
      return respond(route, user, 201, state);
    }
    const userMatch = path.match(new RegExp(`^/sites/${siteId}/users/([^/]+)$`));
    if (userMatch && method === "PATCH") {
      if (principal.role !== "admin") return respond(route, { code: "SITE_CAPABILITY_DENIED" }, 403, state);
      const user = state.users.find((candidate) => candidate.id === userMatch[1]);
      if (!user) return respond(route, { code: "SITE_USER_NOT_FOUND" }, 404, state);
      const body = request.postDataJSON() as Pick<SiteUser, "name" | "loginId" | "accessLevel" | "status">;
      Object.assign(user, body, { updatedAt: new Date(Date.parse(user.updatedAt) + 1_000).toISOString() });
      const account = accounts.find((candidate) => candidate.id === user.id);
      if (account) Object.assign(account, { loginId: user.loginId, role: user.accessLevel, status: user.status });
      return respond(route, user, 200, state);
    }
    const resetMatch = path.match(new RegExp(`^/sites/${siteId}/users/([^/]+)/reset-password$`));
    if (resetMatch && method === "POST") {
      if (principal.role !== "admin") return respond(route, { code: "SITE_CAPABILITY_DENIED" }, 403, state);
      const body = request.postDataJSON() as { temporaryPassword: string };
      state.resetPasswordInputs.push(body.temporaryPassword);
      const account = accounts.find((candidate) => candidate.id === resetMatch[1]);
      if (account) Object.assign(account, { password: body.temporaryPassword, mustChangePassword: true });
      return respond(route, { ok: true }, 201, state);
    }
    if (userMatch && method === "DELETE") {
      if (principal.role !== "admin") return respond(route, { code: "SITE_CAPABILITY_DENIED" }, 403, state);
      const body = request.postDataJSON() as { confirmationLoginId: string };
      const index = state.users.findIndex((candidate) => candidate.id === userMatch[1] && candidate.loginId === body.confirmationLoginId);
      if (index < 0) return respond(route, { code: "INVALID_INPUT" }, 400, state);
      const [deleted] = state.users.splice(index, 1);
      const accountIndex = accounts.findIndex((candidate) => candidate.id === deleted.id);
      if (accountIndex >= 0) accounts.splice(accountIndex, 1);
      return respond(route, { ok: true }, 200, state);
    }

    if (path === "/commands/dimming" && method === "POST") {
      if (principal.role === "read") return respond(route, { code: "SITE_CAPABILITY_DENIED" }, 403, state);
      state.commandRequests.push(request.postDataJSON());
      return respond(route, { id: commandId, dispatchCount: 1, selectedTargetCount: 1, transmissionCount: 1, deliveryMode: "unicast", terminalStatusUrl: `/commands/${commandId}` }, 201, state);
    }
    if (path === `/commands/${commandId}` && method === "GET") {
      return respond(route, {
        id: commandId,
        stage: "completed",
        dispatchCount: 1,
        completedFixtureCount: 1,
        totalFixtureCount: 1,
        errorMessage: null,
        dispatches: [{ id: "dispatch-1", status: "completed", gateway: { id: "gateway-1", name: "B2 Gateway" }, errorMessage: null, results: [{ fixtureId, fixtureName: "B2-L01", status: "succeeded", errorMessage: null }] }]
      }, 200, state);
    }

    return respond(route, { code: "NOT_FOUND", path }, 404, state);
  });
  return state;
}

async function respond(route: Route, body: unknown, status: number, state: ProductApiState) {
  const serialized = JSON.stringify(body);
  state.responseBodies.push(serialized);
  await route.fulfill({ status, contentType: "application/json", body: serialized });
}

function authUser(account: Account) {
  return {
    id: account.id,
    organizationId: "customer-organization-1",
    organizationType: "customer" as const,
    loginId: account.loginId,
    name: account.role === "admin" ? "고객 관리자" : "현장 사용자",
    role: account.role === "admin" ? "admin" as const : "viewer" as const,
    status: account.status,
    mustChangePassword: account.mustChangePassword
  };
}

function dashboardFor(role: ActorRole) {
  return {
    capabilities: { read: true, control: role === "admin" || role === "control", manage: role === "admin", commission: role === "admin" },
    site: { id: siteId, name: "B2 테스트 현장", customerName: "테스트 고객사", installationStatus: "installed", address: "서울", tariffKwhRate: 160, timeZone: "Asia/Seoul" },
    summary: { totalFixtures: 1, onlineFixtures: 1, faultFixtures: 0, averageBrightness: 70 },
    floors: [{ id: floorId, name: "B2", level: -2, floorPlan: null, meshControlGroups: [], fixtures: dashboardFixture() }],
    groups: [],
    gateways: [{ id: "gateway-1", name: "B2 Gateway", serialNumber: "GW-E2E-001", firmwareVersion: "1.0.0", lastHeartbeatAt: new Date().toISOString(), connectionStatus: "online" }]
  };
}

function dashboardFixture() {
  return [{
    id: fixtureId,
    name: "B2-L01",
    x: 100,
    y: 100,
    size: 20,
    placementStatus: "placed",
    positionVerifiedAt: null,
    ratedWatt: 40,
    brightness: 70,
    status: "online",
    statusReason: "reported",
    health: { faultCodes: [], observedAt: new Date().toISOString() },
    rssi: -50,
    hopCount: 1,
    commandSuccessRate: 1,
    lastSeenAt: new Date().toISOString(),
    gateway: { id: "gateway-1", name: "B2 Gateway", connectionStatus: "online" },
    controllable: true,
    controlBlockReason: null
  }];
}

async function login(page: Page, loginId: string, password: string) {
  await page.getByLabel("아이디").fill(loginId);
  await page.getByLabel("비밀번호").fill(password);
  await page.getByRole("button", { name: "로그인" }).click();
}

async function manualCommandStatus(page: Page) {
  return page.evaluate(async ({ siteId: targetSiteId, fixtureId: targetFixtureId }) => {
    const response = await fetch("/api/commands/dimming", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ siteId: targetSiteId, clientRequestId: crypto.randomUUID(), target: { type: "fixture", fixtureId: targetFixtureId }, brightness: 50 })
    });
    return response.status;
  }, { siteId, fixtureId });
}

function runtimePassword(label: string) {
  return `${label}-${randomUUID()}-A1!`;
}
