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
