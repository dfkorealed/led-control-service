import { chromium, expect, test, type Page, type TestInfo } from "@playwright/test";
import type { EnergyReportRequest } from "@led-control/shared/energy-p2-contracts";
import { installSettingsApiRoutes } from "./support/settings-api";
import { installMockApiBoundary } from "./support/mock-api-boundary";
import { StatisticsNativeZoomEvidence } from "./support/statistics-native-zoom-evidence";
import { expectMinimumTouchTargets, expectMinimumTouchTargetsAfterScrolling } from "./support/layout-assertions";

const nativeEvidence = new WeakMap<Page, StatisticsNativeZoomEvidence>();

// These are the unchanged names/date from the physical Task9 overflow/crash.
// All responses are in-memory browser fixtures, never backend/HIL evidence.
const siteId = "99999999-9999-4999-8999-000000000001";
const identityId = "99999999-9999-4999-8999-000000000600";
const instant = "2026-10-01T15:00:00.000Z";
const names = ["긴 한국어 현장 조명 및 야간 운영 스케줄 이름 ".repeat(4), "LongUnbrokenFixtureAndScheduleNameWithoutWhitespace".repeat(4)];
type Request = { method: string; path: string; params: Record<string, string>; body: unknown };
const path = (name: string) => `/statistics/${name}?siteId=${siteId}`;

for (const naming of ["literal", "title"] as const) for (const name of ["사용량 분석 조건", "에너지 사용량 보고서 만들기"]) {
  test(`native Surface setup recognizes ${naming} ${name}`, async ({ page }, info) => {
    await page.setContent(`<div role="dialog" ${naming === "literal" ? `aria-label="${name}"` : 'aria-labelledby="draft-title"'}>
      <h2 id="draft-title">${name}</h2><span role="spinbutton" tabindex="0">2027</span><span role="spinbutton" tabindex="0">10</span></div>`);
    const observed: unknown[] = [];
    nativeEvidence.set(page, { capture: async (_label, trigger, action, keys, expected) => {
      await trigger.click(); await action();
      for (const key of keys) await page.keyboard.press(key);
      await expect(trigger).toBeFocused(); observed.push(await expected.observe());
      return {} as Awaited<ReturnType<StatisticsNativeZoomEvidence["capture"]>>;
    } } as StatisticsNativeZoomEvidence);
    try {
      await evidence(page, info, "controlled-draft-name", {}, { requests: [], before: 0 });
      expect(observed).toEqual([{ dialogName: name, visible: true, rawValues: ["2027", "10"], invalidRequests: [] }]);
      await expect(page.getByRole("dialog", { name, exact: true })).toBeVisible();
    } finally { nativeEvidence.delete(page); }
  });
}
for (const scenario of ["unexpected", "duplicate", "mixed"] as const) test(`native Surface setup rejects ${scenario} dialogs`, async ({ page }, info) => {
  const dialogs = scenario === "unexpected" ? ["다른 dialog"] : scenario === "duplicate" ? ["사용량 분석 조건", "사용량 분석 조건"] : ["사용량 분석 조건", "다른 dialog"];
  await page.setContent(dialogs.map(name => `<div role="dialog" aria-label="${name}"><span role="spinbutton" tabindex="0">2027</span></div>`).join(""));
  let requests = 0;
  nativeEvidence.set(page, { capture: async () => { requests++; return {} as Awaited<ReturnType<StatisticsNativeZoomEvidence["capture"]>>; } } as StatisticsNativeZoomEvidence);
  try {
    await expect(evidence(page, info, "controlled-rejected-name", {}, { requests: [], before: 0 })).rejects.toThrow();
    expect(requests).toBe(0); await expect(page.getByRole("dialog")).toHaveCount(dialogs.length);
  } finally { nativeEvidence.delete(page); }
});

test("native Surface setup centers original trigger after broader sticky-header controls", async ({ page }, info) => {
  await page.setViewportSize({ width: 720, height: 406 });
  await page.setContent(`<style>body{margin:0}header{position:fixed;inset:0 0 auto;height:120px;background:white;z-index:10}section{position:relative;height:1800px}button{position:absolute;left:31px;width:64px;height:44px}#original{top:400px}#last{top:500px}</style>
    <header>sticky header</header><section aria-label="사용량 분석 조건">
    <button id="original" aria-label="사용량 분석 조건 상세 필터" aria-expanded="false">조건</button><button id="last">초기화</button></section>
    <div role="dialog" aria-label="사용량 분석 조건" hidden>조건 내용</div>`);
  await page.evaluate(() => {
    const trigger = document.querySelector<HTMLButtonElement>("#original")!, dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    trigger.addEventListener("click", () => { dialog.hidden = false; trigger.setAttribute("aria-expanded", "true"); });
    document.addEventListener("keydown", event => { if (event.key === "Escape") { dialog.hidden = true; trigger.setAttribute("aria-expanded", "false"); trigger.focus(); } });
  });
  let bounds: { x: number; y: number; width: number; height: number } | null = null;
  nativeEvidence.set(page, { capture: async (_label, trigger, action, keys, expected) => {
    await trigger.scrollIntoViewIfNeeded();
    // This original target, not the previously centered last sibling, must have
    // the unchanged complete unoccluded44 area BEFORE its real pointer dispatch.
    await expectMinimumTouchTargets(page, "#original"); bounds = await trigger.boundingBox();
    await page.mouse.click(bounds!.x + bounds!.width / 2, bounds!.y + bounds!.height / 2);
    await action(); for (const key of keys) await page.keyboard.press(key);
    await expect(trigger).toBeFocused(); expect(await expected.observe()).toEqual({ dialogName: "사용량 분석 조건", visible: false, expanded: "false" });
    return {} as Awaited<ReturnType<StatisticsNativeZoomEvidence["capture"]>>;
  } } as StatisticsNativeZoomEvidence);
  try {
    await evidence(page, info, "controlled-original-trigger", {});
    expect(bounds).not.toBeNull(); expect(bounds!.y).toBeGreaterThanOrEqual(120);
    await expect(page.getByRole("dialog")).toHaveCount(0); await expect(page.locator("#original")).toBeFocused();
  } finally { nativeEvidence.delete(page); }
});

async function install(page: Page, baseURL: string) {
  const requests: Request[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await installMockApiBoundary(page.context(), baseURL);
  await installSettingsApiRoutes(page, "viewer", { ids: { siteId } });
  await page.route("**/api/energy/**", async route => {
    const req = route.request(), url = new URL(req.url()), params = url.searchParams;
    requests.push({ method: req.method(), path: url.pathname, params: Object.fromEntries(params), body: req.postData() ? req.postDataJSON() : null });
    if (url.pathname === `/api/energy/sites/${siteId}/summary`) {
      const available = { estimatedKwh: 0, estimatedCost: 0, knownSeconds: 43200, unknownSeconds: 0, dataStatus: "available" };
      return route.fulfill({ json: { siteId, timeZone: "Asia/Seoul", source: "state_based_estimate", generatedAt: instant, today: available,
        monthToDate: { ...available, knownSeconds: 0, unknownSeconds: 86400, dataStatus: "no_data" }, yearToDate: { ...available, estimatedKwh: 900, estimatedCost: 144000, unknownSeconds: 7200, dataStatus: "partial" },
        monthForecast: { estimatedKwh: null, estimatedCost: null, observedKnownSeconds: 0, reason: "insufficient_state" }, baseline24Hours: { estimatedKwh: 297.6, estimatedCost: 47616, fixtureCount: 4, daysInMonth: 31 }, estimatedSavings: { kwh: null, cost: null }, lastAggregatedAt: instant } });
    }
    if (url.pathname.endsWith("/rankings")) {
      const dimension = params.get("dimension") ?? "floor", metric = params.get("metric") ?? "usage", from = params.get("from"), to = params.get("to");
      return route.fulfill({ json: { siteId, timeZone: "Asia/Seoul", source: "state_based_estimate", generatedAt: instant, dimension, metric, sort: params.get("sort") ?? "desc", range: { from, to }, siteTotalKwh: 20, siteTotalCost: 3200, overlappingMemberships: dimension === "group", legacyExcludedBefore: null,
        ranked: [{ identityId, operationalId: identityId, name: names[0], rank: 1, fixtureCount: 4, estimatedKwh: 12.5, estimatedCost: 2000, contributionRate: .625, perFixtureAverageKwh: 3.125, metricValue: metric === "cost" ? 2000 : 12.5,
          knownSeconds: 691200, unknownSeconds: 0, coverageRate: 1, dataStatus: "available", historyQuality: "observed", unrankedReason: null, previousPeriod: { estimatedKwh: 14, changeRatePercent: -10.71, rank: 1 }, dailyPoints: [{ period: to, estimatedKwh: 1.3, dataStatus: "available" }], fixtures: [{ identityId: "99999999-9999-4999-8999-000000000101", name: names[1], estimatedKwh: 2.1 }] }], unranked: [] } });
    }
    if (url.pathname.endsWith("/heatmap/observed-mean")) return route.fulfill({ json: { siteId, timeZone: "Asia/Seoul", generatedAt: instant, metric: params.get("metric"), scope: params.get("scope"), identityId: params.get("identityId"), range: { from: params.get("from"), to: params.get("to") },
      cells: Array.from({ length: 168 }, (_, n) => ({ weekday: Math.floor(n / 24), hour: n % 24, value: n === 1 ? null : n === 0 ? 0 : .5, knownSeconds: n === 1 ? 1800 : 3600, expectedSeconds: 3600, observedLocalDays: 1, eligibleLocalDays: 1, coverageRate: n === 1 ? .5 : 1 })) } });
    if (url.pathname.endsWith("/report-targets")) return route.fulfill({ json: { siteId, timeZone: "Asia/Seoul", lastCompletedDate: "2026-10-01", targets: [{ scope: "site", identityId: siteId, label: names[0] }] } });
    if (url.pathname.endsWith("/reports") && req.method() === "GET") return route.fulfill({ json: { reports: [], nextCursor: null, totalCount: 0 } });
    if (url.pathname.endsWith("/reports") && req.method() === "POST") {
      const request = req.postDataJSON() as EnergyReportRequest;
      return route.fulfill({ json: { reportId: "99999999-9999-4999-8999-000000000701", siteId, request, status: "completed", progressPercent: 100, createdAt: instant, startedAt: instant, completedAt: instant, expiresAt: "2026-10-08T15:00:00.000Z", failureCode: null, target: { scope: request.scope, identityId: request.identityId, label: "Task9 유지 보고서 현장" }, requestedAt: instant, failure: null } });
    }
    if (url.pathname.endsWith("/exports/csv")) return route.fulfill({ contentType: "text/csv", body: "date,kwh\n2026-10-01,1.3\n" });
    return route.fulfill({ status: 404, json: { message: "Unknown statistics fixture endpoint" } });
  });
  return { requests, errors };
}

async function evidence(page: Page, info: TestInfo, label: string, value: unknown, invalidRequestBoundary?: { requests: Request[]; before: number }) {
  await info.attach(label, { body: JSON.stringify(value, null, 2), contentType: "application/json" });
  const native = nativeEvidence.get(page);
  if (!native) {
    await info.attach(`${label}-screen`, { body: await page.screenshot({ path: info.outputPath(`${label}.png`), fullPage: true }), contentType: "image/png" });
    return;
  }
  const dialog = page.getByRole("dialog");
  if (await dialog.count()) {
    // Navigation-only keyboard input preserves the actual invalid draft and
    // keeps its Popover/create dialog open for the original following checks.
    // Modal titles use RAC's public Heading/aria-labelledby route, whereas the
    // filter Popover uses aria-label. Recognize the exact accessible role/name
    // contract without treating either naming mechanism as the only valid one.
    const draftNames = ["사용량 분석 조건", "에너지 사용량 보고서 만들기"] as const;
    const matches = await Promise.all(draftNames.map(name => page.getByRole("dialog", { name, exact: true }).count()));
    if (await dialog.count() !== 1 || matches.reduce((total, count) => total + count, 0) !== 1) throw new Error("Unexpected or ambiguous native draft dialog");
    const dialogName = draftNames[matches.findIndex(count => count === 1)]!;
    if (!invalidRequestBoundary) throw new Error("Missing native invalid-request boundary");
    const namedDialog = page.getByRole("dialog", { name: dialogName, exact: true });
    await info.attach(`${label}-native-dialog-identity`, { body: JSON.stringify({ utc: new Date().toISOString(), dialogName,
      literalAriaLabel: await namedDialog.getAttribute("aria-label"), labelledBy: await namedDialog.getAttribute("aria-labelledby"), headings: await namedDialog.getByRole("heading").allTextContents() }, null, 2), contentType: "application/json" });
    const segments = namedDialog.getByRole("spinbutton"), rawValues = await segments.allTextContents();
    const invalidRequests = () => invalidRequestBoundary.requests.slice(invalidRequestBoundary.before)
      .filter(request => request.method === "POST" || /\/rankings$|\/heatmap\/observed-mean$|\/exports\/csv$/.test(request.path));
    expect(invalidRequests()).toEqual([]);
    await native.capture(label, segments.first(), async () => {}, ["Tab", "Shift+Tab"], {
      description: `${dialogName} remains open with unchanged invalid date segments, zero invalid requests and original segment focus`,
      observe: async () => {
        await expect(namedDialog).toBeVisible();
        await expect(segments).toHaveText(rawValues);
        expect(invalidRequests()).toEqual([]);
        return { dialogName, visible: await namedDialog.isVisible(), rawValues: await segments.allTextContents(), invalidRequests: invalidRequests() };
      }
    });
  } else {
    const trigger = page.getByRole("button", { name: /(?:사용량 분석 조건|보고서 조건) 상세 필터/ });
    // Viewport intersection alone can leave the trigger behind compact Shell's
    // fixed bottom navigation. Consume the same public centered-scroll/actual
    // unoccluded44 contract as Flow before dispatching the original pointer.
    const scope = await trigger.getAttribute("aria-label");
    await expectMinimumTouchTargetsAfterScrolling(page, scope?.startsWith("보고서 조건")
      ? '[role="search"][aria-label="보고서 이력 필터"]'
      : 'section[aria-label="사용량 분석 조건"]');
    // The section-wide loop finishes on its last control. Center and measure
    // THIS original trigger immediately, so a sticky header cannot occlude its
    // complete44 area even while the center pointer alone would still hit it.
    await trigger.evaluate(element => { element.scrollIntoView({ block: "center", inline: "center" }); element.setAttribute("data-e2e-native-original-trigger", "true"); });
    try {
      await expectMinimumTouchTargets(page, '[data-e2e-native-original-trigger="true"]');
      await info.attach(`${label}-native-original-trigger-hit`, { body: JSON.stringify({ utc: new Date().toISOString(),
        scope, completeUnoccluded44: true, measurement: await trigger.evaluate(element => {
          const rect = element.getBoundingClientRect();
          const points = [[rect.left + 1, rect.top + 1], [rect.right - 1, rect.top + 1], [rect.left + 1, rect.bottom - 1], [rect.right - 1, rect.bottom - 1], [rect.left + rect.width / 2, rect.top + rect.height / 2]];
          return { bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }, scrollX, scrollY,
            hits: points.map(([x, y]) => { const hit = document.elementFromPoint(x!, y!); return { x, y, reachesOriginal: hit === element || Boolean(hit && element.contains(hit)) }; }) };
        }) }, null, 2), contentType: "application/json" });
    } finally { await trigger.evaluate(element => element.removeAttribute("data-e2e-native-original-trigger")); }
    const dialogName = scope?.startsWith("보고서 조건") ? "보고서 조건" : "사용량 분석 조건";
    const namedDialog = page.getByRole("dialog", { name: dialogName, exact: true });
    await native.capture(label, trigger, async () => { await expect(namedDialog).toBeVisible(); }, ["Escape"], {
      description: `${dialogName} dialog closed, trigger collapsed and focused`,
      observe: async () => {
        await expect(namedDialog).not.toBeVisible();
        await expect(trigger).toHaveAttribute("aria-expanded", "false");
        return { dialogName, visible: await namedDialog.isVisible(), expanded: await trigger.getAttribute("aria-expanded") };
      }
    });
  }
}
async function geometry(page: Page) {
  return page.evaluate(() => ({ client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, width: innerWidth, dpr: devicePixelRatio, scale: visualViewport?.scale }));
}
async function longNameSurface(page: Page, info: TestInfo) {
  const detail = page.getByRole("complementary", { name: `${names[0]} 상세`, exact: true });
  await expect(detail).toBeVisible();
  await expect(detail.getByRole("heading", { name: names[0], exact: true })).toHaveText(names[0]);
  await expect(detail.locator("li span")).toHaveText(names[1]);
  const measured = await geometry(page);
  await evidence(page, info, "long-name-geometry", measured);
  expect(measured.scroll).toBe(measured.client);
  const contentBounds = [];
  for (const element of [detail.getByRole("heading", { name: names[0], exact: true }), detail.locator("li span"), detail.locator("li strong"), detail.locator(".recharts-wrapper")]) {
    const box = await element.boundingBox();
    contentBounds.push(box);
    expect(box).not.toBeNull(); expect(box!.width).toBeGreaterThan(0);
    expect(box!.x).toBeGreaterThanOrEqual(0); expect(box!.x + box!.width).toBeLessThanOrEqual(measured.client);
    await element.scrollIntoViewIfNeeded();
    await expect(element).toBeVisible();
  }
  // Preserve the intentional inner heatmap scroll rather than clipping the page.
  await expect(page.getByRole("region", { name: "시간대별 사용량" })).toBeVisible();
  await evidence(page, info, "long-name-content-bounds", { measured, contentBounds });
}
async function keyYear(page: Page, label: string, key: string) {
  const year = page.getByRole("group", { name: label, exact: true }).getByRole("spinbutton").first();
  await year.focus(); await page.keyboard.press(key);
  return year;
}
async function clear(page: Page, label: string) {
  const segments = page.getByRole("group", { name: label, exact: true }).getByRole("spinbutton");
  for (let n = 0; n < 3; n++) { await segments.nth(n).focus(); for (let k = 0; k < 4; k++) await page.keyboard.press("Backspace"); }
}
async function enterDate(page: Page, label: string, values: string[]) {
  const segments = page.getByRole("group", { name: label, exact: true }).getByRole("spinbutton");
  for (let n = 0; n < 3; n++) { await segments.nth(n).focus(); await page.keyboard.type(values[n]!); }
}
const mutations = ["future", "clear-start", "clear-end", "reversed"] as const;
async function analysisDraft(page: Page, info: TestInfo, state: Awaited<ReturnType<typeof install>>, mutation: typeof mutations[number]) {
  await expect(page.getByRole("region", { name: "사용량 순위" })).toBeVisible();
  await page.getByRole("button", { name: /사용량 분석 조건 상세 필터/ }).click();
  const before = state.requests.length;
  if (mutation === "future") await keyYear(page, "시작일", "ArrowUp");
  else if (mutation === "reversed") await keyYear(page, "종료일", "ArrowDown");
  else await clear(page, mutation === "clear-start" ? "시작일" : "종료일");
  await evidence(page, info, `${mutation}-draft`, { errors: state.errors, requests: state.requests.slice(before) }, { requests: state.requests, before });
  expect(state.errors).toEqual([]);
  await page.getByRole("button", { name: "필터 닫기" }).click();
  await expect(page.getByText("완료된 기간을 선택해 주세요.")).toBeVisible();
  await page.getByRole("button", { name: /사용량 분석 조건 상세 필터/ }).click();
  if (mutation === "future") await expect(page.getByRole("group", { name: "시작일", exact: true }).getByRole("spinbutton").first()).toHaveText("2027");
  if (mutation === "reversed") await expect(page.getByRole("group", { name: "종료일", exact: true }).getByRole("spinbutton").first()).toHaveText("2025");
  expect(state.requests.slice(before).filter(r => /\/rankings$|\/heatmap\/observed-mean$/.test(r.path))).toEqual([]);
  if (mutation === "future") await keyYear(page, "시작일", "ArrowDown");
  else if (mutation === "reversed") await keyYear(page, "종료일", "ArrowUp");
  else await enterDate(page, mutation === "clear-start" ? "시작일" : "종료일", ["2026", "10", "1"]);
  await page.getByRole("button", { name: "필터 닫기" }).click();
  await expect(page.getByRole("region", { name: "사용량 순위" })).toBeVisible();
  await expect(page.getByRole("region", { name: "시간대별 사용량" })).toBeVisible();
  for (const kind of ["/rankings", "/heatmap/observed-mean"]) expect(state.requests.filter(r => r.path.endsWith(kind)).at(-1)?.params).toMatchObject({ from: "2026-10-01", to: "2026-10-01" });
  expect(state.errors).toEqual([]);
  await evidence(page, info, "analysis-recovered-params", { mutation, requests: state.requests.filter(r => /\/rankings$|\/heatmap\/observed-mean$/.test(r.path)).slice(-2), errors: state.errors });
}
async function reportDraft(page: Page, info: TestInfo, state: Awaited<ReturnType<typeof install>>, mutation: typeof mutations[number]) {
  await page.getByRole("button", { name: "보고서 만들기", exact: true }).click();
  const before = state.requests.length;
  if (mutation === "future") await keyYear(page, "기간 시작", "ArrowUp");
  else if (mutation === "reversed") await keyYear(page, "기간 종료", "ArrowDown");
  else await clear(page, mutation === "clear-start" ? "기간 시작" : "기간 종료");
  await evidence(page, info, `report-${mutation}-draft`, { errors: state.errors, requests: state.requests.slice(before) }, { requests: state.requests, before });
  expect(state.errors).toEqual([]);
  const dialog = page.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" });
  if (mutation === "future") await expect(dialog.getByRole("group", { name: "기간 시작", exact: true }).getByRole("spinbutton").first()).toHaveText("2027");
  if (mutation === "reversed") await expect(dialog.getByRole("group", { name: "기간 종료", exact: true }).getByRole("spinbutton").first()).toHaveText("2025");
  await expect(dialog.getByRole("button", { name: "보고서 요청", exact: true })).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "CSV 내보내기", exact: true })).toBeDisabled();
  await expect(dialog.getByText("시작일과 종료일을 마지막 완료일 이내의 순서대로 선택해 주세요.")).toBeVisible();
  expect(state.requests.slice(before).filter(r => r.method === "POST" || r.path.endsWith("/exports/csv"))).toEqual([]);
  if (mutation === "future") await keyYear(page, "기간 시작", "ArrowDown");
  else if (mutation === "reversed") await keyYear(page, "기간 종료", "ArrowUp");
  else await enterDate(page, mutation === "clear-start" ? "기간 시작" : "기간 종료", mutation === "clear-start" ? ["2026", "9", "2"] : ["2026", "10", "1"]);
  await expect(dialog.getByRole("button", { name: "보고서 요청", exact: true })).toBeEnabled();
  await expect(dialog.getByRole("button", { name: "CSV 내보내기", exact: true })).toBeEnabled();
  await dialog.getByRole("button", { name: "보고서 요청", exact: true }).click();
  await expect(dialog).not.toBeVisible();
  expect(state.requests.filter(r => r.method === "POST").at(-1)?.body).toEqual({ from: "2026-09-02", to: "2026-10-01", scope: "site", identityId: siteId, format: "pdf" });
  await page.getByRole("button", { name: "보고서 만들기", exact: true }).click();
  await page.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" }).getByRole("button", { name: "CSV 내보내기", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" })).not.toBeVisible();
  expect(state.requests.filter(r => r.path.endsWith("/exports/csv")).at(-1)?.params).toEqual({ from: "2026-09-02", to: "2026-10-01", scope: "site", identityId: siteId });
  expect(state.errors).toEqual([]);
  await evidence(page, info, "report-recovered-params", { mutation, requests: state.requests.filter(r => r.method === "POST" || r.path.endsWith("/exports/csv")), errors: state.errors });
}

for (const viewport of [{ width: 320, height: 844 }, { width: 390, height: 320 }, { width: 1440, height: 900 }]) test(`unchanged long statistics names fit ${viewport.width}x${viewport.height}`, async ({ page, baseURL }, info) => {
  await page.setViewportSize(viewport); const state = await install(page, baseURL!);
  await page.goto(path("analysis")); await longNameSurface(page, info); expect(state.errors).toEqual([]);
});
for (const mutation of mutations) {
  test(`analysis native ${mutation} draft and recovery`, async ({ page, baseURL }, info) => { const state = await install(page, baseURL!); await page.goto(path("analysis")); await analysisDraft(page, info, state, mutation); });
  test(`report native ${mutation} draft and recovery`, async ({ page, baseURL }, info) => { const state = await install(page, baseURL!); await page.goto(path("reports")); await reportDraft(page, info, state, mutation); });
}
test("analysis inclusive 400 days remains valid but 401 emits no query", async ({ page, baseURL }, info) => {
  const state = await install(page, baseURL!); await page.goto(path("analysis"));
  await expect(page.getByRole("region", { name: "사용량 순위" })).toBeVisible();
  await page.getByRole("button", { name: /사용량 분석 조건 상세 필터/ }).click();
  await enterDate(page, "시작일", ["2025", "8", "28"]);
  await page.getByRole("button", { name: "필터 닫기" }).click();
  await expect(page.getByRole("region", { name: "사용량 순위" })).toBeVisible();
  expect(state.requests.filter(r => r.path.endsWith("/rankings")).at(-1)?.params).toMatchObject({ from: "2025-08-28", to: "2026-10-01" });
  const before = state.requests.length;
  await page.getByRole("button", { name: /사용량 분석 조건 상세 필터/ }).click();
  const day = page.getByRole("group", { name: "시작일", exact: true }).getByRole("spinbutton").nth(2); await day.focus(); await page.keyboard.press("ArrowDown");
  await page.getByRole("button", { name: "필터 닫기" }).click();
  await expect(page.getByText("완료된 기간을 선택해 주세요.")).toBeVisible();
  expect(state.requests.slice(before).filter(r => /\/rankings$|\/heatmap\/observed-mean$/.test(r.path))).toEqual([]);
  await evidence(page, info, "400-401-query-boundary", { requests: state.requests, errors: state.errors });
  expect(state.errors).toEqual([]);
});
test("genuine native browser200 keeps long names and both future drafts safe", async ({ baseURL }, info) => {
  test.setTimeout(90000);
  const context = await chromium.launchPersistentContext("", { channel: "chromium", viewport: null, deviceScaleFactor: undefined, baseURL, args: ["--window-size=1440,900", "--enable-automation"] });
  let native: StatisticsNativeZoomEvidence | undefined;
  try {
    const page = context.pages()[0]!;
    const state = await install(page, baseURL!); await page.goto(path("analysis"));
    native = await StatisticsNativeZoomEvidence.create(context, page, info);
    const { before, after } = await native.global200(context); nativeEvidence.set(page, native);
    await evidence(page, info, "genuine-native-200", { before, after, settingsValue: 2 });
    await longNameSurface(page, info); await analysisDraft(page, info, state, "future");
    await page.goto(path("reports")); await reportDraft(page, info, state, "future");
  } finally {
    try { await native?.stop(); } finally { await context.close(); await native?.recordContextCleanup(); }
  }
});
