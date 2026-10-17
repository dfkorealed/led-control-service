import { resolve } from "node:path";
import type { Locator, Page } from "@playwright/test";
import { test, expect, withFoundationFixture } from "./support/design-system-fixture";
import { browserReport, installFirstScreenStatisticsFixtures } from "./support/first-screen-statistics";

// Independent inventory: changing a route/mode, losing its loaded content or
// skipping its case must fail the registration/execution comparison below.
const expectedCustomer = ["monitoring", "manual", "schedule", "event", "group", "statistics-overview", "statistics-analysis", "statistics-reports", "settings", "site", "users", "registration", "floor-plans", "floor-editor", "security"];
const expectedOperator = ["site-admins", "sensor-profiles", "landing-inquiries", "security"];
const registered: string[] = [];
const executed: Array<{ key: string; title: string }> = [];
const scratch = resolve(process.cwd(), "../../.superpowers/sdd/2026-10-16-web-design-system-unification");
const statisticsSite = "30000000-0000-4000-8000-000000000001";

const customerCases = [
  { key: "monitoring", url: "/monitoring", selector: "[data-monitoring-screen]" },
  { key: "manual", url: "/control?mode=manual", selector: "[data-control-panel]" },
  { key: "schedule", url: "/control?mode=schedule", text: "등록된 스케줄이 없습니다." },
  { key: "event", url: "/control?mode=event", text: "등록된 이벤트 규칙이 없습니다." },
  { key: "group", url: "/control?mode=group", text: "저장된 구역이 없습니다." },
  { key: "statistics-overview", url: "/statistics/overview", text: "오늘 사용량과 비용" },
  { key: "statistics-analysis", url: "/statistics/analysis", text: "에너지 사용 비교" },
  { key: "statistics-reports", url: "/statistics/reports", text: "요청한 보고서가 없습니다." },
  { key: "settings", url: "/settings", text: "설치 이어가기" },
  { key: "site", url: "/settings/site", text: "현장 구성" },
  { key: "users", url: "/settings/users", text: "사용자 추가" },
  { key: "registration", url: "/settings/registration", selector: '[data-testid="commissioning-registration"]' },
  { key: "floor-plans", url: "/settings/floor-plans", selector: '[data-testid="floor-plan-item"]' },
  { key: "floor-editor", url: "/settings/floor-plans/floor-1/edit", selector: '[data-testid="floor-editor-canvas"][data-map-ready="true"]' },
  { key: "security", url: "/settings/security", selector: '[data-security-card="sessions"]' }
] as const;

// One serial cohort owns all 38 loaded checks and its inventory. A consumer
// failure remains a failure and skips the remaining cohort, so a replacement
// worker can never compare its empty module state to another worker's work.
// Select the complete describe (or this file), never a test/line within it.
test.describe("coverage complete consumer cohort", () => {
test.describe.configure({ mode: "serial", retries: 0 });
let inventoryCompleted = false;
test.afterAll(() => {
  // CLI / file:line / test-list selection can omit the inventory itself.
  // Completion is checked from actual work, never inferred from grep config.
  expect(inventoryCompleted, 'Incomplete indivisible consumer cohort; rerun all 38 consumers + inventory with --grep "coverage complete consumer cohort".').toBe(true);
});

for (const width of [390, 1440]) for (const item of customerCases) {
  const key = `customer:${item.key}:${width}`;
  registered.push(key);
  test(`coverage ${key} loads its real consumer`, async ({ page, designScenario }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await designScenario({ principal: "admin", state: "ready", theme: width === 390 ? "dark" : "light" });
    await installCustomerRoutes(page);
    const statistics = item.key.startsWith("statistics-");
    if (statistics) await installStatistics(page);
    await page.goto(`${item.url}${item.url.includes("?") ? "&" : "?"}siteId=${statistics ? statisticsSite : "site-1"}`);
    const loaded = "selector" in item ? page.locator(item.selector) : page.getByText(item.text, { exact: true }).first();
    await expect(loaded).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.locator("html")).toHaveAttribute("data-customer-theme", width === 390 ? "dark" : "light");
    if (["settings", "site", "users", "registration", "floor-plans", "security"].includes(item.key)) {
      await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("font-size", width === 390 ? "24px" : "26px");
      await expect(page.locator("[data-shell-content]")).toHaveCSS("padding", width === 390 ? "18px 14px" : "24px 28px");
    }
    if (item.key === "manual") {
      const apply = page.locator("[data-control-submit]");
      await expect(apply).toBeDisabled();
      await recordContrast(apply, "disabled-action-exempt");
      await screenshot(page, `control-ready-${width}`);
    } else if (item.key === "floor-editor") {
      await expect(page.getByTestId("floor-editor-layout")).toHaveCSS("contain", "size");
      expect((await page.getByTestId("floor-editor-layout").boundingBox())!.height).toBeGreaterThanOrEqual(256);
      await screenshot(page, `editor-${width}`);
      if (width === 390) {
        const toolbar = page.getByRole("toolbar", { name: "맵 보기 도구", exact: true });
        await expect(toolbar).toHaveCSS("overflow-x", "auto");
        expect(await toolbar.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
        await toolbar.getByRole("button", { name: "도구 및 조명 패널", exact: true }).focus();
        const information = toolbar.getByRole("button", { name: "편집 정보 패널", exact: true });
        for (let index = 0; index < 12 && !await information.evaluate(element => element === document.activeElement); index++) await page.keyboard.press("Tab");
        await expect(information).toBeFocused();
        expect(await toolbar.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
        await expect(information).toBeInViewport({ ratio: 1 });
        const recovery = toolbar.getByRole("button", { name: "편집 복구", exact: true });
        await recovery.scrollIntoViewIfNeeded();
        await expect(recovery).toBeInViewport({ ratio: 1 });
        await expect(recovery).toBeDisabled();
        await information.press("Enter");
        await expect(information).toHaveAttribute("aria-expanded", "true");
        await expect(page.locator("#editor-information-panel")).toBeVisible();
        await test.info().attach("editor-toolbar-scroll-access", { body: JSON.stringify(await toolbar.evaluate(element => ({ scrollLeft: element.scrollLeft, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, overflow: getComputedStyle(element).overflowX }))), contentType: "application/json" });
      }
    } else if (item.key === "site") {
      await recordContrast(page.getByRole("heading", { name: "현장 구성", exact: true }), "large-text");
      const action = page.getByRole("button", { name: "층 추가", exact: true });
      await recordContrast(action, "normal-text");
      await recordControlBoundary(action);
      await action.click();
      await expect(page.getByRole("dialog", { name: "층 추가", exact: true })).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(action).toBeFocused();
    }
    executed.push({ key, title: test.info().title });
  });
}

for (const width of [390, 1440]) for (const [route, region] of [
  ["site-admins", "현장 관리자 계정"], ["sensor-profiles", "센서 호환 프로파일 관리"],
  ["landing-inquiries", "상담 문의 관리"], ["security", "account-security-layout"]
] as const) {
  const key = `operator:${route}:${width}`;
  registered.push(key);
  test(`coverage ${key} loads its real consumer`, async ({ page, designScenario }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    await designScenario({ principal: "operator", state: "ready" });
    await installSecurity(page);
    await page.route("**/api/bio-sensor-profiles", r => r.fulfill({ json: [] }));
    await page.route("**/api/operator/landing-mail/status", r => r.fulfill({ json: { connected: false } }));
    await page.route("**/api/operator/landing-inquiries?*", r => r.fulfill({ json: { items: [], nextCursor: null } }));
    await page.goto(`/operator/${route}`);
    await expect(route === "security" ? page.getByTestId(region) : page.getByRole("region", { name: region, exact: true })).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    await expect(page.getByRole("heading", { level: 1 })).toHaveCSS("font-size", width === 390 ? "24px" : "26px");
    await expect(page.getByRole("main")).toHaveCSS("padding", width === 390 ? "18px 14px" : "24px 28px");
    await expect(page.getByRole("main")).toHaveCSS("max-width", "1160px");
    executed.push({ key, title: test.info().title });
  });
}

test("coverage inventory matches actual registered and completed customer/operator cases", async ({}, info) => {
  expect(executed, 'Indivisible 38-consumer + inventory cohort: select --grep "coverage complete consumer cohort", the whole file, or the full suite; all 38 consumers must complete first.').toHaveLength(38);
  const expected = [390, 1440].flatMap(width => [
    ...expectedCustomer.map(surface => `customer:${surface}:${width}`),
    ...expectedOperator.map(route => `operator:${route}:${width}`)
  ]).sort();
  expect(registered.slice().sort()).toEqual(expected);
  expect(executed.map(item => item.key).sort()).toEqual(expected);
  expect(executed.map(item => item.title).sort()).toEqual(expected.map(key => `coverage ${key} loads its real consumer`).sort());
  await info.attach("registered-executed-inventory", { body: JSON.stringify({ expected, registered, executed }, null, 2), contentType: "application/json" });
  inventoryCompleted = true;
});
});

for (const width of [320, 1024]) for (const consumer of ["floors", "reports", "logs"] as const) test(`coverage remaining DataGrid ${consumer} populated ${width}`, async ({ page, designScenario }) => {
  await page.setViewportSize({ width, height: width === 320 ? 600 : 900 });
  await designScenario({ principal: "admin", state: "ready", theme: "dark" });
  await installCustomerRoutes(page);
  if (consumer === "floors") {
    await page.goto("/settings/site?siteId=site-1");
    const floors = page.getByRole("list", { name: "층 목록", exact: true });
    await assertCustomerCards(floors, width);
    const edit = floors.getByRole("button", { name: "B1 운영층 수정", exact: true });
    await edit.click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(edit).toBeFocused();
  } else if (consumer === "reports") {
    await installStatistics(page);
    const reports = [browserReport("failed"), { ...browserReport("processing"), reportId: "30000000-0000-4000-8000-000000000042" }];
    await page.route("**/api/energy/sites/*/reports*", route => route.fulfill({ json: { reports, nextCursor: null, totalCount: 2 } }));
    await page.goto(`/statistics/reports?siteId=${statisticsSite}`);
    const history = page.getByRole("list", { name: "보고서 생성 이력", exact: true });
    await assertCustomerCards(history, width);
    const details = history.getByRole("button", { name: /보고서 상세보기/ }).first();
    await details.click();
    await expect(details).toHaveAttribute("aria-expanded", "true");
    await expect(history.getByRole("region", { name: /실패 안내/ })).toContainText("보고서를 생성하지 못했습니다.");
    await details.click();
    await expect(details).toHaveAttribute("aria-expanded", "false");
  } else {
    await page.goto("/monitoring?siteId=site-1");
    const trigger = page.getByRole("region", { name: "최근 운영 로그", exact: true }).getByRole("button", { name: "전체 보기", exact: true });
    await trigger.click();
    const drawer = page.getByRole("dialog", { name: "전체 로그", exact: true });
    await assertCustomerCards(drawer.getByRole("list", { name: "선택 층 운영 활동", exact: true }), width);
    await drawer.getByRole("button", { name: "다음 페이지", exact: true }).click();
    await expect(drawer.getByText("2페이지", { exact: true })).toBeVisible();
    await expect(drawer).toContainText("coverage 운영 기록 3");
    await drawer.getByRole("button", { name: "전체 로그 닫기", exact: true }).click();
    await expect(trigger).toBeFocused();
  }
});

for (const state of ["pending", "error", "empty", "paused"] as const) test(`coverage authenticated feature site ${state} and recovery`, async ({ page, designScenario }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await designScenario({ principal: "admin", state: "ready", theme: "light" });
  await installCustomerRoutes(page);
  // Authenticate first; a failing/paused auth gate cannot stand in for this
  // feature's LoadingState, query failure or recovered ready content.
  await page.goto("/monitoring?siteId=site-1");
  await expect(page.locator("[data-monitoring-screen]")).toBeVisible();
  let release: (() => void) | undefined;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let fail = state === "error";
  let failures = 0;
  const finalFailure = state === "error" ? page.waitForResponse(r => new URL(r.url()).pathname === "/api/sites/site-1/settings" && r.status() === 403 && ++failures === 4) : undefined;
  await page.route("**/api/sites/site-1/settings", async route => {
    if (state === "pending") await pending;
    await route.fulfill(fail ? { status: 403, json: { message: "coverage denied" } } : { json: siteSettings(state === "empty") }).catch(() => {});
  });
  if (state === "paused") await page.evaluate(() => {
    Object.defineProperty(navigator, "onLine", { configurable: true, get: () => false });
    window.dispatchEvent(new Event("offline"));
  });
  try {
    // Client-side navigation preserves the ready authenticated observer.
    await page.getByRole("link", { name: "설정", exact: true }).first().click();
    await page.getByRole("link", { name: "현장 관리", exact: true }).last().click();
    const section = page.getByRole("region", { name: "현장 관리", exact: true });
    if (state === "pending" || state === "paused") {
      const status = section.getByRole("status");
      await expect(status).toContainText(state === "paused" ? "네트워크 연결을 기다리고 있습니다." : "현장 운영 정보를 불러오는 중입니다.");
      if (state === "paused") {
        await expect(status).not.toHaveAttribute("aria-busy", "true");
        await expect(status.locator("svg.animate-spin")).toHaveCount(0);
      }
      release?.();
      if (state === "paused") await page.evaluate(() => {
        Object.defineProperty(navigator, "onLine", { configurable: true, get: () => true });
        window.dispatchEvent(new Event("online"));
      });
    } else if (state === "error") {
      await finalFailure;
      await expect(section.getByRole("alert")).toContainText("현장 운영 정보를 불러오지 못했습니다.");
      fail = false;
      await section.getByRole("button", { name: "다시 시도", exact: true }).click();
    }
    await expect(page.getByRole("heading", { name: "현장 구성", exact: true })).toBeVisible();
    if (state === "empty") await expect(section.getByText("운영 층 0개 · 보관 층 0개 · 등록 조명 0개", { exact: true })).toBeVisible();
    await expect(section).toHaveCSS("gap", "20px");
  } finally { release?.(); }
});

for (const state of ["pending", "paused", "error", "forbidden"] as const) test(`coverage auth gate ${state} is distinct from features`, async ({ page, designScenario }) => {
  await designScenario({ principal: "admin", state: state === "forbidden" ? "ready" : state });
  if (state === "forbidden") await page.route("**/api/auth/me", route => route.fulfill({ status: 403, json: { message: "coverage forbidden" } }));
  let failures = 0;
  const finalFailure = state === "error" ? page.waitForResponse(r => new URL(r.url()).pathname === "/api/auth/me" && r.status() === 503 && ++failures === 3) : undefined;
  await page.goto("/monitoring");
  if (state === "pending") {
    await expect(page.getByRole("main", { name: "인증 상태를 확인하는 중" })).toBeVisible();
    await expect(page.getByRole("status")).toContainText("화면을 불러오는 중입니다.");
  }
  else {
    if (finalFailure) await finalFailure;
    await expect(page.getByRole("alert")).toBeVisible();
    await expect(page.getByRole("heading", { level: 1 })).toBeFocused();
    await expect(page.locator("[data-monitoring-screen]")).toHaveCount(0);
  }
});

test("coverage public main contact uses real brand entry and functional dialog", async ({ page, designScenario }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await designScenario({ principal: "anonymous", state: "ready" });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/pricing");
  const trigger = page.getByRole("button", { name: /상담/ }).first();
  await trigger.click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toHaveCSS("padding", "16px");
  await expect(dialog.locator('a[href^="tel:"]')).toBeVisible();
  await expect(dialog.locator('a[href^="mailto:"]')).toBeVisible();
  await recordContrast(dialog.getByRole("heading").first(), "large-text");
  await screenshot(page, "public-contact-390");
  const backdrop = page.getByTestId("modal-backdrop");
  await expect(backdrop).toHaveCSS("position", "fixed");
  expect(await backdrop.boundingBox()).toEqual({ x: 0, y: 0, width: 390, height: 844 });
  await expect(dialog).toBeInViewport({ ratio: 1 });
  expect(await backdrop.evaluate(element => element.contains(document.elementFromPoint(1, 1)))).toBe(true);
  const close = dialog.getByRole("button", { name: "상담 팝업 닫기", exact: true });
  const closeBox = (await close.boundingBox())!;
  expect(closeBox.width).toBe(52); expect(closeBox.height).toBe(52);
  expect(await close.evaluate(element => {
    const box = element.getBoundingClientRect();
    return [[4, 4], [box.width - 4, 4], [4, box.height - 4], [box.width - 4, box.height - 4], [box.width / 2, box.height / 2]]
      .every(([x, y]) => element.contains(document.elementFromPoint(box.x + x, box.y + y)));
  })).toBe(true);
  await page.keyboard.press("Tab");
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.screenshot({ path: resolve(scratch, "task6-public-contact-viewport390.png"), fullPage: false });
  await page.keyboard.press("Escape");
  await expect(trigger).toBeFocused();
});

for (const width of [390, 1440]) test(`coverage forced password real ready pending failure and success ${width}`, async ({ page, designScenario }) => {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
  await designScenario({ principal: "admin", state: "ready" });
  await installCustomerRoutes(page);
  const user = { id: "admin-user-1", organizationId: "customer-org-1", organizationType: "customer", loginId: "admin_user", name: "고객 관리자", role: "admin", status: "active", mustChangePassword: true };
  await page.route("**/api/auth/me", route => route.fulfill({ json: { user } }));
  let release: (() => void) | undefined;
  const pending = new Promise<void>(resolve => { release = resolve; });
  let fail = true;
  await page.route("**/api/auth/change-password", async route => {
    expect(route.request().method()).toBe("POST");
    await pending;
    if (!fail) user.mustChangePassword = false;
    await route.fulfill(fail ? { status: 400, json: { message: "Current password is incorrect" } } : { json: { ok: true, user } });
  });
  await page.goto("/monitoring");
  const card = page.getByTestId("required-password-card");
  await expect(card).toHaveAttribute("data-password-stage", "ready");
  await expect(card).toHaveCSS("padding", width === 390 ? "16px" : "20px");
  for (const label of ["현재 임시 비밀번호", "새 비밀번호", "새 비밀번호 확인"]) await page.getByLabel(label, { exact: true }).fill("coverage-password");
  try {
    await card.getByRole("button", { name: "비밀번호 변경", exact: true }).click();
    await expect(card).toHaveAttribute("data-password-stage", "changing");
    await expect(card.getByRole("button", { name: "변경 중", exact: true })).toBeDisabled();
    await expect(card).toHaveCSS("padding", width === 390 ? "16px" : "20px");
  } finally { release?.(); }
  await expect(card).toHaveAttribute("data-password-stage", "failed");
  await expect(card.getByRole("alert")).toContainText("현재 비밀번호가 올바르지 않습니다.");
  await expect(page.getByLabel("현재 임시 비밀번호", { exact: true })).toBeFocused();
  for (const label of ["현재 임시 비밀번호", "새 비밀번호", "새 비밀번호 확인"]) {
    await expect(page.getByLabel(label, { exact: true })).toHaveValue("");
    await page.getByLabel(label, { exact: true }).fill("coverage-new-password");
  }
  fail = false;
  await card.getByRole("button", { name: "비밀번호 변경", exact: true }).click();
  await expect(page.locator("[data-monitoring-screen]")).toBeVisible();
  await expect(card).toHaveCount(0);
});

test("coverage foundation generated CSS keeps literal role values", async ({ page }) => {
  await withFoundationFixture(page, async () => {
    await expect(page.getByTestId("page-stack")).toHaveCSS("gap", "20px");
    await expect(page.getByTestId("card-grid")).toHaveCSS("gap", "18px");
    await expect(page.getByTestId("regular-panel")).toHaveCSS("padding", "20px");
    await expect(page.getByRole("heading", { name: "구역", exact: true })).toHaveCSS("font-size", "20px");
    await page.getByRole("button", { name: "확인", exact: true }).click();
    expect(await page.evaluate(() => (window as unknown as { foundationClicks: number }).foundationClicks)).toBe(1);
  });
});

async function installSecurity(page: Page) {
  await page.route("**/api/auth/mfa", r => r.fulfill({ json: { enabled: false, enabledAt: null } }));
  await page.route("**/api/auth/sessions", r => r.fulfill({ json: { sessions: [] } }));
}

function siteSettings(empty = false) {
  return { site: { id: "site-1", name: "coverage 현장", address: "서울", timeZone: "Asia/Seoul", currency: "KRW", tariffKwhRate: 158.75, updatedAt: "2026-10-01T00:00:00.000Z" },
    floors: empty ? [] : [1, 2].map(index => ({ id: `floor-${index}`, name: `B${index} 운영층`, level: -index, displayOrder: index, status: "active", fixtureCount: 0, activeGroupCount: 0, updatedAt: "2026-10-01T00:00:00.000Z" })) };
}

async function installCustomerRoutes(page: Page) {
  await installSecurity(page);
  await page.route("**/api/sites/site-1/settings", r => r.fulfill({ json: siteSettings() }));
  await page.route("**/api/sites/site-1/users", r => r.fulfill({ json: { users: [], count: 0, limit: 100 } }));
  await page.route("**/api/sites/site-1/fixture-groups*", r => r.fulfill({ json: [] }));
  await page.route("**/api/sites/site-1/floors/*/fixtures/settings*", r => r.fulfill({ json: { items: [], nextCursor: null } }));
  await page.route("**/api/sites/site-1/bio-sensor-policy", r => r.fulfill({ json: { siteId: "site-1", enabled: false, ownerUserId: null, maximumResponseSeconds: null, escalationAction: null, revision: 0 } }));
  await page.route("**/api/sites/site-1/automation/schedules?*", r => r.fulfill({ json: { items: [], total: 0, nextCursor: null } }));
  await page.route("**/api/sites/site-1/automation/vehicle-event-rules?*", r => r.fulfill({ json: { items: [], total: 0, nextCursor: null } }));
  await page.route("**/api/sites/site-1/temporary-controls?*", r => r.fulfill({ json: { items: [], nextCursor: null } }));
  await page.route("**/api/commands?*", r => r.fulfill({ json: { items: [], nextCursor: null, generatedAt: "2026-10-17T00:00:00.000Z", retainedFrom: "2026-07-17T00:00:00.000Z" } }));
  await page.route("**/api/sites/site-1/floors/floor-1/monitoring-activity?*", route => {
    const next = new URL(route.request().url()).searchParams.has("cursor");
    return route.fulfill({ json: { generatedAt: "2026-10-17T00:00:00.000Z", retainedFrom: "2026-07-17T00:00:00.000Z",
      items: [1, 2].map(n => ({ id: `60000000-0000-4000-8000-${String(n + (next ? 2 : 0)).padStart(12, "0")}`, kind: "fixture_online", recordedAt: "2026-10-17T00:00:00.000Z", displayName: `coverage 운영 기록 ${n + (next ? 2 : 0)}` })), nextCursor: next ? null : "coverage-page-2" } });
  });
}

async function installStatistics(page: Page) {
  await installFirstScreenStatisticsFixtures(page);
  await page.route("**/api/sites", r => r.fulfill({ json: [{ id: statisticsSite, name: "통계 현장", customerName: "고객사" }] }));
}

async function assertCustomerCards(list: Locator, width: number) {
  await expect(list).toBeVisible();
  await expect(list).toHaveCSS("gap", "18px");
  await expect(list.getByRole("listitem")).toHaveCount(2);
  for (const card of await list.getByRole("listitem").all()) await expect(card).toHaveCSS("padding", width < 760 ? "16px" : "20px");
}

async function screenshot(page: Page, name: string) {
  await page.screenshot({ path: resolve(scratch, `task6-${name}.png`), fullPage: true });
}

// Measure actual solid computed colors, preserving raw layers. Gradient or
// opacity groups need a separate pixel analysis and must never earn token AA.
async function colors(locator: Locator) {
  return locator.evaluate(element => {
    const style = getComputedStyle(element);
    const layers: Array<{ background: string; opacity: string; image: string }> = [];
    for (let current: Element | null = element; current; current = current.parentElement) {
      const css = getComputedStyle(current);
      layers.push({ background: css.backgroundColor, opacity: css.opacity, image: css.backgroundImage });
    }
    const rgba = (value: string) => {
      if (!/^rgba?\(/.test(value)) throw new Error(`A visible non-sRGB layer requires separate pixel analysis: ${value}`);
      const n = value.match(/[\d.]+/g)!.map(Number); return [n[0], n[1], n[2], n[3] ?? 1];
    };
    const blend = (top: number[], bottom: number[]) => top.slice(0, 3).map((value, index) => value * top[3] + bottom[index] * (1 - top[3]));
    let background = [255, 255, 255];
    // An opaque panel fully occludes the backdrop. Do not interpret hidden
    // OKLab colors as RGB merely because they appear in the ancestor trace.
    const opaque = layers.findIndex(layer => /^rgb\(/.test(layer.background));
    const painted = opaque < 0 ? layers : layers.slice(0, opaque + 1);
    for (const layer of painted.slice().reverse()) background = blend(rgba(layer.background), background);
    const foreground = blend(rgba(style.color), background);
    const luminance = (color: number[]) => color.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const a = luminance(foreground), b = luminance(background);
    return { color: style.color, fontSize: style.fontSize, fontWeight: style.fontWeight, layers, compositedLayerCount: painted.length, foreground, background, ratio: layers.every(layer => layer.opacity === "1") ? (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) : null, disabled: element.matches(":disabled,[aria-disabled=true]") };
  });
}

async function recordContrast(locator: Locator, classification: "normal-text" | "large-text" | "disabled-action-exempt") {
  await expect(locator).toBeAttached();
  const raw = await colors(locator);
  await test.info().attach(`contrast-${classification}`, { body: JSON.stringify({ classification, ...raw }, null, 2), contentType: "application/json" });
  if (classification === "disabled-action-exempt") { expect(raw.disabled).toBe(true); return; }
  assertSolidTrace(raw);
  if (classification === "large-text") expect(Number.parseFloat(raw.fontSize) >= 24 || Number(raw.fontWeight) >= 700 && Number.parseFloat(raw.fontSize) >= 56 / 3).toBe(true);
  expect(raw.ratio).toBeGreaterThanOrEqual(classification === "large-text" ? 3 : 4.5);
}

async function recordControlBoundary(button: Locator) {
  const fill = await colors(button), parent = await colors(button.locator(".."));
  const luminance = (color: number[]) => color.map(value => value / 255).map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
  const a = luminance(fill.background), b = luminance(parent.background);
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  await test.info().attach("primary-control-nontext-boundary", { body: JSON.stringify({ fill, parent, ratio }, null, 2), contentType: "application/json" });
  assertSolidTrace(fill);
  assertSolidTrace(parent);
  expect(ratio).toBeGreaterThanOrEqual(3);
}

function assertSolidTrace(raw: Awaited<ReturnType<typeof colors>>) {
  expect(raw.layers.every(layer => layer.opacity === "1" && layer.image === "none"), "solid backgrounds without opacity groups").toBe(true);
}

for (const [target, effect] of [["fill", "opacity"], ["fill", "gradient"], ["adjacent", "opacity"], ["adjacent", "gradient"]] as const) {
  test(`nontext contrast rejects ${target} ${effect} despite a high solid-color ratio`, async ({ page }) => {
    await page.goto("/");
    await page.setContent('<main style="background:white"><button style="background:black;color:white">contrast probe</button></main>');
    const button = page.getByRole("button", { name: "contrast probe" });
    await (target === "fill" ? button : button.locator("..")).evaluate((element, effect) => {
      (element as HTMLElement).style[effect === "opacity" ? "opacity" : "backgroundImage"] = effect === "opacity" ? "0.5" : "linear-gradient(black, white)";
    }, effect);
    await expect(recordControlBoundary(button)).rejects.toThrow("solid backgrounds without opacity groups");
  });
}
