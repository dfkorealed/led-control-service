import { writeFile } from "node:fs/promises";
import { expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import { installMockApiBoundary } from "./support/mock-api-boundary";
import { installSettingsApiRoutes, type SettingsFixture } from "./support/settings-api";
import { installFirstScreenStatisticsFixtures } from "./support/first-screen-statistics";

const fixtureName = "지하 이층 동측 출입구 긴급피난통로 센서연동 조명 0000000001";
const layoutFixture: SettingsFixture = {
  id: "fixture-1", name: fixtureName, x: 120, y: 140, size: 20, ratedWatt: 40,
  brightness: 70, status: "online", statusReason: "reported", health: null,
  rssi: -60, hopCount: 2, commandSuccessRate: 0.99, lastSeenAt: "2026-10-15T00:00:00.000Z",
  gateway: { id: "gateway-1", name: "메인 게이트웨이", connectionStatus: "online" },
  controllable: true, controlBlockReason: null
};
const requests = new WeakMap<Page, Array<{ method: string; url: string }>>();

async function setup(page: Page, baseURL: string | undefined, width: number, height: number, theme = "light", options: Parameters<typeof installSettingsApiRoutes>[2] = {}) {
  await page.setViewportSize({ width, height });
  requests.set(page, []);
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/")) requests.get(page)!.push({ method: request.method(), url: request.url() }); });
  await page.addInitScript(() => {
    // No live push channel is needed for a memory layout fixture.
    window.WebSocket = class { constructor() { throw new Error("layout fixture denies WebSocket"); } } as unknown as typeof WebSocket;
    navigator.sendBeacon = () => false;
  });
  await page.addInitScript(value => localStorage.setItem("led-control.customer-theme.v1", value), theme);
  await installMockApiBoundary(page.context(), baseURL);
  const api = await installSettingsApiRoutes(page, "admin", { readyMapDocument: true, fixtures: [layoutFixture], ...options });
  await page.route("**/api/sites/*/temporary-controls?**", route => route.fulfill({ json: { items: [], nextCursor: null } }));
  return api;
}

async function evidence(page: Page, info: TestInfo, name: string, target: Locator) {
  const metrics = await target.evaluate(element => {
    const describe = (node: Element) => {
      const e = node as HTMLElement, r = e.getBoundingClientRect(), s = getComputedStyle(e);
      const points = [[r.x + r.width / 2, r.y + r.height / 2], [r.x + 4, r.y + 4], [r.right - 4, r.bottom - 4]];
      return { tag: e.tagName, label: e.getAttribute("aria-label"), text: e.textContent,
        rect: r.toJSON(), clientWidth: e.clientWidth, scrollWidth: e.scrollWidth,
        clientHeight: e.clientHeight, scrollHeight: e.scrollHeight, scrollTop: e.scrollTop,
        overflowX: s.overflowX, overflowY: s.overflowY, grid: s.gridTemplateColumns,
        hits: points.map(([x, y]) => { const hit = document.elementFromPoint(x, y); return Boolean(hit && (hit === e || e.contains(hit))); }) };
    };
    const ancestors = []; for (let p = element.parentElement; p; p = p.parentElement) ancestors.push(describe(p));
    return { viewport: { width: innerWidth, height: innerHeight }, documentWidth: document.documentElement.scrollWidth,
      target: describe(element), descendants: [...element.querySelectorAll("*")].map(describe), ancestors };
  });
  await writeFile(info.outputPath(`${name}.json`), JSON.stringify({ ...metrics, requests: requests.get(page) }, null, 2));
  await page.screenshot({ path: info.outputPath(`${name}.png`) });
  return metrics;
}

async function expectHit(target: Locator, minimum = 44) {
  await target.scrollIntoViewIfNeeded();
  // Center within the real scroll chain, clear of sticky header/navigation,
  // then wait for compositor wheel delivery before sampling the same corners.
  await target.evaluate(async e => {
    e.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  });
  const result = await target.evaluate(e => {
    const r = e.getBoundingClientRect();
    // Match the audit's 4px corner inset, inside existing rounded controls.
    return { width: r.width, height: r.height, hits: [[r.x + r.width / 2, r.y + r.height / 2], [r.x + 4, r.y + 4], [r.right - 4, r.bottom - 4]].map(([x,y]) => { const hit = document.elementFromPoint(x,y); return Boolean(hit && (hit === e || e.contains(hit))); }) };
  });
  expect(result.width).toBeGreaterThanOrEqual(minimum);
  expect(result.height).toBeGreaterThanOrEqual(minimum);
  expect(result.hits).toEqual([true, true, true]);
}

// A zero-height information body under normal editor chrome must fail here.
test("SET-003 short editor retains a reachable placement body", async ({ page, baseURL }, info) => {
  await setup(page, baseURL, 320, 600);
  await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
  await expect(page.getByTestId("floor-editor-canvas")).toHaveAttribute("data-map-ready", "true");
  await expect(page.getByRole("button", { name: "맵 초기화", exact: true })).toBeEnabled();
  const toggle = page.getByRole("button", { name: "편집 정보 패널", exact: true });
  await toggle.click();
  const panel = page.locator("#editor-information-panel");
  await panel.getByRole("tab", { name: "배치", exact: true }).click();
  await panel.hover(); await page.mouse.wheel(0, 800);
  const data = await evidence(page, info, "placement-after-wheel", panel);
  const active = panel.getByRole("tabpanel");
  expect((await active.boundingBox())!.height).toBeGreaterThan(100);
  expect(data.target.rect.height).toBeGreaterThan(150);
  await expectHit(toggle);
});

// Expanded desktop navigation must not squeeze the camera controls out of the
// manual workspace. The real consumer also keeps 48px fixture hit targets.
for (const width of [759, 760, 1023, 1024, 1120, 1440]) test(`OPS-001 manual map camera controls remain reachable ${width}`, async ({ page, baseURL }, info) => {
  await setup(page, baseURL, width, width === 1440 ? 900 : 768, width === 1023 ? "dark" : "light");
  await page.goto("/control?siteId=site-1&mode=manual");
  const map = page.getByTestId("target-selection-map-viewport");
  await expect(map).toBeVisible();
  await expect(page.locator("[data-spatial-map-marker]").first()).toBeVisible();
  await page.mouse.move(500, 240); await page.mouse.wheel(0, 700);
  const fit = page.getByRole("button", { name: "지도 화면 맞춤", exact: true });
  await evidence(page, info, "manual-after-wheel", page.locator("[data-control-layout]"));
  await expectHit(fit);
  const marker = page.locator("[data-spatial-map-marker]").first();
  await expectHit(marker, 48);
});

test.describe("selected history touch", () => {
test.use({ hasTouch: true, isMobile: true });
test("SET-004 selected fixture history keeps revisions and restore reachable", async ({ page, baseURL }, info) => {
  await setup(page, baseURL, 390, 844, "dark");
  await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
  await expect(page.getByTestId("floor-editor-canvas")).toHaveAttribute("data-map-ready", "true");
  await expect(page.getByRole("button", { name: "맵 초기화", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "도구 및 조명 패널", exact: true }).click();
  await page.getByRole("tablist", { name: "배치 상태" }).getByRole("tab", { name: "전체", exact: true }).click();
  await page.getByTestId("placement-fixture-fixture-1").click();
  await page.getByRole("button", { name: "편집 정보 패널", exact: true }).click();
  const panel = page.locator("#editor-information-panel");
  await panel.getByRole("tab", { name: "기록", exact: true }).click();
  await panel.hover(); await page.mouse.wheel(0, 600);
  await evidence(page, info, "selected-history-after-wheel", panel);
  expect((await page.getByTestId("editor-revision-list").boundingBox())!.height).toBeGreaterThan(50);
  await expectHit(page.getByRole("button", { name: "리비전 7 복구", exact: true }));
});
});

for (const width of [320, 390, 1024, 1440]) test(`OPS-002 all 100 command target IDs can be read ${width}`, async ({ page, baseURL }, info) => {
  await setup(page, baseURL, width, width === 320 ? 600 : 768);
  const record = { caseId: "99999999-9999-4999-8999-000000000900", originalCommandId: "99999999-9999-4999-8999-000000000901",
    siteId: "site-1", targetCount: 100, verificationAttemptCount: 5, status: "verification_required",
    canRequestStatusCheck: false, lastCheckedAt: "2026-10-15T00:00:00.000Z", reasonCode: "attempts_exhausted" };
  const ids = Array.from({ length: 100 }, (_, i) => `99999999-9999-4999-8999-${String(1000 + i).padStart(12, "0")}`);
  await page.route("**/api/commands/requiring-verification?**", route => route.fulfill({ json: { items: [record], nextCursor: null, generatedAt: record.lastCheckedAt } }));
  await page.route(`**/api/commands/requiring-verification/${record.caseId}`, route => route.fulfill({ json: { ...record, targetFixtureIds: ids } }));
  await page.goto("/control?siteId=site-1&mode=manual");
  await expect(page.getByTestId("target-selection-map-viewport")).toBeVisible();
  const more = page.getByRole("button", { name: "더보기", exact: true });
  if (await more.isVisible()) await more.click();
  await page.getByRole("region", { name: "최근 명령 이력", exact: true }).getByRole("button", { name: "전체 보기", exact: true }).click();
  await page.getByRole("button", { name: "미확정 명령 복구", exact: true }).click();
  await page.getByRole("button", { name: new RegExp(record.originalCommandId) }).click();
  const dialog = page.getByRole("dialog", { name: "확인 필요한 명령", exact: true });
  const targets = dialog.getByText(`대상 ID: ${ids.join(", ")}`, { exact: true });
  await expect(targets).toBeVisible();
  await page.mouse.move(width - 110, 400); await page.mouse.wheel(0, 3000);
  await evidence(page, info, "case-tail-after-wheel", dialog);
  const tail = await targets.evaluate(e => {
    const text = e.lastChild!, range = document.createRange();
    range.setStart(text, text.textContent!.length - 36); range.setEnd(text, text.textContent!.length);
    const r = range.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { bottom: r.bottom, hit: Boolean(hit && (e === hit || e.contains(hit))) };
  });
  expect(tail.hit).toBe(true);
  await expectHit(dialog.getByRole("button", { name: "확인 필요한 명령 닫기", exact: true }));
  await expectHit(dialog.getByRole("button", { name: "이전", exact: true }));
  await expectHit(dialog.getByRole("button", { name: "다음", exact: true }));
  await expect(dialog.getByRole("button", { name: "실제 상태 확인 요청", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "위험 승인", exact: true })).toBeDisabled();
});

function registrationFixture() {
  const instant = "2026-10-15T00:00:00.000Z";
  return {
    id: "registration-1", siteId: "site-1", floorId: "floor-1", gatewayId: "gateway-1", requestedBy: "admin-user-1",
    status: "active" as const, scanStatus: "completed" as const, scanCorrelationId: "scan-1", scanAttempt: 1,
    scanStartedAt: instant, scanCompletedAt: instant, scanFailureCode: null, scanFailureMessage: null,
    startedAt: instant, completedAt: null,
    discoveredNodes: Array.from({ length: 3 }, (_, i) => ({ id: `node-${i}`, sessionId: "registration-1",
      deviceUuid: `00000000-0000-4000-8000-00000000000${i}`, serialNumber: `LED-LONG-SERIAL-0000000000000${i}`,
      rssi: -60, oobCapability: "no_oob" as const, firmwareVersion: "v1.0.0", status: "discovered" as const,
      identifyState: "idle" as const, meshAddress: null, errorMessage: null, scanCorrelationId: "scan-1", scanAttempt: 1,
      discoveredAt: instant, registrationEligibility: "available" as const, existingRegistration: null }))
  };
}

test("SET-001 discovered device identities retain reading width", async ({ page, baseURL }, info) => {
  const session = registrationFixture();
  await setup(page, baseURL, 320, 600, "light", { registrationSession: session, activeRegistrationSessions: [session] });
  await page.goto("/settings/registration?siteId=site-1");
  const row = page.getByTestId("discovered-device").first();
  await row.scrollIntoViewIfNeeded();
  await evidence(page, info, "discovered-reading", row);
  const serial = row.getByText(session.discoveredNodes[0].serialNumber, { exact: true });
  expect((await serial.boundingBox())!.width).toBeGreaterThan(160);
  expect((await row.boundingBox())!.height).toBeLessThan(400);
  await expectHit(row.getByRole("button", { name: "조명 1 식별", exact: true }));
});

async function siteFixture(page: Page, shortName = false) {
  const instant = "2026-10-15T00:00:00.000Z";
  const fixture = { id: "fixture-1", name: shortName ? "B2-L01" : fixtureName, ratedWatt: 40, updatedAt: instant,
    serialNumber: "LED-LONG-SERIAL-000000000001", deviceUuid: "00000000-0000-4000-8000-000000000001",
    meshAddress: "0x0001", firmwareVersion: "firmware-v1.0.0" };
  await page.route("**/api/sites/site-1/settings", route => route.fulfill({ json: {
    site: { id: "site-1", name: "서울특별시 강남구 대치동 미래첨단조명 연구개발센터 지하주차장 동측 출입구", address: "서울시", timeZone: "Asia/Seoul", currency: "KRW", tariffKwhRate: 160, updatedAt: instant },
    floors: [{ id: "floor-1", name: "지하 이층 동측 입주사 전용 주차장 및 전기차 충전구역", level: -2, displayOrder: 1, status: "active", fixtureCount: 1, activeGroupCount: 0, updatedAt: instant }]
  } }));
  await page.route("**/api/sites/site-1/floors/floor-1/fixtures/settings*", route => route.fulfill({ json: { items: [fixture], nextCursor: null } }));
  await page.route("**/api/sites/site-1/fixture-groups", route => route.fulfill({ json: [] }));
  return fixture;
}

for (const shortName of [true, false]) test(`SET-002 fixture edit form fits 320px short=${shortName}`, async ({ page, baseURL }, info) => {
  await setup(page, baseURL, 320, 600);
  const fixture = await siteFixture(page, shortName);
  await page.goto("/settings/site?siteId=site-1");
  const form = page.getByRole("form", { name: `${fixture.name} 조명 정보 수정`, exact: true });
  await form.scrollIntoViewIfNeeded();
  await evidence(page, info, "fixture-form", form);
  // Isolate the first intrinsic-width contributor before changing production:
  // remove one direct card child at a time, measure, and restore immediately.
  const isolation = await form.evaluate(e => {
    const card = e.parentElement!;
    const measure = () => ({ card: card.getBoundingClientRect().width, form: e.getBoundingClientRect().width, document: document.documentElement.scrollWidth });
    const original = measure();
    const children = [...card.children].map(child => {
      const element = child as HTMLElement, old = element.style.display;
      element.style.display = "none"; const absent = measure(); element.style.display = old;
      return { tag: child.tagName, text: child.textContent, absent };
    });
    const inputs = [...e.querySelectorAll("input")].map(input => {
      const old = input.style.minWidth; input.style.minWidth = "0"; const shrinkable = measure(); input.style.minWidth = old;
      return { label: input.getAttribute("aria-label"), shrinkable };
    });
    const section = e.closest('[aria-label="조명 관리"]')!;
    const header = section.firstElementChild!;
    const headerIsolation = [header, ...header.querySelectorAll("[data-field],button,span")].map(child => {
      const element = child as HTMLElement, old = element.style.display;
      element.style.display = "none"; const absent = measure(); element.style.display = old;
      return { tag: element.tagName, label: element.getAttribute("aria-label"), text: element.textContent, className: element.className, absent };
    });
    return { original, children, inputs, headerIsolation };
  });
  await writeFile(info.outputPath("intrinsic-isolation.json"), JSON.stringify(isolation, null, 2));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
  const input = form.locator("input").first();
  expect((await input.boundingBox())!.x + (await input.boundingBox())!.width).toBeLessThanOrEqual(306);
});

const statisticsSiteId = "30000000-0000-4000-8000-000000000001";
async function largeStatistics(page: Page) {
  await installFirstScreenStatisticsFixtures(page);
  const instant = "2026-10-15T00:00:00.000Z";
  const period = { estimatedKwh: 123456.78, estimatedCost: 19753085, knownSeconds: 43200, unknownSeconds: 0, dataStatus: "available" };
  await page.route("**/api/energy/sites/*/summary", route => route.fulfill({ json: {
    siteId: statisticsSiteId, timeZone: "Asia/Seoul", source: "state_based_estimate", generatedAt: instant,
    today: { ...period, estimatedKwh: 12345.67, estimatedCost: 1975307 },
    monthToDate: { ...period, dataStatus: "partial", unknownSeconds: 7200 },
    yearToDate: { ...period, estimatedKwh: 987654.32, estimatedCost: 158024691, dataStatus: "partial", unknownSeconds: 7200 },
    monthForecast: { estimatedKwh: 160000, estimatedCost: 25600000, observedKnownSeconds: 2073600, reason: "available" },
    baseline24Hours: { estimatedKwh: 297000, estimatedCost: 47520000, fixtureCount: 10000, daysInMonth: 31 },
    estimatedSavings: { kwh: 137000, cost: 21920000 }, lastAggregatedAt: instant
  } }));
  await page.route("**/api/energy/sites/*/rankings?**", route => {
    const url = new URL(route.request().url()), metric = url.searchParams.get("metric");
    return route.fulfill({ json: {
      siteId: statisticsSiteId, timeZone: "Asia/Seoul", source: "state_based_estimate", generatedAt: instant,
      dimension: url.searchParams.get("dimension"), metric, sort: url.searchParams.get("sort"),
      range: { from: url.searchParams.get("from"), to: url.searchParams.get("to") },
      siteTotalKwh: 12345678.9, siteTotalCost: 1975308624, overlappingMemberships: false, legacyExcludedBefore: null,
      ranked: [{ identityId: "30000000-0000-4000-8000-000000000020", operationalId: "30000000-0000-4000-8000-000000000020",
        name: "지하주차장 제삼구역", rank: 1, fixtureCount: 9999, estimatedKwh: 123456.78, estimatedCost: 19753085,
        contributionRate: 0.625, perFixtureAverageKwh: 1.5625, metricValue: metric === "cost" ? 19753085 : 123456.78,
        knownSeconds: 691200, unknownSeconds: 0, coverageRate: 1, dataStatus: "available", historyQuality: "observed", unrankedReason: null,
        previousPeriod: { estimatedKwh: 140000, changeRatePercent: -10.71, rank: 1 },
        dailyPoints: [{ period: "2026-10-13", estimatedKwh: 123456.78, dataStatus: "available" }], fixtures: [] }], unranked: []
    } });
  });
}

async function metricBounds(cards: Locator) {
  return cards.evaluateAll(elements => elements.map(card => {
    const r = card.getBoundingClientRect(), walker = document.createTreeWalker(card, NodeFilter.SHOW_TEXT);
    const escaped: unknown[] = []; let node: Node | null;
    while ((node = walker.nextNode())) {
      if (!node.textContent?.trim()) continue;
      const range = document.createRange(); range.selectNodeContents(node);
      for (const box of range.getClientRects()) if (box.width && (box.x < r.x - 1 || box.right > r.right + 1)) escaped.push({ text: node.textContent, rect: box.toJSON(), card: r.toJSON() });
    }
    return { label: card.getAttribute("aria-label"), text: card.textContent, escaped, overflow: card.scrollWidth - card.clientWidth };
  }));
}

for (const scenario of [
  { id: "BUS-001", route: "analysis", width: 1024, theme: "light" },
  { id: "BUS-001", route: "analysis", width: 1024, theme: "dark" },
  { id: "BUS-002", route: "overview", width: 390, theme: "light" }
]) test(`${scenario.id} complete statistics numbers stay inside cards ${scenario.theme}`, async ({ page, baseURL }, info) => {
  await setup(page, baseURL, scenario.width, scenario.width === 390 ? 844 : 768, scenario.theme, { ids: { siteId: statisticsSiteId } });
  await largeStatistics(page);
  await page.goto(`/statistics/${scenario.route}?siteId=${statisticsSiteId}`);
  const target = scenario.route === "analysis" ? page.getByRole("complementary", { name: "지하주차장 제삼구역 상세", exact: true }) : page.getByRole("group", { name: "에너지 요약", exact: true });
  await expect(target).toBeVisible();
  await target.scrollIntoViewIfNeeded();
  await evidence(page, info, "numeric-cards", target);
  const metrics = await metricBounds(target.locator("[data-metric-card]"));
  await writeFile(info.outputPath("numeric-ranges.json"), JSON.stringify(metrics, null, 2));
  expect(metrics.flatMap(item => item.escaped)).toEqual([]);
  expect(metrics.map(item => item.overflow)).toEqual(metrics.map(() => 0));
  await expect(target).toContainText("123,456.78");
  if (scenario.route === "overview") await expect(target).toContainText("987,654.32");
});

test.describe("reset target touch", () => {
test.use({ hasTouch: true, isMobile: true });
test("SET-008 password reset shows the full target login ID at 320px", async ({ page, baseURL }, info) => {
  await setup(page, baseURL, 320, 600);
  const user = { id: "user-1", name: "현장관리 담당자 긴한글이름 김관리자", loginId: "parking_control_customer_long_id_0001",
    accessLevel: "control", status: "active", lastLoginAt: null, createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z" };
  await page.route("**/api/sites/site-1/users", route => route.fulfill({ json: { users: [user], count: 1, limit: 100 } }));
  await page.goto("/settings/users?siteId=site-1");
  await page.getByRole("button", { name: `${user.name} 작업`, exact: true }).click();
  await page.getByRole("menuitem", { name: /비밀번호 초기화/ }).click();
  const dialog = page.getByRole("dialog", { name: `${user.name} 비밀번호 초기화`, exact: true });
  await evidence(page, info, "reset-target", dialog);
  const detail = dialog.locator("dl");
  const data = await detail.evaluate(e => {
    const r = e.getBoundingClientRect();
    const dd = e.querySelectorAll("dd")[1], range = document.createRange(); range.selectNodeContents(dd);
    return { client: e.clientWidth, scroll: e.scrollWidth, texts: [...range.getClientRects()].map(rect => rect.toJSON()), box: r.toJSON(), labelWidth: e.querySelectorAll("dt")[1].getBoundingClientRect().width };
  });
  expect(data.scroll).toBeLessThanOrEqual(data.client);
  expect(data.labelWidth).toBeGreaterThan(70);
  expect(data.texts.every(r => r.x >= data.box.x && r.right <= data.box.right)).toBe(true);
  await expect(dialog.getByText(user.loginId, { exact: true })).toHaveText(user.loginId);
});
});

// Exercise the repaired consumers at each requested primary viewport and the
// navigation boundaries. Phones use Chromium touch emulation and real taps;
// scroll assertions below still send real wheel input to the reader itself.
for (const profile of [
  { width: 320, height: 600, theme: "light" }, { width: 390, height: 844, theme: "dark" },
  { width: 759, height: 768, theme: "light" }, { width: 760, height: 768, theme: "dark" },
  { width: 1023, height: 768, theme: "light" }, { width: 1024, height: 768, theme: "dark" },
  { width: 1120, height: 768, theme: "light" }, { width: 1440, height: 900, theme: "light" }
]) test.describe(`matrix ${profile.width} ${profile.theme}`, () => {
  test.use({ hasTouch: profile.width < 760, isMobile: profile.width < 760 });
  test("editor chrome, registration, fixture form and statistics remain usable", async ({ page, baseURL }, info) => {
    const session = registrationFixture();
    const api = await setup(page, baseURL, profile.width, profile.height, profile.theme, { registrationSession: session, activeRegistrationSessions: [session] });
    const press = async (element: Locator) => profile.width < 760 ? element.tap() : element.click();
    await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
    const canvas = page.getByTestId("floor-editor-canvas");
    await expect(canvas).toHaveAttribute("data-map-ready", "true");
    // map-ready precedes lease admission; the temporary read-only notice has
    // its own real height and must settle before comparing tab geometry.
    await expect(page.getByRole("button", { name: "맵 초기화", exact: true })).toBeEnabled();
    const panel = page.locator("#editor-information-panel");
    if (!await panel.isVisible()) await press(page.getByRole("button", { name: "편집 정보 패널", exact: true }));
    const initialWorkspace = await page.getByTestId("floor-editor-layout").boundingBox();
    for (const label of ["속성", "배치", "레이어", "기록"]) {
      const tab = panel.getByRole("tab", { name: label, exact: true });
      await press(tab);
      expect((await tab.boundingBox())!.height).toBeGreaterThanOrEqual(52);
      expect((await panel.getByRole("tabpanel").boundingBox())!.height).toBeGreaterThan(100);
      expect((await page.getByTestId("floor-editor-layout").boundingBox())!.height).toBe(initialWorkspace!.height);
    }
    await evidence(page, info, "matrix-editor", panel);
    if (profile.width >= 1024) expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(profile.height);
    await expectHit(page.getByRole("button", { name: "저장됨", exact: true }));
    await expect(page.getByRole("button", { name: "저장됨", exact: true })).toBeDisabled();
    await press(page.getByRole("button", { name: "맵 초기화", exact: true }));
    const clear = page.getByRole("dialog", { name: "맵 초기화", exact: true });
    await expect(clear).toBeVisible();
    await press(clear.getByRole("button", { name: "취소", exact: true }));
    await expectHit(page.getByRole("button", { name: "로그아웃", exact: true }));
    if (profile.width < 760) {
      const back = page.getByRole("link", { name: "설정으로 돌아가기", exact: true });
      await press(back); await expect(page).toHaveURL(/\/settings\?siteId=site-1$/);
      await expect(page.getByRole("navigation", { name: "모바일 주 메뉴", exact: true })).toBeVisible();
    }
    expect(api.atomicSavePayloads).toEqual([]);

    await page.goto("/settings/registration?siteId=site-1");
    const lastRow = page.getByTestId("discovered-device").last();
    await lastRow.scrollIntoViewIfNeeded();
    await page.mouse.wheel(0, 800);
    await evidence(page, info, "matrix-registration", lastRow);
    expect((await lastRow.getByText(session.discoveredNodes[2].serialNumber, { exact: true }).boundingBox())!.width).toBeGreaterThan(160);
    await expectHit(lastRow.getByRole("button", { name: "조명 3 식별", exact: true }));
    expect(api.registrationBatchRequests).toEqual([]);

    await siteFixture(page);
    await page.goto("/settings/site?siteId=site-1");
    const form = page.getByRole("form", { name: `${fixtureName} 조명 정보 수정`, exact: true });
    await form.scrollIntoViewIfNeeded();
    await evidence(page, info, "matrix-fixture-form", form);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(profile.width);
    for (const input of await form.locator("input").all()) expect((await input.boundingBox())!.width).toBeGreaterThan(100);
    const saveIcon = await form.getByRole("button", { name: `${fixtureName} 조명 정보 저장`, exact: true }).locator("svg").boundingBox();
    expect(saveIcon!.width).toBe(16); expect(saveIcon!.height).toBe(16);
    await expectHit(form.getByRole("button", { name: `${fixtureName} 조명 정보 저장`, exact: true }));

    await largeStatistics(page);
    for (const route of ["overview", "analysis"]) {
      await page.goto(`/statistics/${route}?siteId=${statisticsSiteId}`);
      const target = route === "analysis" ? page.getByRole("complementary", { name: "지하주차장 제삼구역 상세", exact: true }) : page.getByRole("group", { name: "에너지 요약", exact: true });
      await expect(target).toBeVisible(); await target.scrollIntoViewIfNeeded();
      await evidence(page, info, `matrix-statistics-${route}`, target);
      const metrics = await metricBounds(target.locator("[data-metric-card]"));
      await writeFile(info.outputPath(`matrix-${route}-ranges.json`), JSON.stringify(metrics, null, 2));
      expect(metrics.flatMap(item => item.escaped)).toEqual([]);
      expect(metrics.every(item => item.overflow === 0)).toBe(true);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(profile.width);
    }
  });
});

test("OPS-001 the 588px content boundary preserves selection camera and open history", async ({ page, baseURL }, info) => {
  const api = await setup(page, baseURL, 1229, 900);
  await page.goto("/control?siteId=site-1&mode=manual");
  const viewport = page.getByTestId("target-selection-map-viewport");
  const mountedMap = await viewport.elementHandle();
  await page.locator("[data-spatial-map-marker]").first().click();
  const selected = page.getByRole("heading", { name: "선택 조명 1개", exact: true });
  await expect(selected).toBeVisible();
  await page.getByRole("button", { name: "지도 확대", exact: true }).click();
  await expect(viewport).toHaveAttribute("data-zoom", "1.1");
  const content = page.locator("[data-target-selection-content]");
  for (const [width, columns] of [[1229, 1], [1230, 2], [1231, 2]] as const) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(() => content.evaluate(e => getComputedStyle(e).gridTemplateColumns.split(" ").length)).toBe(columns);
    expect((await content.boundingBox())!.width).toBe(width - 642);
    await expect(selected).toBeVisible();
    await expect(viewport).toHaveAttribute("data-zoom", "1.1");
    expect(await mountedMap!.evaluate(e => e === document.querySelector('[data-testid="target-selection-map-viewport"]'))).toBe(true);
    await expectHit(page.getByRole("button", { name: "지도 화면 맞춤", exact: true }));
    await evidence(page, info, `width-budget-${width}`, content);
  }
  await page.getByRole("region", { name: "최근 명령 이력", exact: true }).getByRole("button", { name: "전체 보기", exact: true }).click();
  const history = page.getByRole("dialog", { name: "명령 이력", exact: true });
  await expect(history).toBeVisible();
  await page.setViewportSize({ width: 1229, height: 900 });
  await expect(history).toBeVisible();
  await page.getByRole("button", { name: "명령 이력 닫기", exact: true }).click();
  await expect(selected).toBeVisible();
  await expect(viewport).toHaveAttribute("data-zoom", "1.1");
  expect(api.dimmingRequests).toEqual([]);
});

test("SET-003 short editor upper and lower fields retain keyboard focus and preview access", async ({ page, baseURL }, info) => {
  await setup(page, baseURL, 320, 600);
  await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
  await expect(page.getByRole("button", { name: "맵 초기화", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "도구 및 조명 패널", exact: true }).click();
  await page.getByRole("tablist", { name: "배치 상태" }).getByRole("tab", { name: "전체", exact: true }).click();
  await page.getByTestId("placement-fixture-fixture-1").click();
  await page.getByRole("button", { name: "편집 정보 패널", exact: true }).click();
  const panel = page.locator("#editor-information-panel");
  await panel.getByRole("tab", { name: "배치", exact: true }).click();
  const upper = panel.getByRole("textbox", { name: "시작 X", exact: true });
  await expectHit(upper); await upper.focus(); await expect(upper).toBeFocused();
  const lower = panel.getByRole("textbox", { name: "세로 간격", exact: true });
  await lower.focus(); await page.keyboard.press("ArrowUp"); await expect(lower).toBeFocused();
  await expectHit(lower);
  const preview = panel.getByRole("button", { name: "배치 미리보기", exact: true });
  await expectHit(preview); await preview.click();
  await expect(panel.getByText("1개 배치 예정", { exact: true })).toBeVisible();
  await expectHit(panel.getByRole("button", { name: "배치 적용", exact: true }));
  await evidence(page, info, "short-editor-lower-controls", panel);
});

for (const width of [390, 1024]) test.describe(`current manual flow ${width}`, () => {
  test.use({ hasTouch: width === 390, isMobile: width === 390 });
  test("map and list selection submit one unchanged memory command", async ({ page, baseURL }) => {
    const ids = { siteId: "99999999-9999-4999-8999-000000000001", floorId: "99999999-9999-4999-8999-000000000002", gatewayId: "99999999-9999-4999-8999-000000000003" };
    const id = "99999999-9999-4999-8999-000000000004";
    const api = await setup(page, baseURL, width, width === 390 ? 844 : 768, "light", {
      ids, fixtures: [{ ...layoutFixture, id, gateway: { ...layoutFixture.gateway!, id: ids.gatewayId } }]
    });
    await page.goto(`/control?siteId=${ids.siteId}&mode=manual`);
    const marker = page.locator("[data-spatial-map-marker]").first();
    if (width === 390) await marker.tap(); else await marker.click();
    await expect(marker).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "조명 목록", exact: true }).click();
    await expect(page.getByRole("checkbox", { name: `${fixtureName} 선택`, exact: true })).toBeChecked();
    await page.getByRole("button", { name: "선택 완료", exact: true }).click();
    if (width === 1024) await page.getByRole("button", { name: "30%", exact: true }).click();
    const apply = page.getByRole("button", { name: "1개 조명에 밝기 적용", exact: true });
    await expect(apply).toBeEnabled(); await apply.click();
    await expect.poll(() => api.dimmingRequests.length).toBe(1);
    expect(api.dimmingRequests[0]).toMatchObject({ siteId: ids.siteId, target: { type: "fixture", fixtureId: id }, brightness: width === 1024 ? 30 : 70 });
    api.setCommandStatus({ stage: "completed", results: [{ fixtureId: id, fixtureName, status: "succeeded", errorMessage: null }] });
    await expect(page.getByRole("button", { name: "1개 조명에 밝기 적용", exact: true })).toBeEnabled();
    expect(api.dimmingRequests).toHaveLength(1);
  });
});

test.describe("current settings memory flow touch", () => {
  test.use({ hasTouch: true, isMobile: true });
  test("fixture validation save and password reset preserve requests pending and focus", async ({ page, baseURL }, info) => {
    await setup(page, baseURL, 320, 600);
    const fixture = await siteFixture(page, true);
    const patches: unknown[] = [];
    await page.route("**/api/sites/site-1/floors/floor-1/fixtures/fixture-1", route => {
      const body = route.request().postDataJSON(); patches.push(body);
      Object.assign(fixture, { name: body.name, ratedWatt: body.ratedWatt, updatedAt: "2026-10-15T00:00:01.000Z" });
      return route.fulfill({ json: { ...fixture, floorId: "floor-1" } });
    });
    await page.goto("/settings/site?siteId=site-1");
    const form = page.getByRole("form", { name: "B2-L01 조명 정보 수정", exact: true });
    await form.locator("input").nth(1).fill("-1");
    await form.getByRole("button", { name: "B2-L01 조명 정보 저장", exact: true }).tap();
    await expect(form.getByRole("alert")).toContainText("정격전력"); expect(patches).toEqual([]);
    await form.locator("input").first().fill("  수정 조명  "); await form.locator("input").nth(1).fill("42.5");
    await form.getByRole("button", { name: "B2-L01 조명 정보 저장", exact: true }).tap();
    await expect(page.getByRole("form", { name: "수정 조명 조명 정보 수정", exact: true })).toBeVisible();
    expect(patches).toEqual([{ expectedUpdatedAt: "2026-10-15T00:00:00.000Z", name: "수정 조명", ratedWatt: 42.5 }]);

    const user = { id: "user-1", name: "김관리자", loginId: "parking_control_customer_long_id_0001", accessLevel: "control", status: "active", lastLoginAt: null, createdAt: "2026-10-15T00:00:00.000Z", updatedAt: "2026-10-15T00:00:00.000Z" };
    await page.route("**/api/sites/site-1/users", route => route.fulfill({ json: { users: [user], count: 1, limit: 100 } }));
    let release!: () => void, resets = 0;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const password = "Memory-layout-20261015!";
    await page.route("**/api/sites/site-1/users/user-1/reset-password", async route => {
      expect(route.request().postDataJSON()).toEqual({ temporaryPassword: password }); resets++;
      await pending; await route.fulfill({ json: { ok: true } });
    });
    try {
      await page.goto("/settings/users?siteId=site-1");
      const actions = page.getByRole("button", { name: "김관리자 작업", exact: true });
      await actions.tap(); await page.getByRole("menuitem", { name: /비밀번호 초기화/ }).click();
      const dialog = page.getByRole("dialog", { name: "김관리자 비밀번호 초기화", exact: true });
      await dialog.getByLabel("새 임시 비밀번호", { exact: true }).fill("short");
      await dialog.getByRole("button", { name: "비밀번호 초기화", exact: true }).tap();
      await expect(dialog.getByRole("alert")).toContainText("8자 이상"); expect(resets).toBe(0);
      await dialog.getByLabel("새 임시 비밀번호", { exact: true }).fill(password);
      await dialog.getByLabel("임시 비밀번호 확인", { exact: true }).fill(password);
      await dialog.getByRole("button", { name: "비밀번호 초기화", exact: true }).tap();
      await expect(dialog.getByRole("button", { name: "처리 중", exact: true })).toBeDisabled();
      await expect(dialog.getByRole("button", { name: "취소", exact: true })).toBeDisabled();
      await evidence(page, info, "reset-pending-contract", dialog);
      release(); await expect(dialog).toHaveCount(0); await expect(actions).toBeFocused();
      await expect(page.getByText("비밀번호를 초기화했습니다. 사용자의 기존 세션이 종료되었습니다.", { exact: true })).toBeVisible();
      expect(resets).toBe(1);
      expect(await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }))).not.toContain(password);
    } finally { release(); }
  });
});
