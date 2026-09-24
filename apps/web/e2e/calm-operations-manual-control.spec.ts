import { expect, test, type Page } from "@playwright/test";
import type { FixtureGroupMetadata } from "@led-control/shared";
import type { CommandStatusResponse } from "../src/api/commands";
import { expectNoHorizontalOverflow } from "./support/layout-assertions";
import { installSettingsApiRoutes, type SettingsFixture } from "./support/settings-api";

test.use({ timezoneId: "Asia/Seoul" });

const ids = {
  site: "77777777-7777-4777-8777-777777777701",
  floor: "77777777-7777-4777-8777-777777777702",
  gateway: "77777777-7777-4777-8777-777777777703",
  fixture: "77777777-7777-4777-8777-777777777704",
  faultFixture: "77777777-7777-4777-8777-777777777705",
  offlineFixture: "77777777-7777-4777-8777-777777777706",
  group: "77777777-7777-4777-8777-777777777707"
};

const fixtures: SettingsFixture[] = [
  fixture(ids.fixture, "B2-L01", { brightness: 70, status: "online", health: { faultCodes: [], observedAt: "2026-09-02T00:00:00.000Z" }, controllable: true, controlBlockReason: null }),
  fixture(ids.faultFixture, "B2-L02", { brightness: 40, status: "fault", health: { faultCodes: [1], observedAt: "2026-09-02T00:00:00.000Z" }, controllable: false, controlBlockReason: "fixture_fault" }),
  fixture(ids.offlineFixture, "B2-L03", { brightness: 0, status: "offline", health: null, controllable: false, controlBlockReason: "fixture_offline" })
];

const savedZone: FixtureGroupMetadata = {
  id: ids.group,
  name: "B2 입구",
  floorId: ids.floor,
  gatewayId: ids.gateway,
  lifecycleStatus: "active",
  fixtureCount: 1,
  meshControlGroup: { status: "ready", version: 2, error: null }
};

const viewports = [
  { width: 1440, height: 900 },
  { width: 1366, height: 768 },
  { width: 390, height: 844 },
  { width: 320, height: 740 }
] as const;

for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
  test(`${viewport.width}px 명령 이력 상태 확인과 원래 대상 안전 재적용`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const api = await installManualControlFixture(page, "admin");
    const commandId = "77777777-7777-4777-8777-777777777799";
    let checking = false;
    let verified = false;
    const checkRequests: Array<{ clientRequestId: string }> = [];
    const historyRequests: URL[] = [];
    const original: CommandStatusResponse = {
      id: commandId, siteId: ids.site, stage: "verification_required", outcome: "unknown", targetType: "floor", targetId: ids.floor,
      targetFixtureIds: [ids.fixture], brightness: 30, verificationAttemptCount: 0, dispatchCount: 1,
      totalFixtureCount: 1, completedFixtureCount: 1, createdAt: "2026-09-12T01:00:00.000Z", errorMessage: "STATUS_TIMEOUT",
      dispatches: [{ id: "original-dispatch", kind: "dimming", status: "timed_out", gateway: { id: ids.gateway, name: "GW" }, errorMessage: null, results: [commandResult("timed_out", null)] }]
    };
    await page.route("**/api/commands**", async (route) => {
      const url = new URL(route.request().url());
      if (url.pathname === "/api/commands") {
        historyRequests.push(url);
        return route.fulfill({ json: { items: Array.from({ length: url.searchParams.has("cursor") ? 4 : 20 }, (_, index) => ({ ...original, id: index === 0 && !url.searchParams.has("cursor") ? commandId : `77777777-7777-4777-8777-${String((url.searchParams.has("cursor") ? 50 : 10) + index).padStart(12, "0")}` })), nextCursor: url.searchParams.has("cursor") ? null : "next-page" } });
      }
      if (url.pathname === `/api/commands/${commandId}/status-checks`) {
        checkRequests.push(route.request().postDataJSON());
        if (checkRequests.length === 1) return route.abort("failed");
        checking = true;
        return route.fulfill({ json: { dispatchId: "check-dispatch", dispatchIds: ["check-dispatch"], verificationAttempt: 1, terminalStatusUrl: `/commands/${commandId}` } });
      }
      if (url.pathname === `/api/commands/${commandId}`) return route.fulfill({ json: {
        ...original, stage: verified ? "verified_not_applied" : "verification_required", outcome: verified ? "not_applied" : "unknown",
        verificationAttemptCount: checking ? 1 : 0,
        dispatches: checking ? [...original.dispatches, { id: "check-dispatch", kind: "status_check", verificationAttempt: 1, status: verified ? "completed" : "accepted", gateway: { id: ids.gateway, name: "GW" }, errorMessage: null, results: [{ ...commandResult("succeeded", null), brightness: 70 }] }] : original.dispatches
      } });
      return route.fallback();
    });
    await page.goto(`/control?siteId=${ids.site}`);
    if (viewport.width > 1120) {
      const target = page.getByRole("heading", { name: "01 / 제어 대상" });
      const brightness = page.getByRole("heading", { name: "02 / 밝기 실행" });
      const result = page.getByRole("heading", { name: "03 / 최근 결과" });
      const executionPanel = page.getByRole("complementary", { name: "밝기 실행" });
      await expect(target).toBeVisible();
      await expect(brightness).toBeVisible();
      await expect(result).toBeVisible();
      await expect(executionPanel.getByRole("button", { name: "밝기 적용" })).toHaveCount(1);
    }
    const history = page.getByRole("region", { name: "최근 명령 이력" });
    if (viewport.width <= 1120) {
      const openHistory = history.getByRole("button", { name: "명령 이력 열기" });
      await expect(openHistory).toHaveAttribute("aria-expanded", "false");
      await openHistory.click();
      await expect(history.getByRole("button", { name: "명령 이력 접기" })).toHaveAttribute("aria-expanded", "true");
      await expect(history.getByRole("searchbox", { name: "명령 이력 검색" })).toBeVisible();
    }
    if (viewport.width > 1120) {
      for (const historyViewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }, { width: 1121, height: 900 }]) {
        await page.setViewportSize(historyViewport);
        const historyListHeight = await history.locator("[data-command-history-list]").evaluate((list) => list.clientHeight);
        expect(historyListHeight).toBeGreaterThanOrEqual(44);
        await history.getByRole("button", { name: new RegExp(commandId) }).click();
        await expect(page.getByRole("button", { name: "명령 상세 닫기" })).toBeVisible();
        await page.getByRole("button", { name: "명령 상세 닫기" }).click();
      }
      await page.setViewportSize(viewport);
    }
    await page.getByRole("searchbox", { name: "명령 이력 검색" }).fill("B2");
    await expect.poll(() => historyRequests.at(-1)?.searchParams.get("query")).toBe("B2");
    await page.getByRole("button", { name: "명령 상태 필터" }).click();
    await page.getByRole("option", { name: "실제 상태 확인 필요" }).click();
    await expect.poll(() => historyRequests.at(-1)?.searchParams.get("stage")).toBe("verification_required");
    await history.getByRole("button", { name: "더 보기" }).click();
    await expect.poll(() => historyRequests.at(-1)?.searchParams.get("cursor")).toBe("next-page");
    await history.getByRole("button", { name: new RegExp(commandId) }).click();
    const execution = await openManualExecution(page);
    await expect(execution.getByRole("button", { name: "안전하게 다시 적용" })).toHaveCount(0);
    await execution.getByRole("button", { name: "명령 상세 닫기" }).click();
    await expect(execution.getByRole("button", { name: "명령 상세 닫기" })).toHaveCount(0);
    await history.getByRole("button", { name: new RegExp(commandId) }).click();
    await page.getByRole("button", { name: "실제 상태 확인", exact: true }).click();
    await page.getByRole("button", { name: "동일 상태 확인 요청 조회" }).click();
    await expect(page.getByRole("button", { name: "실제 상태 확인 중" })).toBeDisabled();
    await expect(page.getByRole("slider", { name: "밝기" })).toBeDisabled();
    expect(checkRequests[1]).toEqual(checkRequests[0]);
    expect(api.dimmingRequests).toHaveLength(0);
    verified = true;
    await expect(page.getByRole("button", { name: "안전하게 다시 적용" })).toBeEnabled();
    await page.getByRole("button", { name: "100%", exact: true }).click();
    await page.getByRole("button", { name: "안전하게 다시 적용" }).click();
    await expect.poll(() => api.dimmingRequests.at(-1)).toMatchObject({ brightness: 30, target: { type: "fixtures", fixtureIds: [ids.fixture] } });
    await expectNoHorizontalOverflow(page);
    if (viewport.width > 1120) {
      const dimensions = await page.evaluate(() => {
        const list = document.querySelector<HTMLElement>("[data-command-history-list]")!;
        return { overflow: getComputedStyle(list).overflowY, listHeight: list.clientHeight, contentHeight: list.scrollHeight, documentHeight: document.documentElement.scrollHeight, viewportHeight: window.innerHeight };
      });
      expect(dimensions.overflow).toBe("auto");
      expect(dimensions.listHeight).toBeLessThan(dimensions.contentHeight);
      expect(dimensions.documentHeight).toBeLessThanOrEqual(dimensions.viewportHeight);
    }
  });
}

for (const viewport of viewports) {
  test(`${viewport.width}px 수동 제어는 대상·명령 결과·저장 구역 계약을 유지한다`, async ({ page }) => {
    await page.clock.install({ time: new Date("2026-09-01T00:00:00.000Z") });
    await page.setViewportSize(viewport);
    const api = await installManualControlFixture(page, "admin");
    await page.goto(`/control?siteId=${ids.site}`);
    await expect(page.getByRole("heading", { name: "조명 밝기 제어", exact: true })).toBeVisible();
    const execution = await openManualExecution(page);
    await page.getByRole("button", { name: "조명 목록 열기" }).click();
    const fixtureDrawer = page.getByRole("dialog", { name: "조명 목록" });
    const faultFixtureCheckbox = fixtureDrawer.getByRole("checkbox", { name: "B2-L02 선택" });
    await expect(faultFixtureCheckbox).toBeDisabled();
    await expect(faultFixtureCheckbox).not.toBeChecked();
    await expect(fixtureDrawer.getByRole("checkbox", { name: "B2-L03 선택" })).toBeDisabled();
    await fixtureDrawer.getByRole("button", { name: "선택 완료", exact: true }).click();
    await expect(page.getByRole("button", { name: "밝기 적용" })).toBeDisabled();
    await setCheckbox(page, "B2-L01 선택", true);
    await page.getByRole("button", { name: "30%" }).click();
    await expect(page.getByLabel("수동 override 종료 시각")).toHaveCount(0);
    await page.getByRole("button", { name: "밝기 적용" }).click();
    await expect.poll(() => api.dimmingRequests.at(-1)).toMatchObject({
      brightness: 30
    });
    expect(api.dimmingRequests.at(-1)).not.toHaveProperty("overrideUntil");
    expect(api.dimmingRequests.at(-1)).not.toHaveProperty("overrideRemainingMs");
    await expect(execution.getByRole("list", { name: "명령 진행" })).toContainText("장비 응답");
    await expect(page.getByRole("button", { name: "조명 목록 열기" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "층 전체" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "30%" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "밝기 적용 중" })).toBeDisabled();

    await page.reload();
    const restoredExecution = await openManualExecution(page);
    await expect(restoredExecution.getByRole("list", { name: "명령 진행" })).toBeVisible();
    api.setCommandStatus({ stage: "partial_failed", results: [commandResult("failed", "게이트웨이 ACK를 확인하지 못했습니다.")] });
    await expect(restoredExecution.getByText("게이트웨이 장비 응답을 확인하지 못했습니다.")).toBeVisible();
    await expect(page.getByText(/ACK/i)).toHaveCount(0);
    await page.getByRole("button", { name: "조명 목록 열기" }).click();
    const restoredFixtureDrawer = page.getByRole("dialog", { name: "조명 목록" });
    await expect(restoredFixtureDrawer.getByRole("checkbox", { name: "B2-L01 선택" })).toBeEnabled();
    await setCheckbox(page, "B2-L01 선택", true);
    await restoredFixtureDrawer.getByRole("button", { name: "선택 완료", exact: true }).click();
    await expect(page.getByRole("button", { name: "밝기 적용" })).toBeEnabled();

    await expectNoHorizontalOverflow(page);

    await page.getByRole("button", { name: "구역 관리" }).click();
    const dialog = page.getByRole("dialog", { name: "구역 관리" });
    await expect(dialog.getByRole("heading", { name: "현재 저장 구역" })).toBeVisible();
    await expect(dialog.getByText("준비됨")).toBeVisible();
    await page.getByRole("button", { name: "B2 입구 수정" }).click();
    const editDialog = page.getByRole("dialog", { name: "구역 수정" });
    await expect(editDialog.getByTestId("fixture-group-map-editor")).toBeVisible();
    await editDialog.getByRole("button", { name: "목록으로" }).click();
    const groupDialog = page.getByRole("dialog", { name: "구역 관리" });
    await groupDialog.getByRole("button", { name: "새 구역" }).click();
    const createDialog = page.getByRole("dialog", { name: "구역 생성" });
    await selectBox(page, createDialog, "층", "B2");
    await selectBox(page, createDialog, "게이트웨이", "Gateway B2");
    await createDialog.getByRole("button", { name: "조명 목록 열기" }).click();
    const groupFixtureDrawer = page.getByRole("dialog", { name: "조명 목록" });
    const groupFixture = groupFixtureDrawer.getByRole("checkbox", { name: "B2-L01 선택" });
    await expect(groupFixture).not.toBeChecked();
    await groupFixture.locator("xpath=ancestor::label").getByText("B2-L01", { exact: true }).click();
    await expect(groupFixture).toBeChecked();
    await groupFixtureDrawer.getByRole("button", { name: "선택 완료", exact: true }).click();

  });

  test(`${viewport.width}px Mesh 준비 전 floor와 저장 구역은 제어 대상으로 차단한다`, async ({ page }) => {
    await page.setViewportSize(viewport);
    // Keep fixture health eligible so these choices are blocked by Mesh
    // readiness itself, rather than an unrelated faulty/offline fixture.
    const api = await installManualControlFixture(page, "admin", "blocked", [fixtures[0]]);
    await page.goto(`/control?siteId=${ids.site}`);
    const execution = await openManualExecution(page);

    await page.getByRole("button", { name: "층 전체" }).click();
    const floors = page.getByRole("group", { name: "층 목록" });
    await expect(floors.getByRole("button", { name: "B2", exact: true })).toBeDisabled();
    await expect(floors.getByRole("button", { name: "B2", exact: true })).toHaveAccessibleDescription("게이트웨이 0/1 준비 · Mesh 설정 중");
    await expect(floors.getByRole("alert")).toHaveCount(0);
    await expect(execution.getByRole("button", { name: /밝기 적용/ })).toBeDisabled();
    await page.getByRole("button", { name: "저장된 구역" }).click();
    await page.getByRole("alertdialog", { name: "선택 방식 변경" }).getByRole("button", { name: "변경", exact: true }).click();
    const groups = page.getByRole("group", { name: "저장된 구역 목록" });
    await expect(groups.getByRole("button", { name: "B2 입구" })).toBeDisabled();
    await expect(groups.getByRole("button", { name: "B2 입구" })).toHaveAccessibleDescription("게이트웨이 장비 응답을 확인하지 못했습니다.");
    await expect(groups.getByRole("alert")).toHaveCount(0);
    await expect(page.getByText(/ACK/i)).toHaveCount(0);
    await expect(execution.getByRole("button", { name: "밝기 적용" })).toBeDisabled();
    expect(api.dimmingRequests).toHaveLength(0);
  });

  test(`${viewport.width}px read-only viewer는 수동 제어 route에 접근할 수 없다`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const api = await installManualControlFixture(page, "viewer");
    await page.goto(`/control?siteId=${ids.site}`);

    await expect(page).toHaveURL(new RegExp(`/monitoring\\?siteId=${ids.site}$`));
    await expect(page.getByRole("heading", { name: "조명 밝기 제어", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "밝기 적용" })).toHaveCount(0);
    expect(api.dimmingRequests).toHaveLength(0);
    await expectNoHorizontalOverflow(page);
  });

  test(`${viewport.width}px 수동 명령은 success와 timeout terminal을 복구한다`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const successApi = await installManualControlFixture(page, "admin");
    await page.goto(`/control?siteId=${ids.site}`);
    const execution = await openManualExecution(page);
    await setCheckbox(page, "B2-L01 선택", true);
    await page.getByRole("button", { name: "밝기 적용" }).click();
    successApi.setCommandStatus({ stage: "completed", results: [commandResult("succeeded", null)] });
    await expect(execution.getByRole("status", { name: "명령 진행 상태" }).getByText("조명 적용 완료 · 기본 밝기로 저장됨")).toBeVisible();

    const timeoutPage = await page.context().newPage({ viewport });
    try {
      const timeoutApi = await installManualControlFixture(timeoutPage, "admin");
      await timeoutPage.goto(`/control?siteId=${ids.site}`);
      const timeoutExecution = await openManualExecution(timeoutPage);
      await setCheckbox(timeoutPage, "B2-L01 선택", true);
      await timeoutPage.getByRole("button", { name: "밝기 적용" }).click();
      timeoutApi.setCommandStatus({ stage: "timed_out", results: [commandResult("timed_out", "Gateway ACK timeout")] });
      await expect(timeoutExecution.getByText("게이트웨이 장비 응답 시간 초과")).toBeVisible();
      await expect(timeoutPage.getByText("Gateway ACK timeout", { exact: true })).toHaveCount(0);
      await expect(timeoutPage.getByRole("button", { name: "밝기 적용" })).toBeEnabled();
    } finally {
      await timeoutPage.close();
    }
  });
}

for (const viewport of [{ width: 1440, height: 900 }, { width: 1121, height: 900 }, { width: 1366, height: 768 }]) {
  test(`${viewport.width}px PC 수동 제어 카드는 선택 피드백이 추가되어도 핵심 UI를 고정한다`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const fixtureData = fixtures.map((item) => item.id === ids.faultFixture
      ? { ...item, name: "B2-L02 출입구 비상 대피 유도 조명 장치", status: "online" as const, health: { faultCodes: [], observedAt: "2026-09-02T00:00:00.000Z" }, controllable: true, controlBlockReason: null }
      : item);
    const api = await installManualControlFixture(page, "admin", "ready", fixtureData);
    await page.goto(`/control?siteId=${ids.site}`);

    await setCheckbox(page, "B2-L01 선택", true);
    const before = await readStableControlRects(page);

    await setCheckbox(page, "B2-L01 선택", false);
    await setCheckbox(page, "B2-L02 출입구 비상 대피 유도 조명 장치 선택", true);
    // Map-first selection rejects an already faulty fixture. Select it while
    // healthy, then let normal dashboard polling report the real-world fault.
    fixtureData[1] = { ...fixtures[1], name: fixtureData[1].name };
    const execution = await openManualExecution(page);
    await expect(execution.getByText("제어 불가", { exact: true })).toBeVisible();
    await expect(execution.getByRole("alert")).toHaveText("선택한 조명 중 제어할 수 없는 대상이 있습니다.");
    await expect(execution.getByRole("heading", { name: "B2-L02 출입구 비상 대피 유도 조명 장치" })).toBeVisible();
    await expect(execution.getByRole("button", { name: "1개 조명에 밝기 적용" })).toBeDisabled();
    expect(api.dimmingRequests).toHaveLength(0);

    const after = await readStableControlRects(page);
    for (const key of Object.keys(before.controls) as Array<keyof typeof before.controls>) {
      expect(Math.abs(after.controls[key].top - before.controls[key].top), `${key} top`).toBeLessThanOrEqual(1);
      expect(Math.abs(after.controls[key].left - before.controls[key].left), `${key} left`).toBeLessThanOrEqual(1);
      expect(Math.abs(after.controls[key].width - before.controls[key].width), `${key} width`).toBeLessThanOrEqual(1);
    }
    expect(after.panel.scrollHeight).toBeLessThanOrEqual(after.panel.clientHeight + 1);
    expect(after.body.overflowY).toBe("auto");
    expect(after.body.bottom).toBeLessThanOrEqual(after.feedback.top);
    expect(after.badge.left).toBeGreaterThanOrEqual(after.panel.left);
    expect(after.badge.right).toBeLessThanOrEqual(after.panel.right);
    expect(after.badge.top).toBeGreaterThanOrEqual(after.panel.top);
    expect(after.badge.bottom).toBeLessThanOrEqual(after.panel.bottom);
    expect(after.feedback.left).toBeGreaterThanOrEqual(after.panel.left);
    expect(after.feedback.right).toBeLessThanOrEqual(after.panel.right);
    expect(after.feedback.bottom).toBeLessThanOrEqual(after.panel.bottom);
    expect(after.feedback.top).toBeGreaterThanOrEqual(after.panel.top);
    expect(after.document.scrollHeight).toBeLessThanOrEqual(after.document.clientHeight + 1);
    await expectNoHorizontalOverflow(page);
  });
}

async function openManualExecution(page: Page) {
  if (page.viewportSize()!.width > 1120) return page.getByRole("complementary", { name: "밝기 실행" });

  // Compact execution and command feedback are mounted only while this public
  // disclosure is expanded; a full reload intentionally resets it to closed.
  const summary = page.getByRole("complementary", { name: "선택 대상 요약" });
  const expand = summary.getByRole("button", { name: "선택 대상 펼치기" });
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(summary.getByRole("slider", { name: "밝기" })).toHaveCount(0);
  await expand.click();
  await expect(summary.getByRole("button", { name: "선택 대상 접기" })).toHaveAttribute("aria-expanded", "true");
  await expect(summary.getByRole("slider", { name: "밝기" })).toBeVisible();
  await expect(summary.getByRole("button", { name: /밝기 적용/ })).toBeVisible();
  // The live region is empty before a command exists; each workflow below
  // asserts visibility of its actual progress or terminal content.
  await expect(summary.getByRole("status", { name: "명령 진행 상태" })).toHaveCount(1);
  return summary;
}

async function readStableControlRects(page: Page) {
  return page.evaluate(() => {
    const panel = document.querySelector<HTMLElement>("[data-control-panel]");
    const badge = panel?.querySelector<HTMLElement>("[data-tone]");
    const body = panel?.querySelector<HTMLElement>("[data-control-panel-body]");
    const feedback = panel?.querySelector<HTMLElement>("[role='alert']") ?? panel?.querySelector<HTMLElement>("[data-command-status-region]");
    const selectors = {
      dial: "[data-control-brightness-card]",
      presets: "[data-control-presets]",
      submit: "[data-control-submit]"
    } as const;
    if (!panel || !badge || !body || !feedback) throw new Error("manual control layout is incomplete");

    const rect = (element: Element) => {
      const box = element.getBoundingClientRect();
      return { top: box.top, right: box.right, bottom: box.bottom, left: box.left, width: box.width };
    };
    const controls = Object.fromEntries(Object.entries(selectors).map(([key, selector]) => {
      const element = panel.querySelector(selector);
      if (!element) throw new Error(`manual control element not found: ${selector}`);
      return [key, rect(element)];
    })) as Record<keyof typeof selectors, ReturnType<typeof rect>>;
    const panelRect = rect(panel);

    return {
      controls,
      panel: { ...panelRect, clientHeight: panel.clientHeight, scrollHeight: panel.scrollHeight },
      body: { ...rect(body), overflowY: getComputedStyle(body).overflowY },
      badge: rect(badge),
      feedback: rect(feedback),
      document: {
        clientHeight: document.documentElement.clientHeight,
        scrollHeight: document.documentElement.scrollHeight
      }
    };
  });
}

async function setCheckbox(page: Page, name: string, checked: boolean) {
  const initialCheckbox = page.getByRole("checkbox", { name });
  const needsDrawer = await initialCheckbox.count() === 0;
  if (needsDrawer) await page.getByRole("button", { name: "조명 목록 열기" }).click();
  const drawer = page.getByRole("dialog", { name: "조명 목록" });
  const checkbox = needsDrawer ? drawer.getByRole("checkbox", { name }) : initialCheckbox;
  if (await checkbox.isChecked() !== checked) {
    const visibleName = name.replace(/ 선택$/, "");
    await checkbox.locator("xpath=ancestor::label").getByText(visibleName, { exact: true }).click();
  }
  await expect(checkbox).toBeChecked({ checked });
  if (needsDrawer) await drawer.getByRole("button", { name: "선택 완료", exact: true }).click();
}

async function selectBox(page: Page, root: ReturnType<Page["getByRole"]>, label: string, option: string) {
  await root.getByRole("button", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option }).click();
}

function fixture(
  id: string,
  name: string,
  state: Pick<SettingsFixture, "brightness" | "status" | "health" | "controllable" | "controlBlockReason">
): SettingsFixture {
  return {
    id,
    name,
    x: 120,
    y: 140,
    ratedWatt: 40,
    rssi: -58,
    hopCount: 1,
    commandSuccessRate: 1,
    lastSeenAt: "2026-09-02T00:00:00.000Z",
    gateway: { id: ids.gateway, name: "Gateway B2", connectionStatus: "online" },
    ...state
  };
}

function commandResult(status: "succeeded" | "failed" | "timed_out", errorMessage: string | null) {
  return { fixtureId: ids.fixture, fixtureName: "B2-L01", status, errorMessage };
}

async function installManualControlFixture(
  page: Page,
  role: "admin" | "viewer",
  meshState: "ready" | "blocked" = "ready",
  fixtureData: SettingsFixture[] = fixtures
) {
  const api = await installSettingsApiRoutes(page, role, {
    ids: { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway },
    fixtures: fixtureData
  });
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.pathname === "/api/commands" && request.method() === "GET") {
      return route.fulfill({ json: { items: [], nextCursor: null } });
    }
    if (url.pathname === `/api/sites/${ids.site}/fixture-groups` && request.method() === "GET") {
      return route.fulfill({ json: [savedZone] });
    }
    if (url.pathname === `/api/sites/${ids.site}/dashboard`) {
      return route.fulfill({ json: dashboardResponse(meshState, fixtureData, role) });
    }
    return route.fallback();
  });
  return api;
}

function dashboardResponse(
  meshState: "ready" | "blocked" = "ready",
  fixtureData: SettingsFixture[] = fixtures,
  role: "admin" | "viewer" = "admin"
) {
  const floorMeshControlGroup = meshState === "blocked"
    ? { gatewayId: ids.gateway, status: "configuring", version: 1, error: null }
    : { gatewayId: ids.gateway, status: "ready", version: 1, error: null };
  const groupMeshControlGroup = meshState === "blocked"
    ? { status: "failed", version: 2, error: "Gateway ACK를 확인하지 못했습니다." }
    : savedZone.meshControlGroup;
  return {
    capabilities: role === "admin"
      ? { read: true, control: true, manage: true, commission: true }
      : { read: true, control: false, manage: false, commission: false },
    site: {
      id: ids.site,
      name: "고객사 B2 현장",
      customerName: "고객사",
      installationStatus: "installed",
      address: "서울시 강남구",
      tariffKwhRate: 160,
      timeZone: "Asia/Seoul"
    },
    summary: { totalFixtures: fixtures.length, onlineFixtures: 1, faultFixtures: 1, averageBrightness: 37 },
    floors: [{
      id: ids.floor,
      name: "B2",
      level: -2,
      floorPlan: null,
      meshControlGroups: [floorMeshControlGroup],
      fixtures: fixtureData
    }],
    groups: [{ ...savedZone, meshControlGroup: groupMeshControlGroup, fixtureIds: [ids.fixture] }],
    gateways: [{
      id: ids.gateway,
      name: "Gateway B2",
      serialNumber: "GW-E2E-001",
      firmwareVersion: "e2e-1.0.0",
      lastHeartbeatAt: "2026-09-02T00:00:00.000Z",
      connectionStatus: "online"
    }]
  };
}
