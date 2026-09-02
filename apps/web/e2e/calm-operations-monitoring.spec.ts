import { expect, test, type Page } from "@playwright/test";
import { expectMinimumTouchTargets, expectMinimumTouchTargetsAfterScrolling, expectNoHorizontalOverflow } from "./support/layout-assertions";
import { installSettingsApiRoutes, type SettingsFixture } from "./support/settings-api";

const ids = {
  site: "22222222-2222-4222-8222-222222222222",
  floor: "44444444-4444-4444-8444-444444444444",
  gateway: "77777777-7777-4777-8777-777777777771"
} as const;

const fixtures: SettingsFixture[] = [
  fixture("B2-L001", "online", "reported", 120, 140),
  fixture("B2-L002", "fault", "reported", 280, 220),
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
    controlBlockReason: null
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
});

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
