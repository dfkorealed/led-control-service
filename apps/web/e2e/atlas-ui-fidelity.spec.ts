import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { writeFile } from "node:fs/promises";
import { createDimmingCommandSchema } from "@led-control/shared";
import { mockDashboard } from "../src/test/fixtures";
import type { SiteSettingsResponse } from "../src/api/site-settings";
import { commandDetailClockFixture, installSettingsApiRoutes } from "./support/settings-api";
import { installMockApiBoundary } from "./support/mock-api-boundary";
import { installFirstScreenStatisticsFixtures } from "./support/first-screen-statistics";
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
  // Statistics helpers also register a floorless dashboard. Install them first
  // so the shared customer dashboard remains authoritative for the four roots.
  if (statistics) await installFirstScreenStatisticsFixtures(page);
  const api = await installSettingsApiRoutes(page, role, {
    ids: { siteId, floorId, gatewayId }, fixtures, readyMapDocument: true, commandId
  });
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
    await expect(page.getByRole("list", { name: "차트 데이터 및 수집 상태", exact: true })).toContainText("2026-08-25");
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

for (const width of [320, 390, 562, 759, 760]) test(`responsive ${width}: branding long site option and monitoring refresh precede map`, async ({ page }, info) => {
  await page.setViewportSize({ width, height: 844 }); await theme(page, "light"); const { writes } = await customer(page);
  await page.goto(`/monitoring?siteId=${siteId}`);
  const compact = width < 760;
  await expect(page.locator(`[data-shell-navigation=${compact ? "compact" : "desktop"}]`)).toBeVisible();
  await expect(page.locator(`[data-shell-navigation=${compact ? "desktop" : "compact"}]`)).toHaveCount(0);
  const topbar = page.locator("[data-shell-topbar]");
  const logo = (compact ? topbar : page.locator("[data-shell-navigation=desktop]")).locator("[data-kinda-logo-mark]");
  await expect(logo).toBeVisible(); await expect(logo).toHaveAttribute("src", "/brand/kinda-mark.svg");
  const site = topbar.getByRole("button", { name: /현장 선택/ }); await site.click();
  await expect(page.getByRole("option", { name: `고객사 · ${longSite}`, exact: true })).toBeVisible();
  await expectMinimumTouchTargets(page, "[role=listbox]"); await documentFits(page);
  await evidence(page, info, `responsive-${width}-options`); await page.keyboard.press("Escape"); await expect(site).toBeFocused();
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

test("dark four roots and real site/alarm portals inherit the customer palette", async ({ page }, info) => {
  await page.setViewportSize({ width: 1440, height: 900 }); await theme(page, "dark"); const { writes } = await customer(page, "admin", true);
  for (const menu of roots) {
    await page.goto(`/${menu}?siteId=${siteId}`); await expect(page.locator("html")).toHaveAttribute("data-customer-theme", "dark");
    await rootReady(page, menu);
    const topbar = page.locator("[data-shell-topbar]"); await expect(topbar).toHaveCSS("background-color", "rgb(24, 35, 52)");
    await expect(page.locator("[data-app-shell]")).toHaveCSS("background-color", "rgb(15, 23, 36)");
    await evidence(page, info, `dark-${menu}`);
  }
  await page.locator("[data-shell-topbar]").getByRole("button", { name: /현장 선택/ }).click();
  await expect(page.getByRole("listbox")).toBeVisible();
  expect(await page.getByRole("listbox").evaluate(node => {
    for (let owner: Element | null = node; owner; owner = owner.parentElement) {
      const color = getComputedStyle(owner).backgroundColor;
      if (color !== "rgba(0, 0, 0, 0)" && color !== "transparent") return color;
    }
    return null;
  })).toBe("rgb(24, 35, 52)");
  await evidence(page, info, "dark-site-portal"); await page.keyboard.press("Escape");
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
