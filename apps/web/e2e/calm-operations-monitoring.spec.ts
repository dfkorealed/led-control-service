import { expect, test, type Page } from "@playwright/test";
import { expectMinimumTouchTargets, expectMinimumTouchTargetsAfterScrolling, expectNoHorizontalOverflow } from "./support/layout-assertions";
import { installSettingsApiRoutes, type SettingsFixture } from "./support/settings-api";
import type { RegistrationSession } from "../src/api/registration";

const ids = {
  site: "22222222-2222-4222-8222-222222222222",
  floor: "44444444-4444-4444-8444-444444444444",
  gateway: "77777777-7777-4777-8777-777777777771"
} as const;

const fixtures: SettingsFixture[] = [
  fixture("B2-L001-매우-긴-테스트-조명-이름", "online", "reported", 120, 140),
  {
    ...fixture("B2-L002", "fault", "reported", 280, 220),
    gateway: {
      id: ids.gateway,
      name: "G".repeat(240),
      connectionStatus: "online"
    }
  },
  fixture("B2-L003", "offline", "reported", 440, 300),
  fixture("B2-L004", "offline", "provisioning_waiting_state", 600, 380)
];

const viewports = [
  { width: 1440, height: 900, columns: 4, rows: 1 },
  { width: 1024, height: 768, columns: 2, rows: 2 },
  { width: 390, height: 844, columns: 2, rows: 2 },
  { width: 320, height: 740, columns: 1, rows: 4 }
] as const;

function fixture(
  name: string,
  status: SettingsFixture["status"],
  statusReason: "reported" | "provisioning_waiting_state",
  x: number,
  y: number
): SettingsFixture {
  return {
    id: `33333333-3333-4333-8333-${String(x).padStart(12, "0")}`,
    name,
    x,
    y,
    size: 20,
    ratedWatt: 40,
    brightness: status === "fault" ? 42 : 70,
    status,
    statusReason,
    health: status === "fault" ? { faultCodes: [4], observedAt: "2026-07-12T00:00:00.000Z" } : null,
    rssi: -60,
    hopCount: 2,
    commandSuccessRate: 0.99,
    lastSeenAt: "2026-07-12T00:00:00.000Z",
    gateway: { id: ids.gateway, name: "Gateway B2", connectionStatus: "online" },
    controllable: status === "online",
    controlBlockReason: status === "fault" ? "fixture_fault" : status === "offline" ? "fixture_offline" : null
  };
}

async function installMonitoringFixture(page: Page) {
  return installSettingsApiRoutes(page, "admin", {
    fixtures,
    ids: { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway }
  });
}

for (const viewport of viewports) {
  test(`${viewport.width}px 모니터링은 KPI와 지도/상세 반응형 계약을 지킨다`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installMonitoringFixture(page);
    await page.goto(`/monitoring?siteId=${ids.site}`);

    await expect(page.getByRole("heading", { name: "운영 현황" })).toBeVisible();
    await expect(page.getByRole("region", { name: "빠른 상태" })).toContainText("점검 필요");
    await expect(page.getByRole("region", { name: "층 도면" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "선택 조명 상세" })).toContainText("현재 밝기");
    await expectMetricGrid(page, viewport.columns, viewport.rows);
    await expectNoHorizontalOverflow(page);

    if (viewport.width > 1120) {
      await expectDesktopMonitoringUsesInternalScroll(page);
    }

    const mapBox = await page.locator(".map-panel").boundingBox();
    const detailBox = await page.locator(".detail-panel").boundingBox();
    expect(mapBox).not.toBeNull();
    expect(detailBox).not.toBeNull();
    if (viewport.width > 1120) {
      expect(Math.abs((mapBox?.y ?? 0) - (detailBox?.y ?? 0))).toBeLessThan(2);
    } else {
      expect((detailBox?.y ?? 0)).toBeGreaterThan((mapBox?.y ?? 0) + (mapBox?.height ?? 0));
    }

    if (viewport.width <= 760) {
      await page.getByRole("region", { name: "빠른 상태" }).scrollIntoViewIfNeeded();
      await expectMinimumTouchTargets(page, ".monitoring-quick-status");
      await expectMinimumTouchTargetsAfterScrolling(page, ".monitoring-fixture-selector");
    }
  });
}

test("모니터링 예외 상태는 등록과 지도 실패를 정상 화면과 분리한다", async ({ browser, baseURL }) => {
  const emptyPage = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 } });
  try {
    await installSettingsApiRoutes(emptyPage, "admin", {
      fixtures: [],
      ids: { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway }
    });
    await emptyPage.goto(`/monitoring?siteId=${ids.site}`);
    await expect(emptyPage.getByRole("heading", { name: "등록된 조명이 없습니다" })).toBeVisible();
    await expect(emptyPage.getByRole("heading", { name: "조명 등록" })).toBeVisible();
  } finally {
    await emptyPage.close();
  }

  const mapFailurePage = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 } });
  try {
    await installSettingsApiRoutes(mapFailurePage, "viewer", {
      fixtures,
      mapSnapshotFailuresBeforeSuccess: 10,
      ids: { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway }
    });
    await mapFailurePage.goto(`/monitoring?siteId=${ids.site}`);
    await expect(mapFailurePage.getByText("저장된 지도를 불러오지 못했습니다.")).toBeVisible({ timeout: 10_000 });
    await expect(mapFailurePage.getByRole("region", { name: "빠른 상태" })).toBeVisible();
    await expect(mapFailurePage.getByRole("complementary", { name: "선택 조명 상세" })).toContainText("현재 밝기");
  } finally {
    await mapFailurePage.close();
  }

  const viewerPendingPage = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 } });
  try {
    await installSettingsApiRoutes(viewerPendingPage, "viewer", {
      fixtures: [],
      installationStatus: "pending",
      ids: { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway }
    });
    await viewerPendingPage.goto(`/monitoring?siteId=${ids.site}`);
    await expect(viewerPendingPage.getByRole("region", { name: "Viewer 설치 대기" })).toBeVisible();
    await expect(viewerPendingPage.getByRole("heading", { name: "설치 담당자가 현장을 준비 중입니다" })).toBeVisible();
    await expect(viewerPendingPage.getByRole("button", { name: "조명 검색 시작" })).toHaveCount(0);
    await expect(viewerPendingPage.getByRole("heading", { name: "조명 등록" })).toHaveCount(0);
    await expect(viewerPendingPage.getByRole("heading", { name: "게이트웨이 등록" })).toHaveCount(0);
  } finally {
    await viewerPendingPage.close();
  }
});

test("등록된 조명이 있는 관리자는 요청할 때만 진행 중 조명 등록 UI를 연다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installSettingsApiRoutes(page, "admin", {
    fixtures,
    ids: { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway },
    activeRegistrationSessions: [activeRegistrationSession]
  });
  await page.goto(`/monitoring?siteId=${ids.site}`);

  await expect(page.getByRole("heading", { name: "조명 등록" })).toHaveCount(0);
  const trigger = page.getByRole("button", { name: "조명 등록" });
  await trigger.click();

  const dialog = page.getByRole("dialog", { name: "조명 등록" });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "조명 등록", level: 2 })).toBeVisible();
  await expect(dialog.getByText(activeRegistrationSession.id.slice(0, 8), { exact: true })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await trigger.click();
  await expect(dialog.getByText(activeRegistrationSession.id.slice(0, 8), { exact: true })).toBeVisible();
});

for (const width of [390, 320]) {
  test(`${width}px 조명 등록 dialog는 내부 가로 스크롤 없이 동작한다`, async ({ page }) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 740 });
    await installMonitoringFixture(page);
    await page.goto(`/monitoring?siteId=${ids.site}`);

    await page.getByRole("button", { name: "조명 등록" }).click();
    const dialog = page.getByRole("dialog", { name: "조명 등록" });
    await expect(dialog).toBeVisible();

    const overflow = await dialog.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth,
      contentClientWidth: element.querySelector<HTMLElement>(".registration-dialog-content")?.clientWidth ?? 0,
      contentScrollWidth: element.querySelector<HTMLElement>(".registration-dialog-content")?.scrollWidth ?? 0
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
    expect(overflow.contentScrollWidth).toBeLessThanOrEqual(overflow.contentClientWidth + 1);
    await expectMinimumTouchTargets(page, ".registration-dialog-header");
  });
}

for (const dimensions of [{ width: 2400, height: 600 }, { width: 600, height: 2400 }]) {
  test(`${dimensions.width}x${dimensions.height} 도면은 데스크톱 지도 영역 안에 비율을 유지해 맞춘다`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installSettingsApiRoutes(page, "viewer", {
      fixtures,
      mapDimensions: dimensions,
      ids: { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway }
    });
    await page.goto(`/monitoring?siteId=${ids.site}`);

    const panelBox = await page.locator(".map-panel").boundingBox();
    const mapBox = await page.locator(".floor-map").boundingBox();
    expect(panelBox).not.toBeNull();
    expect(mapBox).not.toBeNull();
    expect(mapBox?.width ?? Infinity).toBeLessThanOrEqual((panelBox?.width ?? 0) + 1);
    expect(mapBox?.height ?? Infinity).toBeLessThanOrEqual((panelBox?.height ?? 0) + 1);
    expect((mapBox?.width ?? 0) / (mapBox?.height ?? 1)).toBeCloseTo(dimensions.width / dimensions.height, 1);
  });
}

test("부분 지도 갱신 실패에도 이전 지도와 선택 상세를 유지한다", async ({ page }) => {
  const api = await installMonitoringFixture(page);
  await page.goto(`/monitoring?siteId=${ids.site}`);
  await expect(page.getByRole("region", { name: "층 도면" })).toBeVisible();

  api.failNextMapSnapshots(10);
  await page.getByRole("button", { name: "새로고침" }).click();

  await expect(page.getByText("저장된 지도를 유지하고 있습니다. 지도 갱신에 실패했습니다.")).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("region", { name: "층 도면" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "선택 조명 상세" })).toContainText("현재 밝기");
});

async function expectMetricGrid(page: Page, columns: number, rows: number) {
  const metrics = page.locator(".summary-row > [role='group']");
  await expect(metrics).toHaveCount(4);
  const boxes = await metrics.evaluateAll((elements) => elements.map((element) => {
    const box = element.getBoundingClientRect();
    return { x: Math.round(box.x), y: Math.round(box.y) };
  }));
  const uniqueColumns = new Set(boxes.map((box) => box.x));
  const uniqueRows = new Set(boxes.map((box) => box.y));
  expect(uniqueColumns.size).toBe(columns);
  expect(uniqueRows.size).toBe(rows);
}

async function expectDesktopMonitoringUsesInternalScroll(page: Page) {
  const metrics = await page.evaluate(() => {
    const detail = document.querySelector<HTMLElement>(".detail-panel");
    if (!detail) throw new Error("상세 패널을 찾을 수 없습니다.");
    return {
      documentClientHeight: document.documentElement.clientHeight,
      documentScrollHeight: document.documentElement.scrollHeight,
      detailClientHeight: detail.clientHeight,
      detailScrollHeight: detail.scrollHeight,
      detailOverflowY: getComputedStyle(detail).overflowY
    };
  });

  expect(metrics.documentScrollHeight).toBeLessThanOrEqual(metrics.documentClientHeight + 1);
  expect(metrics.detailOverflowY).toBe("auto");
  expect(metrics.detailScrollHeight).toBeGreaterThan(metrics.detailClientHeight);
}

const activeRegistrationSession: RegistrationSession = {
  id: "88888888-8888-4888-8888-888888888888",
  siteId: ids.site,
  floorId: ids.floor,
  gatewayId: ids.gateway,
  requestedBy: "99999999-9999-4999-8999-999999999999",
  status: "active",
  scanStatus: "completed",
  scanCorrelationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  scanAttempt: 1,
  scanStartedAt: "2026-09-10T00:00:00.000Z",
  scanCompletedAt: "2026-09-10T00:00:10.000Z",
  scanFailureCode: null,
  scanFailureMessage: null,
  startedAt: "2026-09-10T00:00:00.000Z",
  completedAt: null,
  discoveredNodes: []
};
