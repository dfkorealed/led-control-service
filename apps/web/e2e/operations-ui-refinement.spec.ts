import { chromium, expect, test, type Locator, type Page, type TestInfo } from "@playwright/test";
import type { ScheduleResponse, VehicleEventRuleResponse } from "../src/api/automation";
import type { CommandStatusResponse } from "../src/api/commands";
import { installMockApiBoundary } from "./support/mock-api-boundary";
import { installOperationalMapFixture, operationalDenseFixtures, operationalIds as ids } from "./support/operational-map-fixture";
import { expectMinimumTouchTargetsAfterScrolling } from "./support/layout-assertions";
import { StatisticsNativeZoomEvidence } from "./support/statistics-native-zoom-evidence";

const instant = "2026-10-01T15:00:00.000Z";
const longName = "야간 주차장 안전 조명 운영 규칙 및 장문 현장 이름";
const commandId = "99999999-9999-4999-8999-000000000801";
const matrix = [
  { width: 320, height: 740 }, { width: 390, height: 844 }, { width: 768, height: 900 },
  { width: 1023, height: 900 }, { width: 1024, height: 900 }, { width: 1287, height: 900 },
  { width: 1440, height: 900 }, { width: 390, height: 320 }, { width: 1440, height: 600 }
];

test.describe.configure({ mode: "serial" });
test.use({ trace: "off", screenshot: process.env.E2E_TASK9_NATIVE === "1" ? "off" : "only-on-failure" });

// Strict comment mapping: 1 map bounds; 2 real alarm companion; 3 original
// control-map-target-selection contracts; 4 inline results; 5/6/8/9/10/11
// automation grid; 7 common filters; 12 independent site/map bands; 13 eager
// Settings account; 14 command-history filter. Original suites are also run
// unchanged, including 1000-editor exact-ID/pixel/save and 8-second budgets.
for (const viewport of matrix) test(`Task9 integration surfaces ${viewport.width}x${viewport.height}`, async ({ page, baseURL }, info) => {
  test.setTimeout(120_000);
  await page.setViewportSize(viewport);
  const state = await install(page, baseURL!);
  await page.goto(`/monitoring?siteId=${ids.siteId}`);
  await mapSurface(page, info, "monitoring");
  await expect(page.locator("[data-shell-topbar]").getByRole("button", { name: "로그아웃" })).toHaveCount(0);
  await page.goto(`/control?siteId=${ids.siteId}`);
  await mapSurface(page, info, "control");
  for (const mode of ["schedule", "event"] as const) {
    await page.goto(`/control?siteId=${ids.siteId}&mode=${mode}`);
    await automationSurface(page, info, mode);
  }
  await page.goto(`/settings?siteId=${ids.siteId}`);
  const account = page.getByRole("region", { name: "내 계정", exact: true });
  await expect(account).toBeVisible();
  const logout = account.getByRole("button", { name: "로그아웃", exact: true });
  await expect(logout).toHaveCount(1); await target44(logout);
  await zeroX(page);
  await screenshot(page, info, "settings-eager-account");
  expect(state.writes).toEqual([]); expect(state.api.dimmingRequests).toEqual([]);
  await info.attach("integration-network", { body: JSON.stringify({ writes: state.writes, requests: state.api.requests, pageErrors: state.errors }), contentType: "application/json" });
  expect(state.errors).toEqual([]);
});

for (const outcome of ["applied", "partially_applied", "not_applied"] as const) test(`Task9 completed ${outcome} inline final row and command filter`, async ({ page, baseURL }, info) => {
  await install(page, baseURL!, outcome);
  await page.goto(`/control?siteId=${ids.siteId}`);
  await inlineResult(page, info, true, outcome);
  await expect(page.locator('[aria-label="명령 진행 상태"]').getByText(outcome === "applied" ? "성공" : outcome === "partially_applied" ? "일부 성공" : "실패", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "명령 이력 열기", exact: true }).click();
  const filter = page.getByRole("button", { name: /명령 이력 필터 상세 필터/ });
  await target44(filter); await filter.click();
  await expect(page.getByRole("button", { name: "필터 초기화", exact: true })).toBeVisible();
  await page.keyboard.press("Escape"); await expect(filter).toBeFocused();
  await zeroX(page);
});

for (const state of ["empty", "loading", "error"] as const) test(`Task9 automation ${state} remains readable and emits no write`, async ({ page, baseURL }, info) => {
  const fixture = await install(page, baseURL!);
  let release: (() => void) | undefined;
  const held = new Promise<void>(resolve => { release = resolve; });
  let failedResponses = 0;
  // This list retains the production QueryClient's three retry/backoff steps.
  // Wait for the terminal HTTP attempt, rather than racing its 7s backoff with
  // the ordinary 5s locator assertion or changing query/timeout policy.
  const terminalFailure = state === "error" ? page.waitForResponse(result =>
    result.url().includes("/automation/schedules") && result.status() === 503 && ++failedResponses === 4) : undefined;
  await page.route("**/api/sites/*/automation/schedules**", async route => {
    if (state === "loading") await held;
    return route.fulfill(state === "error" ? { status: 503, json: { message: "task9 owned unavailable" } }
      : { json: { items: [], total: 0, nextCursor: null } });
  });
  try {
    await page.setViewportSize({ width: 390, height: 320 });
    await page.goto(`/control?siteId=${ids.siteId}&mode=schedule`);
    if (terminalFailure) await terminalFailure;
    await expect(page.getByText(state === "empty" ? "등록된 스케줄이 없습니다." : state === "loading" ? "스케줄을 불러오는 중입니다." : /스케줄.*불러오지|스케줄.*실패|연결 상태/).first()).toBeVisible();
    await zeroX(page); await screenshot(page, info, state);
    expect(fixture.writes).toEqual([]);
  } finally { release?.(); }
});

test.describe("owned native originals", () => {
test("Task9 own native 200 original map, grid, inline end and account", async ({ baseURL }, info) => {
  test.skip(process.env.E2E_TASK9_NATIVE !== "1", "Explicit owned native200 run after the source freeze; no emulation fallback.");
  test.setTimeout(240_000);
  const context = await chromium.launchPersistentContext("", { channel: "chromium", viewport: null,
    deviceScaleFactor: undefined, baseURL, args: ["--window-size=1440,900"] });
  let native: StatisticsNativeZoomEvidence | undefined;
  try {
    const page = context.pages()[0]!;
    const state = await install(page, baseURL!, "not_applied");
    await page.goto(`/monitoring?siteId=${ids.siteId}`);
    native = await StatisticsNativeZoomEvidence.create(context, page, info);
    await native.global200(context);
    const capture = async (label: string, trigger: Locator, action: () => Promise<void>, keys: string[], content: Locator) => {
      await trigger.evaluate(element => element.scrollIntoView({ block: "center", inline: "center" }));
      await target44(trigger);
      await native!.capture(label, trigger, action, keys, {
        description: `${label}: actual intended content, zero overflow, focus and no mutations`,
        observe: async () => {
          await zeroX(page); await expect(content).toBeVisible();
          const observed = await content.evaluate(element => {
            const rect = element.getBoundingClientRect(), hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + Math.min(rect.height / 2, 20));
            return { text: element.textContent, rect: rect.toJSON(), hit: Boolean(hit && (element === hit || element.contains(hit))) };
          });
          expect(observed.hit).toBe(true); expect(state.writes).toEqual([]);
          return { observed, writes: [...state.writes] };
        }
      });
    };
    await mapSurface(page, info, "monitoring", false);
    const fit = page.getByRole("button", { name: "지도 전체 보기", exact: true });
    await capture("Task9-monitoring-map-footer", fit, async () => {}, [], page.getByRole("group", { name: "지도 조작", exact: true }));
    await page.goto(`/control?siteId=${ids.siteId}&mode=schedule`);
    await automationSurface(page, info, "schedule", false);
    const action = page.getByRole("button", { name: `${longName} 스케줄 작업`, exact: true });
    await capture("Task9-native-schedule-row-action", action, async () => { await expect(page.getByRole("menuitem")).toHaveCount(2); }, ["Escape"], action);
    // The long name is a distinct naturally reachable state, not a claim that
    // a mobile card's distant name and footer fit simultaneously.
    const name = page.getByText(`${longName} 스케줄`, { exact: true });
    await name.scrollIntoViewIfNeeded();
    const search = page.getByRole("searchbox", { name: "스케줄 검색", exact: true });
    await capture("Task9-native-schedule-name", search, async () => {
      const box = (await name.boundingBox())!;
      await page.mouse.move(2, 220); await page.mouse.wheel(0, box.y + box.height / 2 - 240);
    }, [], name);
    await page.goto(`/control?siteId=${ids.siteId}`);
    await inlineResult(page, info, false);
    const detail = page.getByRole("region", { name: "최근 결과 상세", exact: true });
    // A focusable scroll region is not a button. Capture through the last
    // keyboard-focused detail region without adding an artificial focus node.
    await capture("Task9-native-inline-final-row", detail, async () => { await page.mouse.wheel(0, 10000); }, ["End"], detail.getByText("Task9 마지막 조명 040: 적용 실패", { exact: true }));
    await page.goto(`/settings?siteId=${ids.siteId}`);
    const account = page.getByRole("region", { name: "내 계정", exact: true });
    const overview = page.getByRole("navigation", { name: "설정 메뉴" }).getByRole("link", { name: "설정 개요", exact: true });
    // Re-selecting the current overview is harmless. Native wheel exposes the
    // eager account panel; Logout itself must not be clicked for a photograph.
    await capture("Task9-native-settings-account", overview, async () => {
      await page.mouse.move(2, 220); await page.mouse.wheel(0, 200);
    }, [], account.getByRole("button", { name: "로그아웃", exact: true }));
    expect(state.api.dimmingRequests).toEqual([]); expect(state.errors).toEqual([]);
  } finally { try { await native?.stop(); } finally { await context.close(); await native?.recordContextCleanup(); } }
});
});

async function install(page: Page, baseURL: string, outcome: "applied" | "partially_applied" | "not_applied" = "not_applied") {
  await installMockApiBoundary(page.context(), baseURL);
  const { api } = await installOperationalMapFixture(page, baseURL);
  const writes: string[] = [], errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("request", request => { if (new URL(request.url()).pathname.startsWith("/api/") && !["GET", "HEAD"].includes(request.method())) writes.push(`${request.method()} ${new URL(request.url()).pathname}`); });
  const fixture = operationalDenseFixtures()[0]!;
  const common = { name: longName, status: "enabled" as const, action: { dimmingEnabled: true, brightnessPercent: 70 },
    gatewayId: ids.gatewayId, targets: [{ fixtureId: fixture.id }], targetCount: 1, desiredRevision: 2, appliedRevision: 2,
    syncStatus: "APPLIED" as const, lastExecution: null, createdById: "own-user", updatedById: "own-user", createdAt: instant, updatedAt: instant };
  const schedule: ScheduleResponse = { ...common, id: "99999999-9999-4999-8999-000000000701", name: `${longName} 스케줄`,
    activeFrom: "2026-10-01T00:00:00.000Z", activeUntil: "2026-10-31T00:00:00.000Z", localStartTime: "18:00", localEndTime: "23:00",
    recurrence: { kind: "daily", weeklyDays: [], monthlyDay: null, yearlyMonth: null, yearlyDay: null }, fixtureIds: [fixture.id], nextOccurrence: null };
  const event: VehicleEventRuleResponse = { ...common, id: "99999999-9999-4999-8999-000000000702", name: `${longName} 이벤트`,
    sourceFixtureIds: [fixture.id], targetFixtureIds: [fixture.id], holdSeconds: 60, sources: [{ fixtureId: fixture.id }], sourceCount: 1, lastDetection: null };
  for (const [path, row] of [["schedules", schedule], ["vehicle-event-rules", event]] as const) {
    await page.route(`**/api/sites/${ids.siteId}/automation/${path}**`, route => route.fulfill({ json: {
      items: [row], total: 1, filteredTotal: 1, siteSummary: { ruleCount: 1, syncRuleCounts: { APPLIED: 1, PENDING: 0, REJECTED: 0 } }, nextCursor: null
    } }));
  }
  const status: CommandStatusResponse = { id: commandId, siteId: ids.siteId, stage: outcome === "applied" ? "completed" : outcome === "partially_applied" ? "partial_failed" : "failed", outcome, brightness: 30,
    targetFixtureIds: [fixture.id], totalFixtureCount: 40, completedFixtureCount: 40, dispatchCount: 1, errorMessage: null, createdAt: instant,
    dispatches: [{ id: "own-dispatch", kind: "dimming", status: "completed", gateway: { id: ids.gatewayId, name: "Task9 Gateway" }, errorMessage: null,
      results: Array.from({ length: 40 }, (_, index) => ({ fixtureId: `99999999-9999-4999-8999-${String(index + 900).padStart(12, "0")}`,
        fixtureName: `Task9 마지막 조명 ${String(index + 1).padStart(3, "0")}`, status: outcome === "applied" || outcome === "partially_applied" && index < 20 ? "succeeded" : "failed",
        brightness: outcome === "applied" ? 30 : null, errorMessage: outcome === "applied" ? null : "적용 실패", updatedAt: instant })) }] };
  await page.route("**/api/commands**", route => {
    const path = new URL(route.request().url()).pathname;
    const metadata = { generatedAt: instant, retainedFrom: "2026-07-01T15:00:00.000Z", retentionEnabled: false };
    if (path === "/api/commands") return route.fulfill({ json: { ...metadata, items: [status], nextCursor: null } });
    if (path === `/api/commands/${commandId}`) return route.fulfill({ json: { ...metadata, ...status } });
    return route.fallback();
  });
  await page.route("**/*", route => new URL(route.request().url()).origin === new URL(baseURL).origin ? route.fallback() : route.abort());
  return { api, writes, errors };
}

async function mapSurface(page: Page, info: TestInfo, surface: "monitoring" | "control", save = true) {
  const viewport = page.getByTestId(surface === "monitoring" ? "monitoring-map-viewport" : "target-selection-map-viewport");
  await expect(viewport).toBeVisible();
  expect((await viewport.boundingBox())!.height).toBeGreaterThanOrEqual(240);
  const marker = page.locator('[data-spatial-map-marker="true"]').first();
  await expect(marker).toBeVisible();
  const box = (await marker.boundingBox())!; expect(box.width).toBeGreaterThanOrEqual(48); expect(box.height).toBeGreaterThanOrEqual(48);
  for (const name of ["지도 축소", "지도 확대", surface === "monitoring" ? "지도 전체 보기" : "지도 화면 맞춤"]) await target44(page.getByRole("button", { name, exact: true }));
  await zeroX(page);
  if (save) await screenshot(page, info, `${surface}-map-footer`);
}

async function automationSurface(page: Page, info: TestInfo, mode: "schedule" | "event", save = true) {
  const kind = mode === "schedule" ? "스케줄" : "이벤트";
  const name = `${longName} ${kind}`;
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await expect(page.locator("[data-automation-overview]")).toHaveCount(0);
  const surface = page.locator("[data-automation-list-scroll]");
  expect(await surface.evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0);
  for (const th of await surface.getByRole("columnheader").all()) await expect(th).toHaveCSS("text-align", "center");
  if (mode === "schedule") await expect(surface.getByRole("columnheader", { name: "밝기", exact: true })).toHaveCount(0);
  const filter = page.getByRole("button", { name: new RegExp(`${kind}.*상세 필터`) });
  await target44(filter); await filter.focus(); await page.keyboard.press("Enter");
  const reset = page.getByRole("button", { name: "필터 초기화", exact: true });
  await target44(reset); await reset.click(); await page.keyboard.press("Escape"); await expect(filter).toBeFocused();
  const action = page.getByRole("button", { name: `${name} 작업`, exact: true });
  await target44(action); await action.focus(); await page.keyboard.press("Enter");
  await expect(page.getByRole("menuitem", { name: "삭제", exact: true })).toBeVisible();
  await expectMinimumTouchTargetsAfterScrolling(page, '[role="menu"]');
  await page.keyboard.press("Escape"); await expect(action).toBeFocused();
  await zeroX(page);
  if (save) await screenshot(page, info, `${mode}-row-action`);
}

async function inlineResult(page: Page, info: TestInfo, save = true, outcome = "not_applied") {
  await page.getByRole("region", { name: "최근 명령 이력" }).getByRole("button", { name: new RegExp(commandId) }).click();
  await page.getByRole("button", { name: "상세 보기", exact: true }).click();
  const detail = page.getByRole("region", { name: "최근 결과 상세", exact: true });
  await expect(detail).toBeVisible();
  await expect(page.getByRole("dialog", { name: /명령 상세|최근 결과/ })).toHaveCount(0);
  await detail.hover(); await page.mouse.wheel(0, 10000);
  await detail.focus(); await page.keyboard.press("End");
  const last = outcome === "applied" ? detail.getByRole("button", { name: "명령 상세 닫기", exact: true }) : detail.getByText(/Task9 마지막 조명 040/);
  await expect(last).toBeVisible();
  const d = (await detail.boundingBox())!, l = (await last.boundingBox())!;
  expect(l.y).toBeGreaterThanOrEqual(d.y); expect(l.y + l.height).toBeLessThanOrEqual(d.y + d.height);
  expect(await detail.evaluate(element => element.scrollWidth - element.clientWidth)).toBe(0);
  await zeroX(page); if (save) await screenshot(page, info, "inline-final-row");
}

async function target44(target: Locator) {
  await target.evaluate(element => element.scrollIntoView({ block: "center", inline: "center" }));
  const geometry = await target.evaluate(element => {
    const r = element.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { width: r.width, height: r.height, hit: Boolean(hit && (element === hit || element.contains(hit))) };
  });
  expect(geometry.width).toBeGreaterThanOrEqual(44); expect(geometry.height).toBeGreaterThanOrEqual(44); expect(geometry.hit).toBe(true);
}
async function zeroX(page: Page) { expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0); }
async function screenshot(page: Page, info: TestInfo, label: string) { await page.screenshot({ path: info.outputPath(`${label}.png`), fullPage: false }); }
