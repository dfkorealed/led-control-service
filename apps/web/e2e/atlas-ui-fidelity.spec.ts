import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { createDimmingCommandSchema } from "@led-control/shared";
import { mockDashboard } from "../src/test/fixtures";
import type { SiteSettingsResponse } from "../src/api/site-settings";
import { commandDetailClockFixture, installSettingsApiRoutes } from "./support/settings-api";
import { installMockApiBoundary } from "./support/mock-api-boundary";
import { browserReport, installFirstScreenStatisticsFixtures } from "./support/first-screen-statistics";
import { expectMinimumTouchTargets, expectMinimumTouchTargetsAfterScrolling, expectNoHorizontalOverflow } from "./support/layout-assertions";

const siteId = mockDashboard.site.id;
const floorId = mockDashboard.floors[0].id;
const gatewayId = mockDashboard.gateways[0].id;
const fixtures = mockDashboard.floors[0].fixtures;
const themeKey = "led-control.customer-theme.v1";
const longSite = "고객사 B2 현장 입구 물류센터 조명 관리 구역".repeat(3);
const commandId = "77777777-7777-4777-8777-777777777777";
const roots = ["monitoring", "control", "statistics", "settings"] as const;

// Preparation only: no lab, backend or device transport. A later fixture gap
// remains a local 404, and every mutation is observed even if its fixture fails.
test.beforeEach(async ({ context, baseURL }) => {
  expect(process.env.E2E_REAL_BACKEND_LAB).not.toBe("1");
  expect(baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  expect(["5173", "4000", "63200"]).not.toContain(new URL(baseURL!).port);
  await installMockApiBoundary(context, baseURL);
});

async function customer(page: Page, role: "admin" | "viewer" = "admin", statistics = false) {
  const writes: Array<{ method: string; path: string; body: string | null }> = [];
  page.on("request", request => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/api/") && !["GET", "HEAD"].includes(request.method()))
      writes.push({ method: request.method(), path: url.pathname, body: request.postData() });
  });
  const api = await installSettingsApiRoutes(page, role, {
    ids: { siteId, floorId, gatewayId }, fixtures, readyMapDocument: true, commandId
  });
  // Statistics owns energy-specific routes after settings' general API route,
  // but precedes our authoritative dashboard: its helper is otherwise floorless.
  if (statistics) await installFirstScreenStatisticsFixtures(page);
  const dashboard = structuredClone(mockDashboard);
  dashboard.capabilities = { read: true, control: true, manage: role === "admin", commission: role === "admin" };
  dashboard.floors = [{ ...dashboard.floors[0], mapRevision: 7, mapConfigured: true }];
  dashboard.groups = [];
  await page.route(`**/api/sites/${siteId}/dashboard*`, route => route.request().method() === "GET"
    ? route.fulfill({ json: dashboard }) : route.fallback());
  await page.route("**/api/sites", route => route.request().method() === "GET"
    ? route.fulfill({ json: [{ id: siteId, name: longSite, customerName: "고객사" }] }) : route.fallback());
  // The general settings fixture owns editor/auth routes, not operating metadata.
  // Complete read-only DTO mirrors the existing settings-operations fixture.
  const operatingSettings: SiteSettingsResponse = {
    site: { id: siteId, name: "본사 주차장", address: "서울시 중구 세종대로 1", timeZone: "Asia/Seoul",
      currency: "KRW", tariffKwhRate: 158.75, updatedAt: "2026-09-12T00:00:00.000Z" },
    floors: [{ id: floorId, name: mockDashboard.floors[0].name, level: -2, displayOrder: 1,
      status: "active", fixtureCount: fixtures.length, activeGroupCount: 0, updatedAt: "2026-09-12T00:00:00.000Z" }]
  };
  await page.route(`**/api/sites/${siteId}/settings`, route => route.request().method() === "GET"
    ? route.fulfill({ json: operatingSettings }) : route.fallback());
  await page.route(`**/api/sites/${siteId}/users`, route => route.request().method() === "GET"
    ? route.fulfill({ json: { users: [], count: 0, limit: 100 } }) : route.fallback());
  await page.route(`**/api/sites/${siteId}/floors/${floorId}/fixtures/settings?**`, route => route.request().method() === "GET"
    ? route.fulfill({ json: { items: [], nextCursor: null } }) : route.fallback());
  await page.route("**/api/commands?**", route => route.request().method() === "GET"
    ? route.fulfill({ json: { items: [], nextCursor: null, generatedAt: commandDetailClockFixture.generatedAt,
      retainedFrom: commandDetailClockFixture.retainedFrom, retentionEnabled: false } }) : route.fallback());
  await page.route(`**/api/sites/${siteId}/floors/${floorId}/monitoring-activity?**`, route => route.request().method() === "GET"
    ? route.fulfill({ json: { items: [{ id: commandId, kind: "fixture_online", fixtureId: fixtures[0].id, displayName: fixtures[0].name,
      recordedAt: commandDetailClockFixture.generatedAt }], nextCursor: null, generatedAt: commandDetailClockFixture.generatedAt,
      retainedFrom: commandDetailClockFixture.retainedFrom } }) : route.fallback());
  return { api, writes };
}

async function theme(page: Page, value: "light" | "dark") {
  await page.addInitScript(({ key, value }) => localStorage.setItem(key, value), { key: themeKey, value });
}

async function toggleTheme(page: Page) {
  const dark = await page.locator("html").getAttribute("data-customer-theme") === "dark";
  await page.getByRole("button", { name: dark ? "라이트 모드로 변경" : "다크 모드로 변경", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-customer-theme", dark ? "light" : "dark");
}

async function toggleFromCustomerTab(page: Page) {
  const original = await page.locator("html").getAttribute("data-customer-theme");
  const other = await page.context().newPage();
  try {
    const { writes } = await customer(other);
    await other.goto(`${new URL(page.url()).origin}/settings?siteId=${siteId}`);
    await expect(other.locator("html")).toHaveAttribute("data-customer-theme", original!);
    await toggleTheme(other);
    await expect(page.locator("html")).toHaveAttribute("data-customer-theme", original === "dark" ? "light" : "dark");
    expect(writes).toEqual([]);
  } finally { await other.close(); }
}

async function evidence(page: Page, info: TestInfo, name: string, metrics: unknown = {}) {
  const imagePath = info.outputPath(`${name}.png`), metricsPath = info.outputPath(`${name}-metrics.json`);
  await page.screenshot({ path: imagePath });
  await writeFile(metricsPath, JSON.stringify({ url: page.url(), viewport: page.viewportSize(), metrics }, null, 2));
  await info.attach(name, { path: imagePath, contentType: "image/png" });
  await info.attach(`${name}-metrics`, { path: metricsPath, contentType: "application/json" });
}

async function documentFits(page: Page, fixed = false) {
  await expectNoHorizontalOverflow(page);
  if (fixed) expect(await page.evaluate(() => ({ height: document.scrollingElement!.scrollHeight,
    viewport: innerHeight, y: scrollY }))).toEqual({ height: 600, viewport: 600, y: 0 });
}

async function rootReady(page: Page, menu: typeof roots[number]) {
  await expect(page.getByRole("region", { name: "현장 전체", exact: true }).getByText("16대", { exact: true })).toBeVisible();
  if (menu === "monitoring" || menu === "control") {
    const map = page.getByTestId(menu === "monitoring" ? "monitoring-map-viewport" : "target-selection-map-viewport");
    await expect(map.locator("canvas").first()).toBeVisible();
    await expect(page.getByRole("button", { name: menu === "monitoring" ? /맵 선택/ : /표시 층/ })).toContainText("B2");
  } else if (menu === "statistics") {
    await expect(page.getByRole("group", { name: "에너지 요약", exact: true })).toContainText("4.25");
    await expect(page.getByRole("img", { name: "일별 상태 기반 추정 전력 사용량 꺾은선 차트", exact: true }).locator("svg").first()).toBeVisible();
    await expect(page.getByRole("list", { name: "차트 데이터 및 수집 상태", exact: true })).toContainText("2026년 8월 25일: 4.1 kWh");
  } else {
    for (const label of ["현장 관리", "유저 관리", "조명 등록", "맵 관리", "계정 보안"])
      await expect(page.getByRole("link", { name: label, exact: true }).last()).toBeVisible();
    await expect(page.getByRole("link", { name: "유저 관리", exact: true }).last()).toContainText("사용자 0명");
  }
}

test("PC four roots own one visible h1 and settings/statistics subnav retain URL scope", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await theme(page, "light");
  const { writes } = await customer(page, "admin", true);
  for (const menu of roots) {
    await page.goto(`/${menu}?siteId=${siteId}&keep=value#fidelity`);
    await expect(page.locator("[data-shell-navigation=desktop]")).toBeVisible();
    await expect(page.locator("h1:visible")).toHaveCount(1);
    await rootReady(page, menu);
    await documentFits(page); await evidence(page, info, `pc-${menu}`);
    if (menu === "control") {
      const tabs = page.getByRole("tablist", { name: "제어 방식", exact: true });
      await expect(tabs.getByRole("tab")).toHaveCount(4);
      await tabs.getByRole("tab", { name: "그룹/구역", exact: true }).click();
      await expect(tabs.getByRole("tab", { name: "그룹/구역", exact: true })).toHaveAttribute("aria-selected", "true");
      const scope = new URL(page.url()); expect(scope.searchParams.get("keep")).toBe("value"); expect(scope.hash).toBe("#fidelity");
    }
  }
  for (const [path, nav] of [["/settings/site", "설정 메뉴"], ["/statistics/analysis", "통계 메뉴"]]) {
    await page.goto(`${path}?siteId=${siteId}&keep=value#fidelity`);
    const links = page.getByRole("navigation", { name: nav }).getByRole("link");
    await expect(links.first()).toBeVisible();
    for (const link of await links.all()) {
      const href = new URL((await link.getAttribute("href"))!, page.url());
      expect(href.searchParams.get("siteId")).toBe(siteId); expect(href.searchParams.get("keep")).toBe("value"); expect(href.hash).toBe("#fidelity");
    }
    await expect(page.locator("h1:visible")).toHaveCount(1);
  }
  expect(writes).toEqual([]);
});

for (const width of [320, 390, 562, 759, 760]) test(`responsive ${width}: branding plain current site and monitoring refresh precede map`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 }); await theme(page, "light"); const { writes } = await customer(page);
  await page.goto(`/monitoring?siteId=${siteId}`);
  const compact = width < 760;
  await expect(page.locator(`[data-shell-navigation=${compact ? "compact" : "desktop"}]`)).toBeVisible();
  await expect(page.locator(`[data-shell-navigation=${compact ? "desktop" : "compact"}]`)).toHaveCount(0);
  const topbar = page.locator("[data-shell-topbar]");
  const logo = (compact ? topbar : page.locator("[data-shell-navigation=desktop]")).locator("[data-kinda-logo-mark]");
  await expect(logo).toBeVisible(); await expect(logo).toHaveAttribute("src", "/brand/kinda-mark.svg");
  await expect(topbar.locator("[data-shell-context]")).toContainText(`고객사 · ${longSite}`);
  await expect(topbar.getByRole("button", { name: /현장 선택/ })).toHaveCount(0);
  await expect(page.getByRole("listbox")).toHaveCount(0); await documentFits(page);
  const map = page.getByTestId("monitoring-map-viewport"); await expect(map.locator("canvas").first()).toBeVisible();
  const refresh = page.getByRole("button", { name: "새로고침", exact: true });
  const refreshBox = (await refresh.boundingBox())!, mapBox = (await map.boundingBox())!;
  expect(refreshBox.y + refreshBox.height).toBeLessThanOrEqual(mapBox.y);
  await expectMinimumTouchTargets(page, "[data-shell-topbar] button"); await documentFits(page);
  await evidence(page, info, `responsive-${width}-monitoring`); expect(writes).toEqual([]);
});

test("short manual recovery keeps map viewport 240, CTA reachable and draft/tools/theme/resize write-free", async ({ page }, info) => {
  await page.setViewportSize({ width: 1024, height: 600 }); await theme(page, "light"); const { writes } = await customer(page, "viewer");
  await page.route("**/api/commands/dimming", route => {
    createDimmingCommandSchema.parse(route.request().postDataJSON());
    return route.fulfill({ json: { id: commandId, dispatchCount: 1, selectedTargetCount: 1,
      transmissionCount: 1, deliveryMode: "unicast", terminalStatusUrl: `/commands/${commandId}` } });
  });
  await page.route(`**/api/commands/${commandId}`, route => route.fulfill({ json: {
    id: commandId, siteId, stage: "verification_required", outcome: "unknown", targetType: "fixtures",
    targetFixtureIds: [fixtures[0].id], brightness: 30, verificationAttemptCount: 0, dispatchCount: 1,
    totalFixtureCount: 1, completedFixtureCount: 1, createdAt: commandDetailClockFixture.createdAt,
    generatedAt: commandDetailClockFixture.generatedAt, retainedFrom: commandDetailClockFixture.retainedFrom,
    retentionEnabled: false, errorMessage: "실제 상태를 확인해야 합니다. ".repeat(30),
    dispatches: [{ id: "original-dispatch", kind: "dimming", status: "timed_out", gateway: { id: gatewayId, name: "Gateway B2" },
      errorMessage: null, results: [{ fixtureId: fixtures[0].id, fixtureName: fixtures[0].name, status: "timed_out", brightness: 70, errorMessage: null }] }]
  } }));
  await page.goto(`/control?siteId=${siteId}`);
  await page.getByRole("button", { name: "조명 목록 열기", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "조명 목록", exact: true });
  const choice = drawer.getByRole("checkbox", { name: `${fixtures[0].name} 선택`, exact: true });
  // The native input is visually covered by its real React Aria label/indicator.
  // Activate that associated label, then assert the same input's selection.
  await choice.locator("xpath=ancestor::label").click(); await expect(choice).toBeChecked();
  await drawer.getByRole("button", { name: "선택 완료", exact: true }).click();
  const input = page.getByRole("textbox", { name: "밝기 수치", exact: true }); await input.fill("30"); await input.press("Enter");
  expect(writes).toEqual([]);
  await page.getByRole("button", { name: "1개 조명에 밝기 적용", exact: true }).click();
  const retry = page.getByRole("button", { name: "실제 상태 확인", exact: true }); await expect(retry).toBeEnabled();
  const original = structuredClone(writes); expect(original).toHaveLength(1);
  const map = page.getByTestId("target-selection-map-viewport");
  const canvas = map.locator("canvas").first(); const handle = await canvas.elementHandle();
  await page.getByRole("button", { name: "지도 확대", exact: true }).click(); await toggleTheme(page);
  await page.setViewportSize({ width: 1100, height: 600 }); await page.setViewportSize({ width: 1024, height: 600 });
  expect(await canvas.evaluate((node, originalNode) => node === originalNode, handle)).toBe(true);
  await expect(map).toHaveAttribute("data-zoom", "1.1");
  await expect(input).toHaveValue("30");
  expect((await map.boundingBox())!.height).toBeGreaterThanOrEqual(240);
  // Long recovery content intentionally owns an internal scroll pane. Inspect
  // every action after bringing that action into view, not a clipped neighbour.
  await retry.scrollIntoViewIfNeeded(); await expectMinimumTouchTargetsAfterScrolling(page, "[data-command-status-region]");
  await documentFits(page, true); await evidence(page, info, "short-manual-recovery", { writes }); expect(writes).toEqual(original);
});

test("dark four roots plain site information and real alarm portal inherit the customer palette", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await theme(page, "dark"); const { writes } = await customer(page, "admin", true);
  for (const menu of roots) {
    await page.goto(`/${menu}?siteId=${siteId}`); await expect(page.locator("html")).toHaveAttribute("data-customer-theme", "dark");
    await rootReady(page, menu);
    const topbar = page.locator("[data-shell-topbar]"); await expect(topbar).toHaveCSS("background-color", "rgb(24, 35, 52)");
    await expect(page.locator("[data-app-shell]")).toHaveCSS("background-color", "rgb(15, 23, 36)");
    await evidence(page, info, `dark-${menu}`);
  }
  await expect(page.locator("[data-shell-context]")).toContainText(`고객사 · ${longSite}`);
  await expect(page.getByRole("button", { name: /현장 선택/ })).toHaveCount(0);
  await expect(page.getByRole("listbox")).toHaveCount(0);
  await page.getByRole("button", { name: /^알람센터/ }).click();
  const alarm = page.getByRole("dialog", { name: "알람센터", exact: true }); await expect(alarm).toBeVisible();
  await evidence(page, info, "dark-alarm-portal"); expect(writes).toEqual([]);
});

test("both monitoring finder entries share query/filter and restore the actual opener", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); const { writes } = await customer(page);
  await page.goto(`/monitoring?siteId=${siteId}`);
  const search = page.getByRole("button", { name: "조명 검색·상세", exact: true }); const list = page.getByRole("button", { name: "조명 목록", exact: true });
  await search.click(); const popover = page.getByRole("dialog", { name: "조명 검색·상세", exact: true });
  await popover.getByRole("searchbox", { name: "조명 이름 또는 번호 검색", exact: true }).fill(fixtures[0].name);
  await popover.getByRole("button", { name: /상태 필터/ }).click(); await page.getByRole("option", { name: "정상", exact: true }).click();
  await popover.getByRole("button", { name: "조명 검색·상세 닫기", exact: true }).click(); await expect(search).toBeFocused();
  await list.click(); await expect(popover.getByRole("searchbox")).toHaveValue(fixtures[0].name);
  await expect(popover.getByRole("list", { name: "조명 목록", exact: true })).toBeVisible();
  await expect(popover.getByRole("button", { name: /상태 필터/ })).toContainText("정상");
  await toggleFromCustomerTab(page); await evidence(page, info, "finder-shared-state");
  await popover.getByRole("button", { name: "조명 검색·상세 닫기", exact: true }).click(); await expect(list).toBeFocused(); expect(writes).toEqual([]);
});

test("settings edit/password dialogs cancel to opener while independent MFA draft survives theme", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 }); const { writes } = await customer(page);
  await page.goto(`/settings/site?siteId=${siteId}`);
  const edit = page.getByRole("button", { name: "현장 정보 수정", exact: true }); await edit.click();
  const dialog = page.getByRole("dialog", { name: "현장 정보 수정", exact: true }); await dialog.getByRole("textbox", { name: "현장명", exact: true }).fill("변경하지 않는 draft");
  // The modal makes this tab's header inert. A second controlled customer tab
  // uses its real theme button; CustomerThemeProvider receives the browser's
  // native storage event. No force click, synthetic event or HTML theme write.
  await toggleFromCustomerTab(page);
  await expect(dialog.getByRole("textbox", { name: "현장명", exact: true })).toHaveValue("변경하지 않는 draft");
  await evidence(page, info, "settings-site-edit-open");
  await dialog.getByRole("button", { name: "취소", exact: true }).click(); await expect(edit).toBeFocused();
  expect(writes).toEqual([]);
  await page.route("**/api/auth/mfa", route => route.fulfill({ json: { enabled: false, enabledAt: null } }));
  await page.route("**/api/auth/sessions", route => route.fulfill({ json: { sessions: [] } }));
  await page.route("**/api/auth/mfa/enrollment", route => route.fulfill({ json: { enrollmentToken: "fidelity-enrollment", secret: "FIDELITYFIXTURESECRET",
    otpauthUri: "otpauth://totp/LED%20Control:fidelity?secret=FIDELITYFIXTURESECRET", expiresAt: "2099-10-07T00:00:00.000Z" } }));
  await page.goto(`/settings/security?siteId=${siteId}`); await page.getByRole("button", { name: "2단계 인증 설정", exact: true }).click();
  const code = page.getByLabel("인증 앱 코드", { exact: true }); await code.fill("654321"); const codeNode = await code.elementHandle();
  const before = structuredClone(writes); expect(before).toHaveLength(1); expect(before[0].path).toBe("/api/auth/mfa/enrollment");
  const password = page.getByRole("button", { name: "비밀번호 변경", exact: true }); await password.click();
  const passwordDialog = page.getByRole("dialog", { name: "비밀번호 변경", exact: true });
  await passwordDialog.getByLabel("현재 비밀번호", { exact: true }).fill("fixture-current");
  await toggleFromCustomerTab(page);
  await expect(passwordDialog.getByLabel("현재 비밀번호", { exact: true })).toHaveValue("fixture-current");
  await evidence(page, info, "settings-password-dialog-open");
  await page.keyboard.press("Escape"); await expect(password).toBeFocused();
  expect(await code.evaluate((node, original) => node === original, codeNode)).toBe(true); await expect(code).toHaveValue("654321");
  expect(writes).toEqual(before); expect(await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }))).not.toContain("FIDELITYFIXTURESECRET");
  await evidence(page, info, "settings-dialog-and-MFA-owner");
});

test("statistics actual zero and missing heatmap remain distinct through selection and theme", async ({ page }, info) => {
  const { writes } = await customer(page); await installFirstScreenStatisticsFixtures(page);
  await page.goto(`/statistics/analysis?siteId=${siteId}`);
  const heatmap = page.getByRole("group", { name: "시간대별 에너지 사용량", exact: true });
  const zero = heatmap.getByRole("button").nth(0), missing = heatmap.getByRole("button").nth(1);
  await expect(zero).toContainText("0"); await expect(missing).toContainText("—");
  await zero.click(); await expect(zero).toHaveAttribute("aria-pressed", "true");
  await missing.click(); await expect(missing).toHaveAttribute("aria-pressed", "true");
  await expect(zero).toHaveAttribute("aria-label", /평균 0 kWh/);
  await expect(missing).toHaveAttribute("aria-label", /평균 산정 불가/);
  await toggleTheme(page); await expect(missing).toContainText("—"); await documentFits(page);
  await evidence(page, info, "statistics-zero-not-gap"); expect(writes).toEqual([]);
});

test("gallery draws bounded readonly snapshots and disposes canvas on navigation without editor writes", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 }); const { api, writes } = await customer(page);
  await page.goto(`/settings/floor-plans?siteId=${siteId}&keep=value#gallery`);
  const cards = page.getByTestId("floor-plan-item"); await expect(cards.first()).toBeVisible();
  const preview = cards.first().getByRole("img", { name: `${mockDashboard.floors[0].name} 도면 미리보기`, exact: true });
  await expect(preview).toBeVisible(); await expect(preview.locator("canvas").first()).toBeVisible();
  expect((await preview.boundingBox())!.height).toBe(176);
  await expect(preview.locator("[inert][aria-hidden=true]")).toHaveCount(1);
  await expect(preview.getByRole("button", { includeHidden: true })).toHaveCount(0);
  expect(await cards.getByRole("img").count()).toBeLessThanOrEqual(2);
  const node = await preview.locator("canvas").first().elementHandle();
  const snapshots = api.mapSnapshotRequests; expect(snapshots).toBeGreaterThan(0); expect(api.editorRequests).toEqual([]);
  await toggleTheme(page); await page.setViewportSize({ width: 1024, height: 768 });
  expect(api.mapSnapshotRequests).toBe(snapshots);
  expect(api.editorRequests).toEqual([]); expect(writes).toEqual([]);
  await evidence(page, info, "gallery-real-snapshot", { snapshots: api.mapSnapshotRequests });
  const history = cards.first().getByRole("link", { name: `${mockDashboard.floors[0].name} 변경 기록`, exact: true });
  const href = new URL((await history.getAttribute("href"))!, page.url());
  expect(href.searchParams.get("editorPanel")).toBe("details"); expect(href.searchParams.get("keep")).toBe("value"); expect(href.hash).toBe("#gallery");
  // Leave through the existing navigation: no lease initialization or restore intent.
  await page.getByRole("navigation", { name: "설정 메뉴" }).getByRole("link", { name: "현장 관리", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/settings/site\\?siteId=${siteId}`));
  await expect.poll(() => node!.evaluate(element => element.isConnected)).toBe(false);
  expect(api.editorRequests).toEqual([]); expect(writes).toEqual([]);
});

// This seven-case correction suite intentionally does not replay Tasks 1–12.
// Each case owns controlled fixture reads and checks that pure UI emits no writes.
async function visibleAction(page: Page, target: Locator) {
  await target.scrollIntoViewIfNeeded(); await expect(target).toBeVisible();
  const measure = () => target.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const nav = document.querySelector<HTMLElement>("[data-shell-navigation=compact]");
    const header = document.querySelector<HTMLElement>("[data-shell-topbar]");
    const navTop = nav?.getBoundingClientRect().top ?? innerHeight;
    const headerBottom = header?.getBoundingClientRect().bottom ?? 0;
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    const scrollContainers = [];
    for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
      const overflowY = getComputedStyle(ancestor).overflowY;
      if (["auto", "scroll"].includes(overflowY) || ancestor.scrollHeight > ancestor.clientHeight)
        scrollContainers.push({ tag: ancestor.tagName, label: ancestor.getAttribute("aria-label"), overflowY,
          scrollHeight: ancestor.scrollHeight, clientHeight: ancestor.clientHeight, scrollTop: ancestor.scrollTop,
          maximum: ancestor.scrollHeight - ancestor.clientHeight });
    }
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height,
      bottom: rect.bottom, right: rect.right, navTop, headerBottom, viewportWidth: innerWidth,
      scrollY, documentHeight: document.scrollingElement!.scrollHeight, scrollContainers,
      reachable: Boolean(hit && element.contains(hit)) };
  });
  let bounds = await measure(); const scrolls = [bounds];
  // Browser auto-scroll only considers the viewport, not the sticky header or
  // fixed mobile navigation. Use real document wheel input to expose the whole
  // action, then keep exactly the same full visibility and 44px requirements.
  for (let attempt = 0; attempt < 3 && (bounds.bottom > bounds.navTop || bounds.y < bounds.headerBottom); attempt += 1) {
    const delta = bounds.bottom > bounds.navTop ? bounds.bottom - bounds.navTop + 24 : bounds.y - bounds.headerBottom - 24;
    await page.mouse.move(2, Math.max(bounds.headerBottom + 1, Math.min(bounds.navTop - 1, page.viewportSize()!.height / 2)));
    await page.mouse.wheel(0, delta);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const next = await measure(); scrolls.push(next);
    if (next.scrollY === bounds.scrollY) { bounds = next; break; }
    bounds = next;
  }
  expect(bounds.y).toBeGreaterThanOrEqual(bounds.headerBottom);
  expect(bounds.bottom, JSON.stringify({ bounds, scrolls })).toBeLessThanOrEqual(bounds.navTop);
  expect(bounds.x).toBeGreaterThanOrEqual(0); expect(bounds.right).toBeLessThanOrEqual(bounds.viewportWidth);
  expect(bounds.height).toBeGreaterThanOrEqual(44); expect(bounds.width).toBeGreaterThanOrEqual(44);
  expect(bounds.reachable).toBe(true);
  return { ...bounds, scrolls };
}

async function centeredColumns(table: Locator) {
  const headers = table.locator("thead th"), cells = table.locator("tbody tr").first().locator("td");
  const alignments = [];
  for (let index = 1; index < await headers.count(); index += 1) {
    await expect(headers.nth(index)).toHaveCSS("text-align", "center");
    await expect(cells.nth(index)).toHaveCSS("text-align", "center");
    const sort = headers.nth(index).getByRole("button");
    if (await sort.count()) await expect(sort).toHaveCSS("justify-content", "center");
    alignments.push({ header: await headers.nth(index).innerText(), headerBounds: await headers.nth(index).boundingBox(), cellBounds: await cells.nth(index).boundingBox() });
  }
  return alignments;
}

for (const width of [578, 681]) test(`browser comments tall mobile ${width}: settled map fills remaining shell height`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 1227 }); await theme(page, "light"); const { writes } = await customer(page);
  await page.goto(`/monitoring?siteId=${siteId}`); await rootReady(page, "monitoring");
  const ticker = page.getByRole("region", { name: "최근 운영 로그", exact: true });
  await expect(ticker).not.toContainText("불러오는 중");
  const map = (await page.getByTestId("monitoring-map-viewport").boundingBox())!;
  const panel = (await page.locator("[data-monitoring-map-panel]").boundingBox())!;
  const nav = (await page.locator("[data-shell-navigation=compact]").boundingBox())!;
  expect(map.height).toBeGreaterThan(500); expect(panel.y + panel.height).toBeLessThanOrEqual(nav.y);
  expect(nav.y - (panel.y + panel.height)).toBeLessThanOrEqual(24);
  const cells = await page.getByRole("region", { name: "현장 전체", exact: true }).locator("dl > div").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().width));
  expect(Math.max(...cells) - Math.min(...cells)).toBeLessThanOrEqual(1);
  await expect(page.getByText("ATLAS / OPERATIONS", { exact: true })).toHaveCount(0);
  const actions = { zoom: await visibleAction(page, page.getByRole("button", { name: "지도 확대", exact: true })),
    logs: await visibleAction(page, ticker.getByRole("button").first()) };
  await expectMinimumTouchTargets(page, "[data-shell-navigation=compact]"); await documentFits(page);
  await evidence(page, info, `comments-tall-${width}`, { map, panel, nav, cells, actions, writes }); expect(writes).toEqual([]);
});

test("browser comments short mobile: natural scroll exposes monitoring and manual actions", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 600 }); await theme(page, "light"); const { writes } = await customer(page);
  await page.goto(`/monitoring?siteId=${siteId}`); await rootReady(page, "monitoring");
  const map = page.getByTestId("monitoring-map-viewport"); expect((await map.boundingBox())!.height).toBeGreaterThanOrEqual(240);
  expect(await page.evaluate(() => document.scrollingElement!.scrollHeight)).toBeGreaterThan(600);
  const zoomBefore = await map.getAttribute("data-zoom");
  await page.mouse.move(2, 400); await page.mouse.wheel(0, 450);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(0);
  await expect(map).toHaveAttribute("data-zoom", zoomBefore!);
  const ticker = page.getByRole("region", { name: "최근 운영 로그", exact: true }); await expect(ticker).not.toContainText("불러오는 중");
  const logs = await visibleAction(page, ticker.getByRole("button").first());
  await documentFits(page); await evidence(page, info, "comments-short-monitoring", { logs, writes });
  await page.goto(`/control?siteId=${siteId}`); await rootReady(page, "control");
  const input = page.getByRole("textbox", { name: "밝기 수치", exact: true }); await input.fill("31"); await input.press("Enter");
  const actions = {} as Record<string, unknown>;
  for (const name of ["조명 목록 열기", "이동", "개별 선택", "영역 선택", "지도 확대"])
    actions[name] = await visibleAction(page, page.getByRole("button", { name, exact: true }));
  await expect(input).toHaveValue("31"); expect((await page.getByTestId("target-selection-map-viewport").boundingBox())!.height).toBeGreaterThanOrEqual(240);
  await input.scrollIntoViewIfNeeded(); await documentFits(page); await evidence(page, info, "comments-short-manual", { actions, writes }); expect(writes).toEqual([]);
});

test("browser comments PC: current site is plain information and header metrics stay compact", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await theme(page, "dark"); const { writes } = await customer(page);
  await page.goto(`/monitoring?siteId=${siteId}&keep=value#comments`); await rootReady(page, "monitoring");
  await expect(page.getByRole("button", { name: /현장 선택/ })).toHaveCount(0); await expect(page.getByRole("listbox")).toHaveCount(0);
  await expect(page.locator("[data-shell-context]")).toContainText(`고객사 · ${longSite}`);
  await expect(page.getByText("ATLAS / OPERATIONS", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "모니터링", exact: true })).toBeVisible();
  await expect(page.locator("[data-operation-map-chrome]").getByRole("heading")).toHaveCount(0);
  const measurements = [];
  for (const width of [1440, 1280, 760]) {
    await page.setViewportSize({ width, height: 900 }); await rootReady(page, "monitoring");
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    const metrics = await page.locator("[data-shell-topbar]").evaluate(header => {
      const rect = (element: Element) => { const box = element.getBoundingClientRect(); return { x: box.x, y: box.y, right: box.right, bottom: box.bottom, width: box.width, height: box.height }; };
      const context = header.querySelector("[data-shell-context]")!, summary = header.querySelector("[aria-label='현장 전체'] dl")!, actions = header.querySelector("[data-shell-actions]")!;
      const buttons = [...actions.querySelectorAll("button,a[href]")].map(button => {
        const box = rect(button), hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
        return { label: button.getAttribute("aria-label"), ...box, reachable: Boolean(hit && button.contains(hit)) };
      });
      return { width: innerWidth, context: rect(context), summary: rect(summary), actions: rect(actions), buttons,
        children: [...summary.children].map(rect), gap: getComputedStyle(summary).columnGap,
        clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth };
    });
    measurements.push(metrics); await evidence(page, info, `comments-pc-header-${width}`, { metrics, writes });
  }
  // Capture every requested width before asserting so a first-width failure
  // preserves the original1280px overlap and exact760px boundary evidence too.
  for (const metrics of measurements) {
    expect(metrics.summary.width).toBeLessThan(260); expect(metrics.gap).toBe("12px");
    expect(metrics.context.right, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.summary.x);
    expect(metrics.summary.right, JSON.stringify(metrics)).toBeLessThanOrEqual(metrics.actions.x);
    expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
    for (const cell of metrics.children) {
      expect(cell.x).toBeGreaterThanOrEqual(metrics.context.right); expect(cell.right).toBeLessThanOrEqual(metrics.actions.x);
    }
    expect(metrics.buttons).toHaveLength(3);
    for (const button of metrics.buttons) {
      expect(button.width).toBeGreaterThanOrEqual(44); expect(button.height).toBeGreaterThanOrEqual(44);
      expect(button.reachable, JSON.stringify(button)).toBe(true);
    }
  }
  const scope = new URL(page.url()); expect(scope.searchParams.get("keep")).toBe("value"); expect(scope.hash).toBe("#comments");
  await expectMinimumTouchTargets(page, "[data-shell-actions]");
  await documentFits(page); expect(writes).toEqual([]);
});

test("browser comments manual: individual list owns central clear while brightness draft survives", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 }); const { writes } = await customer(page);
  await page.goto(`/control?siteId=${siteId}`); await rootReady(page, "control");
  await page.getByRole("button", { name: "조명 목록 열기", exact: true }).click();
  const drawer = page.getByRole("dialog", { name: "조명 목록", exact: true });
  const choice = drawer.getByRole("checkbox", { name: `${fixtures[0].name} 선택`, exact: true });
  await choice.locator("xpath=ancestor::label").click(); await expect(choice).toBeChecked();
  await drawer.getByRole("button", { name: "선택 완료", exact: true }).click();
  const central = page.locator("[data-target-selection-detail-panel]"); await expect(central).toBeVisible();
  const selected = central.getByRole("list", { name: "선택 조명", exact: true }); await expect(selected).toContainText(fixtures[0].name);
  const execution = page.getByRole("complementary", { name: "밝기 실행", exact: true }); await expect(execution.getByRole("list", { name: "선택 조명", exact: true })).toHaveCount(0);
  await expect(execution.getByText("초안", { exact: true })).toHaveCount(0);
  const clear = central.getByRole("button", { name: "선택 해제", exact: true }); const clearBounds = await visibleAction(page, clear);
  const centralBounds = (await central.boundingBox())!; const mapBounds = (await page.getByTestId("target-selection-map-viewport").boundingBox())!;
  const executionBounds = (await execution.boundingBox())!;
  expect(clearBounds.x + clearBounds.width).toBeGreaterThan(centralBounds.x + centralBounds.width / 2);
  expect(clearBounds.y - centralBounds.y).toBeLessThanOrEqual(24);
  expect(centralBounds.x).toBeGreaterThanOrEqual(mapBounds.x + mapBounds.width); expect(centralBounds.x + centralBounds.width).toBeLessThanOrEqual(executionBounds.x);
  const input = page.getByRole("textbox", { name: "밝기 수치", exact: true }); await input.fill("31"); await input.press("Enter"); const owner = await input.elementHandle();
  await toggleTheme(page); await page.setViewportSize({ width: 1280, height: 900 });
  expect(await input.evaluate((node, original) => node === original, owner)).toBe(true); await expect(input).toHaveValue("31");
  await clear.click(); await expect(central.getByRole("list", { name: "선택 조명", exact: true })).toHaveCount(0); await expect(input).toHaveValue("31");
  await documentFits(page); await evidence(page, info, "comments-manual-central-clear", { centralBounds, mapBounds, executionBounds, clearBounds, writes }); expect(writes).toEqual([]);
});

test("browser comments PC tables: schedule toolbar CTA and center alignment preserve read-only UI", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 }); const { writes } = await customer(page);
  const instant = "2026-10-01T00:00:00.000Z";
  const schedule = { id: commandId, name: "야간 스케줄", status: "enabled", activeFrom: instant, activeUntil: "2026-10-31T00:00:00.000Z", localStartTime: "18:00", localEndTime: "23:00",
    recurrence: { kind: "daily", weeklyDays: [], monthlyDay: null, yearlyMonth: null, yearlyDay: null }, action: { dimmingEnabled: true, brightnessPercent: 70 },
    fixtureIds: [fixtures[0].id], gatewayId, targets: [{ fixtureId: fixtures[0].id }], targetCount: 1, desiredRevision: 2, appliedRevision: 2, syncStatus: "APPLIED", nextOccurrence: null,
    lastExecution: null, createdById: "user-1", updatedById: "user-1", createdAt: instant, updatedAt: instant };
  await page.route(`**/api/sites/${siteId}/automation/schedules**`, route => route.request().method() === "GET" ? route.fulfill({ json: { items: [schedule], total: 1, filteredTotal: 1,
    siteSummary: { ruleCount: 1, syncRuleCounts: { APPLIED: 1, PENDING: 0, REJECTED: 0 } }, nextCursor: null } }) : route.fallback());
  await page.route(`**/api/sites/${siteId}/fixture-groups**`, route => route.request().method() === "GET" ? route.fulfill({ json: [{ id: commandId, name: "주차장 구역", floorId, gatewayId,
    lifecycleStatus: "active", fixtureCount: 1, meshControlGroup: { status: "ready", version: 2, error: null } }] }) : route.fallback());
  await page.goto(`/control?siteId=${siteId}&mode=schedule`); await expect(page.getByRole("region", { name: "현장 전체", exact: true })).toContainText("16대");
  const table = page.getByRole("table", { name: "스케줄 목록", exact: true }); await expect(table).toContainText(schedule.name);
  await expect(table.getByRole("columnheader", { name: /활성/ })).toContainText("활성"); await expect(table).not.toContainText("Gateway 동기화"); await expect(table).not.toContainText("Asia/Seoul");
  const scheduleAlignments = await centeredColumns(table);
  const add = page.getByRole("button", { name: "스케줄 추가", exact: true }); await expect(add).toHaveCount(1);
  const toolbar = add.locator("xpath=ancestor::*[@aria-label='스케줄 목록 조건']"); await expect(toolbar).toHaveCount(1);
  const addBounds = await visibleAction(page, add); await add.click(); const dialog = page.getByRole("dialog", { name: "스케줄 추가", exact: true }); await expect(dialog).toBeVisible();
  await dialog.getByRole("button", { name: "취소", exact: true }).click(); await expect(add).toBeFocused();
  await page.getByRole("tab", { name: "그룹/구역", exact: true }).click();
  const groups = page.getByRole("table", { name: "저장 구역 목록", exact: true }); await expect(groups).toContainText("주차장 구역");
  await expect(groups.getByRole("columnheader", { name: "게이트웨이", exact: true })).toHaveCount(0);
  const sync = groups.locator("tbody tr").first().getByRole("cell").filter({ has: page.getByText("준비됨", { exact: true }) }); await expect(sync).toHaveText("준비됨");
  const groupAlignments = await centeredColumns(groups); await documentFits(page);
  await evidence(page, info, "comments-pc-tables", { addBounds, scheduleAlignments, groupAlignments, writes }); expect(writes).toEqual([]);
});

test("browser comments dark mobile reports: common search reset CSV and filters remain reachable", async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 }); await theme(page, "dark"); const { writes } = await customer(page, "admin", true);
  const job = { ...browserReport("completed", { from: "2026-09-01", to: "2026-09-07", scope: "site", identityId: siteId, format: "pdf" }), siteId };
  await page.route(`**/api/energy/sites/${siteId}/reports?**`, route => route.request().method() === "GET" ? route.fulfill({ json: { reports: [job], nextCursor: null, totalCount: 1 } }) : route.fallback());
  await page.route(`**/api/energy/sites/${siteId}/report-targets`, route => route.fulfill({ json: { siteId, timeZone: "Asia/Seoul", lastCompletedDate: "2026-09-11", targets: [{ scope: "site", identityId: siteId, label: "보고서 현장" }] } }));
  await page.goto(`/statistics?siteId=${siteId}`); await rootReady(page, "statistics");
  const overviewHeading = page.getByRole("heading", { level: 1, name: "사용량 개요", exact: true });
  await expect(overviewHeading).toHaveClass(/sr-only/); await expect(page.locator("h1")).toHaveCount(1);
  expect((await overviewHeading.boundingBox())!.height).toBeLessThanOrEqual(1);
  await expect(page.getByRole("button", { name: "보고서 생성", exact: true })).toHaveCount(0);
  await expect(page.getByText("ENERGY INTELLIGENCE", { exact: true })).toHaveCount(0);
  await page.goto(`/statistics/reports?siteId=${siteId}&query=parking`);
  await expect(page.getByRole("region", { name: "현장 전체", exact: true })).toContainText("16대");
  await expect(page.getByRole("list", { name: "보고서 생성 이력", exact: true })).toContainText("보고서 현장");
  const search = page.getByRole("searchbox", { name: "보고서 검색", exact: true }); await expect(search).toHaveValue("parking");
  await expect(search.locator("xpath=ancestor::*[@data-field]")).toHaveCount(1);
  await expect(page.getByText("ENERGY INTELLIGENCE", { exact: true })).toHaveCount(0); await expect(page.getByText(/시각: 현장 시간대/)).toHaveCount(0);
  const reset = page.getByRole("button", { name: "전체 초기화", exact: true }); const resetBounds = await visibleAction(page, reset); await reset.click();
  await expect(search).toHaveValue(""); await expect.poll(() => new URL(page.url()).searchParams.has("query")).toBe(false);
  const csv = page.getByRole("button", { name: "CSV 내보내기", exact: true }); const csvBounds = await visibleAction(page, csv); await csv.click();
  await expect(page.getByRole("dialog", { name: "에너지 사용량 보고서 만들기", exact: true })).toBeVisible(); await page.keyboard.press("Escape");
  const filter = page.getByRole("button", { name: /보고서 조건 상세 필터/ }); const filterBounds = await visibleAction(page, filter); await filter.click();
  const popover = page.getByRole("dialog", { name: "보고서 조건", exact: true }); await expect(popover).toBeVisible();
  await expectMinimumTouchTargetsAfterScrolling(page, "[role=dialog]"); await documentFits(page);
  await evidence(page, info, "comments-dark-reports-filters", { resetBounds, csvBounds, filterBounds, writes });
  await popover.getByRole("button", { name: "필터 닫기", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-customer-theme", "dark"); await documentFits(page);
  await evidence(page, info, "comments-dark-reports", { resetBounds, csvBounds, filterBounds, writes }); expect(writes).toEqual([]);
});
