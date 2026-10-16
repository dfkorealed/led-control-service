import type { Locator, Page } from "@playwright/test";
import { test, expect } from "./support/design-system-fixture";
import { installFirstScreenStatisticsFixtures } from "./support/first-screen-statistics";

// Literal expectations come from the approved functional roles. These tests
// catch consumer overrides that defeat the shared recipe in generated CSS.
const viewportHeights = { 320: 600, 390: 844, 1024: 768, 1440: 900 } as const;
for (const width of [320, 390, 1024, 1440] as const) for (const theme of ["light", "dark"] as const) {
  test(`P3 exact section grid inset and heading roles ${width} ${theme}`, async ({ page, designScenario }) => {
    await page.setViewportSize({ width, height: viewportHeights[width] });
    await designScenario({ principal: "admin", state: "ready", theme });
    await page.route("**/api/sites/site-1/users", route => route.fulfill({ json: { users: [], count: 0, limit: 100 } }));
    await page.route("**/api/auth/mfa", route => route.fulfill({ json: { enabled: false, enabledAt: null } }));
    await page.route("**/api/auth/sessions", route => route.fulfill({ json: { sessions: [] } }));
    await page.goto("/monitoring");
    await expect(page.locator("html")).toHaveAttribute("data-customer-theme", theme);
    await expectRole(page.locator("[data-monitoring-screen]"), "row-gap", "20px");
    const map = page.locator("[data-monitoring-map-shell]");
    await expect(map).toBeVisible();
    const root = await page.locator("[data-monitoring-screen]").elementHandle();
    const mapOwner = await map.elementHandle();
    await page.getByRole("button", { name: "지도 전체 보기", exact: true }).click();
    await expect(page.locator("[data-monitoring-screen]")).toHaveCSS("row-gap", "8px");
    expect(await root!.evaluate(node => node === document.querySelector("[data-monitoring-screen]"))).toBe(true);
    expect(await mapOwner!.evaluate(node => node === document.querySelector("[data-monitoring-map-shell]"))).toBe(true);
    await page.keyboard.press("Escape");
    await expectRole(page.locator("[data-monitoring-screen]"), "row-gap", "20px");
    expect(await mapOwner!.evaluate(node => node === document.querySelector("[data-monitoring-map-shell]"))).toBe(true);
    await page.goto("/settings");
    await expectRole(page.getByRole("link", { name: "현장 관리", exact: true }).last().locator(".."), "gap", "18px");
    await expectRole(page.getByRole("region", { name: "설치 이어가기", exact: true }).locator("strong"), "font-size", "16px");
    await page.goto("/settings/security");
    await expect(page.getByTestId("account-security-layout")).toHaveCSS("gap", "18px");
    await expect(page.locator('[data-security-card="sessions"]')).toHaveCSS("padding", width < 760 ? "16px" : "20px");
    await expect(page.getByRole("heading", { name: "활성 세션", exact: true })).toHaveCSS("font-size", "16px");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  });

  test(`gateway connection uses regular card and small heading ${width} ${theme}`, async ({ page, designScenario }) => {
    await page.setViewportSize({ width, height: viewportHeights[width] });
    await designScenario({ principal: "admin", state: "empty", theme });
    await page.goto("/settings/registration");
    await expect(page.locator("html")).toHaveAttribute("data-customer-theme", theme);
    await expectRole(page.getByTestId("gateway-claim-form"), "padding", width < 760 ? "16px" : "20px");
    const heading = page.getByRole("heading", { name: "게이트웨이 등록", level: 3 });
    await expectRole(heading, "font-size", "16px");
    await expectRole(heading, "line-height", "24px");
  });

  test(`settings leaf section grid and regular panels ${width} ${theme}`, async ({ page, designScenario }) => {
    await page.setViewportSize({ width, height: viewportHeights[width] });
    await designScenario({ principal: "admin", state: "ready", theme });
    await page.route("**/api/sites/site-1/users", route => route.fulfill({ json: { users: [], count: 0, limit: 100 } }));
    await page.goto("/settings/users");
    await expect(page.locator("html")).toHaveAttribute("data-customer-theme", theme);
    await expectRole(page.getByRole("region", { name: "유저 관리", exact: true }), "gap", "20px");
    await page.goto("/settings/floor-plans");
    const floor = page.getByTestId("floor-plan-item");
    await expectRole(floor.locator(".."), "gap", "18px");
    await expectRole(floor, "padding", width < 760 ? "16px" : "20px");
    await page.goto("/settings/registration");
    const registration = page.getByTestId("commissioning-registration");
    await expectRole(registration, "padding", width < 760 ? "16px" : "20px");
    await expectRole(registration, "gap", "20px");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
  });

  test(`site subsection h3 uses section visual role ${width} ${theme}`, async ({ page, designScenario }) => {
    await page.setViewportSize({ width, height: viewportHeights[width] });
    await designScenario({ principal: "admin", state: "ready", theme });
    await installSiteRoles(page);
    await page.goto("/settings/site");
    await expect(page.locator("html")).toHaveAttribute("data-customer-theme", theme);
    const site = page.getByRole("region", { name: "현장 관리", exact: true });
    await expectRole(site, "gap", "20px");
    for (const name of ["현장 정보", "현장 구성", "층 관리", "구역 관리", "조명 관리"]) {
      const heading = page.getByRole("heading", { name, exact: true });
      await expectRole(heading, "font-size", "20px");
      await expectRole(heading, "line-height", "28px");
    }
    await expect(page.getByRole("heading", { name: "층 관리", level: 3 })).toBeVisible();
    await expectRole(page.getByRole("region", { name: "현장 구성", exact: true }).locator(".."), "gap", "18px");
    await expectRole(page.getByRole("region", { name: "현장 구성", exact: true }), "padding", width < 760 ? "16px" : "20px");
    await expectRole(page.getByRole("region", { name: "센서 운영 관리", exact: true }), "gap", "18px");
    for (const name of ["센서 운영 정책", "등록 조명 센서 준비"]) {
      const heading = page.getByRole("heading", { name, exact: true });
      await expectRole(heading, "font-size", "16px");
      await expectRole(heading, "line-height", "24px");
      await expectRole(heading.locator("xpath=ancestor::section[1]"), "padding", width < 760 ? "16px" : "20px");
    }
    const trigger = page.getByRole("button", { name: "현장 정보 수정", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "현장 정보 수정", exact: true });
    await expect(dialog).toHaveCSS("padding", width < 760 ? "16px" : "20px");
    await expect(dialog.getByRole("form", { name: "현장 정보", exact: true })).toHaveCSS("gap", "16px");
    const longName = "서울 본사 지하주차장 출입구 연결구역 조명 운영 현장";
    await dialog.getByLabel("현장명").fill(longName);
    await dialog.getByRole("button", { name: "현장 정보 저장", exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(page.getByText("현장 정보를 저장했습니다.", { exact: true })).toBeVisible();
    await expectTextFits(page.getByText(longName, { exact: true }));
    await page.getByRole("button", { name: "층 추가", exact: true }).click();
    const floor = page.getByRole("dialog", { name: "층 추가", exact: true });
    await expect(floor).toHaveCSS("padding", width < 760 ? "16px" : "20px");
    await expect(floor.getByRole("form", { name: "층 추가", exact: true })).toHaveCSS("gap", "16px");
    await floor.getByRole("textbox", { name: /^새 층 이름/ }).fill("추가 운영층");
    await floor.getByRole("button", { name: "층 추가", exact: true }).click();
    await expect(floor).toHaveCount(0);
    await expect(page.getByText("추가 운영층", { exact: true }).first()).toBeVisible();
  });

  test(`statistics shell external panels units and tabs ${width} ${theme}`, async ({ page, designScenario }) => {
    await page.setViewportSize({ width, height: viewportHeights[width] });
    await designScenario({ principal: "admin", state: "ready", theme });
    await installFirstScreenStatisticsFixtures(page);
    const siteId = "30000000-0000-4000-8000-000000000001";
    await page.route("**/api/sites", route => route.fulfill({ json: [{ id: siteId, name: "테스트 주차장", customerName: "테스트 고객사" }] }));
    await page.goto(`/statistics/overview?siteId=${siteId}`);
    await expect(page.locator("html")).toHaveAttribute("data-customer-theme", theme);
    await expectRole(page.getByRole("region", { name: "통계", exact: true }), "gap", width < 760 ? "8px" : "20px");
    for (const name of ["상태 기반 추정 사용량", "이번 달 비용 비교", "운영 인사이트", "완료 기간 추정·예상 사용량 비교"]) {
      await expectRole(page.getByRole("heading", { name, exact: true }).locator("xpath=ancestor::*[@data-variant][1]"), "padding", width < 760 ? "16px" : "20px");
    }
    await expectRole(page.getByRole("heading", { name: "오늘 사용량과 비용", exact: true }), "font-size", "20px");
    await expectRole(page.getByRole("heading", { name: "상태 기반 추정 사용량", exact: true }), "font-size", "16px");
    await expectRole(page.getByRole("group", { name: "에너지 요약", exact: true }), "gap", "18px");
    await expectRole(page.getByRole("group", { name: "기준 및 동기간 비교", exact: true }), "gap", "18px");
    await expectTextFits(page.getByText("kWh", { exact: true }).first());
    await page.getByRole("link", { name: "사용 분석", exact: true }).click();
    await expect(page.getByRole("link", { name: "사용 분석", exact: true })).toHaveAttribute("aria-current", "page");
    await expectRole(page.getByRole("heading", { name: "선택 항목 시간대별 평균", exact: true }).locator("xpath=ancestor::section[1]"), "padding", width < 760 ? "16px" : "20px");
    await expectRole(page.getByRole("heading", { name: "선택 항목 시간대별 평균", exact: true }), "font-size", "16px");
    await expectRole(page.getByRole("heading", { name: "에너지 사용 비교", exact: true }).locator("xpath=ancestor::section[1]"), "padding", width < 760 ? "16px" : "20px");
    await page.getByRole("button", { name: /B1 주차장 1/ }).click();
    await expect(page.getByRole("complementary", { name: "B1 주차장 1 상세", exact: true })).toHaveCSS("padding", width < 760 ? "16px" : "20px");
    await page.getByRole("link", { name: "보고서", exact: true }).click();
    await expectRole(page.getByRole("region", { name: "에너지 보고서", exact: true }), "gap", width < 760 ? "8px" : "20px");
    await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    const reportTrigger = page.getByRole("button", { name: "보고서 만들기", exact: true });
    await reportTrigger.click();
    const report = page.getByRole("dialog", { name: "에너지 사용량 보고서 만들기", exact: true });
    await expect(report).toHaveCSS("padding", width < 760 ? "16px" : "20px");
    const close = report.getByRole("button", { name: "닫기", exact: true });
    const closeBox = (await close.boundingBox())!;
    expect(closeBox.width).toBe(56); expect(closeBox.height).toBe(56);
    await expect(report.locator("[data-dialog-body]")).toHaveCSS("overflow-y", "auto");
    await page.keyboard.press("Escape");
    await expect(reportTrigger).toBeFocused();
  });
}

async function expectRole(locator: Locator, property: string, value: string) {
  await expect(locator).toBeAttached();
  expect.soft(await locator.evaluate((element, property) => getComputedStyle(element).getPropertyValue(property), property), property).toBe(value);
}

// Removing the ordinary panel recipe must fail while the compact map workspace
// remains flush. Expectations are literal approved roles, not source classes.
for (const width of [320, 390, 1024, 1440] as const) for (const theme of ["light", "dark"] as const) {
  test(`control ordinary modes and editor information roles ${width} ${theme}`, async ({ page, designScenario }) => {
    await page.setViewportSize({ width, height: viewportHeights[width] });
    if (width === 320 && theme === "dark") {
      await page.emulateMedia({ reducedMotion: "reduce" });
      expect(await page.evaluate(() => matchMedia("(prefers-reduced-motion: reduce)").matches)).toBe(true);
    }
    await designScenario({ principal: "admin", state: "ready", theme });
    await installControlLists(page);
    await page.goto("/control?siteId=site-1&mode=manual");
    await expect(page.locator("html")).toHaveAttribute("data-customer-theme", theme);
    await expect(page.locator("[data-control-panel]")).toBeVisible();
    if (width >= 760) {
      await expectRole(page.locator("[data-control-screen]"), "gap", "20px");
      await expectRole(page.locator("[data-control-panel]"), "padding", "20px");
      await expectRole(page.locator("[data-control-panel]"), "gap", "20px");
      await expectRole(page.locator("[data-manual-selection-panel]"), "padding", "20px");
      await expectRole(page.getByRole("heading", { name: "제어 대상", exact: true }), "font-size", "16px");
    } else {
      await expectRole(page.locator("[data-control-panel]"), "padding", "0px");
      await expectRole(page.locator("[data-control-screen]"), "gap", "4px");
    }
    for (const [mode, empty] of [["schedule", "등록된 스케줄이 없습니다."], ["event", "등록된 이벤트 규칙이 없습니다."], ["group", "저장된 구역이 없습니다."]] as const) {
      await page.goto(`/control?siteId=site-1&mode=${mode}`);
      await expect(page.getByText(empty, { exact: true })).toBeVisible();
      await expectRole(page.locator("[data-control-screen]"), "gap", "20px");
      const panel = mode === "group" ? page.getByRole("tabpanel").locator(":scope > section") : page.locator("[data-automation-list-surface]");
      await expectRole(panel, "padding", width < 760 ? "16px" : "20px");
      if (mode !== "group") await expectRole(page.locator(`[data-control-automation-panel="${mode}"]`), "gap", "20px");
      else {
        await expectRole(panel, "gap", "20px");
        await expectRole(page.getByRole("heading", { name: "현재 저장 구역", exact: true }), "font-size", "16px");
      }
      await expect(page.getByRole("heading", { level: 1 })).toHaveCount(1);
    }
    await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
    await expect(page.getByTestId("floor-editor-canvas")).toHaveAttribute("data-map-ready", "true");
    const information = page.locator("#editor-information-panel");
    if (width < 1120) await page.getByRole("button", { name: "편집 정보 패널", exact: true }).click();
    const workspace = page.getByTestId("floor-editor-layout");
    await expect(workspace).toHaveCSS("contain", "size");
    expect((await workspace.boundingBox())!.height).toBeGreaterThanOrEqual(256);
    const informationWidth = (await information.boundingBox())!.width;
    if (width >= 1120) expect(informationWidth).toBe(280);
    else expect(informationWidth).toBeLessThanOrEqual(320);
    await expectRole(information, "padding", "0px");
    for (const [tab, region] of [["속성", "속성 패널"], ["배치", "일괄 배치"], ["레이어", "레이어 패널"], ["기록", "맵 버전"]] as const) {
      await information.getByRole("tab", { name: tab, exact: true }).click();
      const content = information.locator(`[aria-label="${region}"]`);
      await expectRole(content, "padding", width < 760 ? "16px" : "20px");
      await expectRole(content.getByRole("heading").first(), "font-size", "16px");
    }
  });
}

for (const width of [320, 1440] as const) for (const mode of ["schedule", "event", "group"] as const) {
  for (const state of ["pending", "error"] as const) test(`control ${mode} ${state} keeps ordinary roles ${width}`, async ({ page, designScenario }) => {
    await page.setViewportSize({ width, height: viewportHeights[width] });
    await designScenario({ principal: "admin", state: "ready", theme: "light" });
    let release: (() => void) | undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    await installControlLists(page);
    const path = mode === "group" ? "fixture-groups" : `automation/${mode === "schedule" ? "schedules" : "vehicle-event-rules"}`;
    let failures = 0;
    // These lists preserve React Query's three retries. Observe the final
    // response for this exact resource before using the unchanged 5s matcher.
    const finalFailure = state === "error" ? page.waitForResponse(response => new URL(response.url()).pathname === `/api/sites/site-1/${path}` && response.status() === 403 && ++failures === 4) : undefined;
    await page.route(`**/api/sites/site-1/${path}*`, async route => {
      if (state === "pending") await pending;
      await route.fulfill({ status: 403, json: { message: "fixture denied" } }).catch(() => {});
    });
    try {
      await page.goto(`/control?siteId=site-1&mode=${mode}`);
      if (state === "pending") await expect(page.getByText(mode === "schedule" ? "스케줄을 불러오는 중입니다." : mode === "event" ? "이벤트 규칙을 불러오는 중입니다." : "구역을 불러오는 중입니다.", { exact: true })).toBeVisible();
      else {
        await finalFailure;
        await expect(page.getByRole("alert").first()).toBeVisible();
      }
      await expectRole(page.locator("[data-control-screen]"), "gap", "20px");
      await expectRole(mode === "group" ? page.getByRole("tabpanel").locator(":scope > section") : page.locator("[data-automation-list-surface]"), "padding", width < 760 ? "16px" : "20px");
    } finally { release?.(); }
  });
}

async function installControlLists(page: Page) {
  await page.route("**/api/sites/site-1/fixture-groups*", route => route.fulfill({ json: [] }));
  await page.route("**/api/sites/site-1/automation/schedules?*", route => route.fulfill({ json: { items: [], total: 0, nextCursor: null } }));
  await page.route("**/api/sites/site-1/automation/vehicle-event-rules?*", route => route.fulfill({ json: { items: [], total: 0, nextCursor: null } }));
  await page.route("**/api/sites/site-1/temporary-controls?*", route => route.fulfill({ json: { items: [], nextCursor: null } }));
}

for (const width of [320, 760] as const) test(`control and users populated customer cards share grid and inset ${width}`, async ({ page, designScenario }) => {
  await page.setViewportSize({ width, height: width === 320 ? 600 : 768 });
  await designScenario({ principal: "admin", state: "ready", theme: "dark" });
  await installControlLists(page);
  await page.route("**/api/sites/site-1/fixture-groups*", route => route.fulfill({ json: [1, 2].map(index => ({ id: `group-${index}`, name: `입구 구역 ${index}`, floorId: "floor-1", gatewayId: "gateway-1", lifecycleStatus: "active", fixtureCount: 1,
    meshControlGroup: { status: "ready", version: 1, error: null } })) }));
  const users = [1, 2].map(index => ({ id: `user-${index}`, name: `관제 사용자 ${index}`, loginId: `parking_control_user_${index}`, accessLevel: "control", status: "active", lastLoginAt: null, createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" }));
  await page.route("**/api/sites/site-1/users", route => route.fulfill({ json: { users, count: 2, limit: 100 } }));
  for (const [url, caption] of [["/control?siteId=site-1&mode=group", "저장 구역 목록"], ["/settings/users?siteId=site-1", "현장 사용자 목록"]] as const) {
    await page.goto(url);
    const list = page.getByRole("list", { name: caption, exact: true });
    await expect(list).toBeVisible();
    await expectRole(list, "gap", "18px");
    await expect(list.getByRole("listitem")).toHaveCount(2);
    for (const card of await list.getByRole("listitem").all()) await expectRole(card, "padding", width < 760 ? "16px" : "20px");
    await expectTextFits(list.getByRole("definition").first());
    if (caption === "현장 사용자 목록") {
      await page.getByRole("searchbox", { name: "사용자 검색", exact: true }).fill("user_2");
      await expect(list.getByRole("listitem")).toHaveCount(1);
      await expect(list).toContainText("parking_control_user_2");
      await page.getByRole("searchbox", { name: "사용자 검색", exact: true }).fill("");
      await expect(list.getByRole("listitem")).toHaveCount(2);
    }
  }
});

for (const width of [320, 1440] as const) test(`control editor route error retains ordinary inset ${width}`, async ({ page, designScenario }) => {
  await page.setViewportSize({ width, height: viewportHeights[width] });
  await designScenario({ principal: "admin", state: "ready", theme: "dark" });
  let failures = 0;
  const finalFailure = page.waitForResponse(response => new URL(response.url()).pathname === "/api/floors/floor-1/editor-state" && response.status() === 403 && ++failures === 4);
  await page.route("**/api/floors/floor-1/editor-state", route => route.fulfill({ status: 403, json: { message: "fixture editor denied" } }));
  await page.goto("/settings/floor-plans/floor-1/edit?siteId=site-1");
  await finalFailure;
  const message = page.getByText("맵 편집기를 불러오지 못했습니다.", { exact: true });
  await expect(message).toBeVisible();
  await expectRole(message.locator(".."), "padding", width < 760 ? "16px" : "20px");
  await expect(message).toHaveText("맵 편집기를 불러오지 못했습니다.");
  await expect(page.getByTestId("floor-editor-canvas")).toHaveCount(0);
});

for (const width of [320, 1440] as const) for (const state of ["pending", "error", "empty"] as const) {
  test(`control manual ${state} preserves ordinary shell and disabled apply ${width}`, async ({ page, designScenario }) => {
    await page.setViewportSize({ width, height: viewportHeights[width] });
    await designScenario({ principal: "admin", state: state === "empty" ? "empty" : "ready", theme: "dark" });
    await installControlLists(page);
    let release: (() => void) | undefined;
    const pending = new Promise<void>(resolve => { release = resolve; });
    let failures = 0;
    const finalFailure = state === "error" ? page.waitForResponse(response => new URL(response.url()).pathname === "/api/sites/site-1/dashboard" && new URL(response.url()).searchParams.get("includeFixtures") === "true" && response.status() === 403 && ++failures === 4) : undefined;
    if (state !== "empty") await page.route("**/api/sites/site-1/dashboard?includeFixtures=true", async route => {
      if (state === "pending") await pending;
      await route.fulfill({ status: 403, json: { message: "fixture control dashboard denied" } }).catch(() => {});
    });
    try {
      await page.goto("/control?siteId=site-1&mode=manual");
      if (state === "empty") {
        await expect(page.locator("[data-control-panel]")).toBeVisible();
        await expect(page.locator("[data-control-submit]")).toBeDisabled();
        await expectRole(page.locator("[data-control-panel]"), "padding", width < 760 ? "0px" : "20px");
      } else {
        if (state === "error") await finalFailure;
        await expect(page.getByText(state === "pending" ? "제어 대상을 불러오는 중입니다." : "제어 대상을 불러오지 못했습니다.", { exact: true })).toBeVisible();
        await expectRole(page.locator("[data-control-screen]"), "gap", "20px");
        await expect(page.locator("[data-control-submit]")).toHaveCount(0);
      }
    } finally { release?.(); }
  });
}

for (const width of [320, 1440] as const) test(`control populated lists retain actions and regular surface ${width}`, async ({ page, designScenario }) => {
  await page.setViewportSize({ width, height: viewportHeights[width] });
  await designScenario({ principal: "admin", state: "ready", theme: "dark" });
  await installControlLists(page);
  const common = { id: "rule-1", status: "disabled", action: { dimmingEnabled: true, brightnessPercent: 70 }, gatewayId: "gateway-1",
    targets: [{ fixtureId: "fixture-1" }], targetCount: 1, desiredRevision: 3, appliedRevision: 2, syncStatus: "PENDING", lastExecution: null,
    createdById: "admin-user-1", updatedById: "admin-user-1", createdAt: "2026-10-01T00:00:00.000Z", updatedAt: "2026-10-01T00:00:00.000Z" };
  await page.route("**/api/sites/site-1/automation/schedules?*", route => route.fulfill({ json: { items: [{ ...common, name: "야간 운영", activeFrom: "2026-10-01T03:00:00.000Z", activeUntil: "2026-10-30T03:00:00.000Z",
    localStartTime: "18:00", localEndTime: "23:00", recurrence: { kind: "daily", weeklyDays: [], monthlyDay: null, yearlyMonth: null, yearlyDay: null }, fixtureIds: ["fixture-1"], nextOccurrence: null }], total: 1, nextCursor: null } }));
  await page.route("**/api/sites/site-1/automation/vehicle-event-rules?*", route => route.fulfill({ json: { items: [{ ...common, name: "입구 차량 감지", sourceFixtureIds: ["fixture-1"], targetFixtureIds: ["fixture-1"], holdSeconds: 60,
    sources: [{ fixtureId: "fixture-1" }], sourceCount: 1, sensorProtocol: "bio-usb-pulse", lastDetection: null }], total: 1, nextCursor: null } }));
  await page.route("**/api/sites/site-1/fixture-groups*", route => route.fulfill({ json: [{ id: "group-1", name: "입구 구역", floorId: "floor-1", gatewayId: "gateway-1", lifecycleStatus: "active", fixtureCount: 1,
    meshControlGroup: { status: "ready", version: 1, error: null } }] }));
  for (const [mode, name] of [["schedule", "야간 운영"], ["event", "입구 차량 감지"], ["group", "입구 구역"]] as const) {
    await page.goto(`/control?siteId=site-1&mode=${mode}`);
    await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
    await expectRole(mode === "group" ? page.getByRole("tabpanel").locator(":scope > section") : page.locator("[data-automation-list-surface]"), "padding", width < 760 ? "16px" : "20px");
    if (mode === "group") {
      await page.getByRole("button", { name: "새 구역", exact: true }).click();
      await expect(page.getByRole("button", { name: "취소", exact: true })).toBeVisible();
      await page.getByRole("button", { name: "취소", exact: true }).click();
      await expect(page.getByText(name, { exact: true }).first()).toBeVisible();
    } else {
      const add = page.getByRole("button", { name: mode === "schedule" ? "스케줄 추가" : "이벤트 추가", exact: true });
      await add.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toHaveCSS("padding", width < 760 ? "16px" : "20px");
      await expectRole(dialog.locator("form"), "gap", "20px");
      const cards = dialog.locator("form > fieldset, form > section");
      await test.info().attach(`control-${mode}-ordinary-cards`, { body: JSON.stringify(await cards.evaluateAll(elements => elements.map(element => ({ tag: element.tagName, label: element.getAttribute("aria-labelledby"), classes: element.className, padding: getComputedStyle(element).padding }))), null, 2), contentType: "application/json" });
      for (let index = 0; index < await cards.count(); index++) await expectRole(cards.nth(index), "padding", width < 760 ? "16px" : "20px");
      await page.keyboard.press("Escape");
      await expect(add).toBeFocused();
      if (mode === "schedule") {
        await page.route("**/api/sites/site-1/automation/schedules/calendar?*", route => route.fulfill({ status: 503, json: { message: "fixture calendar unavailable" } }));
        await page.getByRole("button", { name: "달력", exact: true }).click();
        await expect(page.getByRole("button", { name: "달력 다시 조회", exact: true })).toBeVisible();
        await expectRole(page.locator("[data-schedule-calendar]"), "padding", width < 760 ? "16px" : "20px");
      }
    }
  }
});

async function expectTextFits(locator: Locator) {
  await locator.scrollIntoViewIfNeeded();
  expect(await locator.evaluate(element => {
    const range = document.createRange(); range.selectNodeContents(element);
    const box = element.getBoundingClientRect();
    return [...range.getClientRects()].every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1);
  }), "text Range remains inside its reader").toBe(true);
}

async function installSiteRoles(page: Page) {
  let site = { id: "site-1", name: "본사 주차장", address: "서울시 중구 세종대로 1", timeZone: "Asia/Seoul", currency: "KRW", tariffKwhRate: 158.75, updatedAt: "2026-09-12T00:00:00.000Z" };
  const floors = [{ id: "floor-1", name: "B2", level: -2, displayOrder: 1, status: "active", fixtureCount: 0, activeGroupCount: 0, updatedAt: "2026-09-12T00:00:00.000Z" }];
  await page.route("**/api/sites/site-1/settings", async route => {
    if (route.request().method() === "PATCH") {
      const { expectedUpdatedAt, ...changes } = route.request().postDataJSON();
      expect(expectedUpdatedAt).toBe(site.updatedAt);
      site = { ...site, ...changes, updatedAt: "2026-09-12T00:01:00.000Z" };
      return route.fulfill({ json: site });
    }
    await route.fulfill({ json: { site, floors } });
  });
  await page.route("**/api/sites/site-1/floors", async route => {
    expect(route.request().method()).toBe("POST");
    const created = { ...floors[0], ...route.request().postDataJSON(), id: "floor-new" }; floors.push(created);
    await route.fulfill({ status: 201, json: created });
  });
  await page.route("**/api/sites/site-1/floors/*/fixtures/settings*", route => route.fulfill({ json: { items: [], nextCursor: null } }));
  await page.route("**/api/sites/site-1/fixture-groups*", route => route.fulfill({ json: [] }));
  await page.route("**/api/sites/site-1/bio-sensor-policy", route => route.fulfill({ json: { siteId: "site-1", enabled: false, ownerUserId: null, maximumResponseSeconds: null, escalationAction: null, revision: 0 } }));
}
