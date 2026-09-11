import { expect, test, type Page } from "@playwright/test";
import { expectMinimumTouchTargetsAfterScrolling, expectNoHorizontalOverflow } from "./support/layout-assertions";
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
  fixture("B2-L004", "offline", "provisioning_waiting_state", 600, 380),
  fixture("B2-밝기-0", "online", "reported", 760, 140, 0),
  fixture("B2-밝기-50", "online", "reported", 820, 220, 50),
  fixture("B2-밝기-100", "online", "reported", 880, 300, 100)
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
  y: number,
  brightness = status === "fault" ? 42 : 70
): SettingsFixture {
  return {
    id: `33333333-3333-4333-8333-${String(x).padStart(12, "0")}`,
    name,
    x,
    y,
    size: 20,
    ratedWatt: 40,
    brightness,
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

    await expect(page.getByRole("heading", { name: "운영 현황" })).toHaveCount(0);
    await expect(page.getByText(/10분마다 자동 갱신/)).toHaveCount(0);
    const mapSelector = page.getByRole("combobox", { name: "맵 선택" });
    await expect(mapSelector).toBeVisible();
    await expect(page.getByRole("group", { name: "오프라인" })).toContainText("2");
    await expect(page.getByRole("group", { name: "오프라인" })).toContainText("상태 확인 대기 포함");
    await expect(page.getByRole("group", { name: "평균 밝기" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "빠른 상태" })).toHaveCount(0);
    await expect(page.getByRole("region", { name: "층 도면" })).toBeVisible();
    await expect(page.locator(".floor-map-label")).toHaveCount(0);
    const mapSelectorLabel = page.locator(".monitoring-floor-selector");
    const selectorLayout = await mapSelectorLabel.evaluate((label) => {
      const labelText = label.querySelector("span")?.getBoundingClientRect();
      const select = label.querySelector("select")?.getBoundingClientRect();
      return {
        display: getComputedStyle(label).display,
        labelCenterY: labelText ? labelText.y + labelText.height / 2 : -1,
        selectCenterY: select ? select.y + select.height / 2 : -2
      };
    });
    expect(selectorLayout.display).toBe("flex");
    expect(Math.abs(selectorLayout.labelCenterY - selectorLayout.selectCenterY)).toBeLessThan(2);
    const toolbar = await page.locator(".monitoring-toolbar").boundingBox();
    const refresh = await page.getByRole("button", { name: "새로고침" }).boundingBox();
    expect(toolbar).not.toBeNull();
    expect(refresh).not.toBeNull();
    expect(Math.abs((toolbar?.x ?? 0) + (toolbar?.width ?? 0) - ((refresh?.x ?? 0) + (refresh?.width ?? 0)))).toBeLessThan(2);
    await expect(page.getByRole("complementary", { name: "선택 조명 상세" })).toContainText("현재 밝기");
    await expect(page.getByRole("complementary", { name: "선택 조명 상세" }).getByRole("heading", { name: "점검 큐" })).toHaveCount(0);
    await expectMetricGrid(page, viewport.columns, viewport.rows);
    await expectNoHorizontalOverflow(page);

    const mapOverlayLayout = await page.locator(".monitoring-map-shell").evaluate((shell) => {
      const legend = shell.querySelector(".floor-map-legend")?.getBoundingClientRect();
      const panHintElement = shell.querySelector<HTMLElement>(".monitoring-map-pan-hint");
      const panHint = panHintElement?.getBoundingClientRect();
      const zoomControls = shell.querySelector(".monitoring-map-zoom-controls")?.getBoundingClientRect();
      const legendElement = shell.querySelector<HTMLElement>(".floor-map-legend");
      if (!legend || !legendElement || !panHint || !panHintElement || !zoomControls) {
        throw new Error("지도 범례 또는 이동·확대 안내를 찾을 수 없습니다.");
      }
      return {
        legendBottom: legend.bottom,
        panHintTop: panHint.top,
        panHintDisplay: getComputedStyle(panHintElement).display,
        legendPointerEvents: getComputedStyle(legendElement).pointerEvents,
        zoomControlsTop: zoomControls.top
      };
    });
    expect(mapOverlayLayout.legendPointerEvents).toBe("none");
    if (viewport.width > 760) {
      expect(mapOverlayLayout.panHintDisplay).not.toBe("none");
      expect(mapOverlayLayout.legendBottom).toBeLessThanOrEqual(mapOverlayLayout.panHintTop - 4);
    } else {
      expect(mapOverlayLayout.panHintDisplay).toBe("none");
      expect(mapOverlayLayout.legendBottom).toBeLessThanOrEqual(mapOverlayLayout.zoomControlsTop - 4);
    }

    const statusBadge = await page.locator(".fixture-dot:not(.active)").first().evaluate((element) => {
      const style = getComputedStyle(element, "::after");
      return { top: style.top, right: style.right, width: style.width, height: style.height, borderWidth: style.borderTopWidth };
    });
    expect(statusBadge).toEqual({ top: "-5px", right: "-5px", width: "8px", height: "8px", borderWidth: "2px" });
    const markerSizes = await page.locator(".fixture-dot").evaluateAll((markers) => markers.map((marker) => {
      const bounds = marker.getBoundingClientRect();
      return { width: bounds.width, height: bounds.height };
    }));
    expect(markerSizes.every(({ width, height }) => width === 20 && height === 20)).toBe(true);

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
      await page.getByRole("region", { name: "층 도면" }).scrollIntoViewIfNeeded();
      await expectMinimumTouchTargetsAfterScrolling(page, ".monitoring-map-zoom-controls");
      await expectMinimumTouchTargetsAfterScrolling(page, ".monitoring-fixture-selector");
    }
  });
}

test("데스크톱 지도는 내부에서 확대·스크롤되고 상세 정보는 패널 폭 안에 유지된다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installMonitoringFixture(page);
  await page.goto(`/monitoring?siteId=${ids.site}`);

  const map = page.getByRole("region", { name: "층 도면" });
  const mapViewport = page.getByTestId("monitoring-map-viewport");
  await expect(map.getByRole("button", { name: "지도 배율 100%" })).toBeVisible();
  const pageScaleBefore = await page.evaluate(() => window.visualViewport?.scale ?? 1);
  const modifiedWheel = await mapViewport.evaluate((element) => {
    const event = new WheelEvent("wheel", {
      bubbles: true,
      cancelable: true,
      ctrlKey: true,
      deltaY: -120,
      clientX: element.getBoundingClientRect().left + element.clientWidth / 2,
      clientY: element.getBoundingClientRect().top + element.clientHeight / 2
    });
    return { canceled: !element.dispatchEvent(event), defaultPrevented: event.defaultPrevented };
  });
  expect(modifiedWheel).toEqual({ canceled: true, defaultPrevented: true });
  await expect(map.getByRole("button", { name: "지도 배율 110%" })).toBeVisible();
  expect(await page.evaluate(() => window.visualViewport?.scale ?? 1)).toBe(pageScaleBefore);
  await map.getByRole("button", { name: "지도 화면 맞춤" }).click();

  for (let index = 0; index < 5; index += 1) await map.getByRole("button", { name: "지도 확대" }).click();
  await expect(map.getByRole("button", { name: "지도 배율 150%" })).toBeVisible();

  const mapOverflow = await mapViewport.evaluate((element) => ({
    clientWidth: element.clientWidth,
    clientHeight: element.clientHeight,
    scrollWidth: element.scrollWidth,
    scrollHeight: element.scrollHeight,
    overflowX: getComputedStyle(element).overflowX,
    overflowY: getComputedStyle(element).overflowY
  }));
  expect(mapOverflow.overflowX).toBe("auto");
  expect(mapOverflow.overflowY).toBe("auto");
  expect(
    mapOverflow.scrollWidth > mapOverflow.clientWidth || mapOverflow.scrollHeight > mapOverflow.clientHeight
  ).toBe(true);

  const centeredScroll = await mapViewport.evaluate((element) => {
    element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2;
    element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
    return { left: element.scrollLeft, top: element.scrollTop };
  });
  const viewportBox = await mapViewport.boundingBox();
  if (!viewportBox) throw new Error("monitoring map viewport has no layout box");
  await page.mouse.move(viewportBox.x + viewportBox.width / 2 + 120, viewportBox.y + viewportBox.height / 2 + 60);
  await page.mouse.down();
  await page.mouse.move(viewportBox.x + viewportBox.width / 2 + 20, viewportBox.y + viewportBox.height / 2 - 20, { steps: 5 });
  await page.mouse.up();
  const draggedScroll = await mapViewport.evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop }));
  expect(draggedScroll.left).toBeGreaterThan(centeredScroll.left + 70);
  expect(draggedScroll.top).toBeGreaterThan(centeredScroll.top + 50);

  await page.getByRole("button", { name: "B2-L001-매우-긴-테스트-조명-이름 정상 70%" }).click();
  await expect(page.getByRole("complementary", { name: "선택 조명 상세" })).toContainText("B2-L001-매우-긴-테스트-조명-이름");

  const panelOverflow = await page.getByRole("complementary", { name: "선택 조명 상세" }).evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    overflowX: getComputedStyle(element).overflowX,
    overflowY: getComputedStyle(element).overflowY
  }));
  expect(panelOverflow.overflowX).toBe("hidden");
  expect(panelOverflow.overflowY).toBe("auto");
  expect(panelOverflow.scrollWidth).toBeLessThanOrEqual(panelOverflow.clientWidth + 1);
  await expectNoHorizontalOverflow(page);
});

test("조명 마커는 고정 20px로 유지되고 online 밝기만 단조적으로 밝아진다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installMonitoringFixture(page);
  await page.goto(`/monitoring?siteId=${ids.site}`);

  const marker = (name: string) => page.getByRole("button", { name });
  const active = marker("B2-L002 장애 42%");
  const off = marker("B2-밝기-0 정상 0%");
  const medium = marker("B2-밝기-50 정상 50%");
  const full = marker("B2-밝기-100 정상 100%");

  await expect(active).toHaveJSProperty("childElementCount", 0);
  await expect(active).toHaveCSS("width", "20px");
  await expect(active).toHaveCSS("height", "20px");
  await medium.hover();
  await expect(medium).toHaveCSS("width", "20px");
  await expect(medium).toHaveCSS("height", "20px");
  await full.focus();
  await expect(full).toHaveCSS("width", "20px");
  await expect(full).toHaveCSS("height", "20px");

  await page.locator(".fixture-dot").evaluateAll(async (markers) => {
    await Promise.all(markers.flatMap((marker) => marker.getAnimations().map((animation) => animation.finished)));
  });
  const lightLevels = await Promise.all([off, medium, full].map((fixtureMarker) => fixtureMarker.evaluate((element) => {
    const style = getComputedStyle(element);
    const colorChannels = style.backgroundColor.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    const outerGlow = style.boxShadow.match(/^rgba?\([^)]*?,\s*([\d.]+)\)\s+0px\s+0px\s+([\d.]+)px\s+([\d.]+)px/);
    if (!colorChannels || colorChannels.length !== 3 || !outerGlow) {
      throw new Error(`조명 마커의 실제 밝기 스타일을 해석할 수 없습니다: ${style.backgroundColor} / ${style.boxShadow}`);
    }
    return {
      lightness: Number.parseFloat(style.getPropertyValue("--fixture-lightness")),
      glowAlpha: Number.parseFloat(style.getPropertyValue("--fixture-glow-alpha")),
      glowRadius: Number.parseFloat(style.getPropertyValue("--fixture-glow-radius")),
      renderedLuminance: colorChannels[0] * 0.2126 + colorChannels[1] * 0.7152 + colorChannels[2] * 0.0722,
      renderedGlowAlpha: Number(outerGlow[1]),
      renderedGlowBlur: Number(outerGlow[2]),
      renderedGlowSpread: Number(outerGlow[3])
    };
  })));
  expect(lightLevels.map(({ lightness, glowAlpha, glowRadius }) => ({ lightness, glowAlpha, glowRadius }))).toEqual([
    { lightness: 18, glowAlpha: 0, glowRadius: 0 },
    { lightness: 50, glowAlpha: 0.24, glowRadius: 7 },
    { lightness: 82, glowAlpha: 0.48, glowRadius: 14 }
  ]);
  for (const property of ["renderedLuminance", "renderedGlowAlpha", "renderedGlowBlur", "renderedGlowSpread"] as const) {
    expect(lightLevels[1][property], `${property}: 50% > 0%`).toBeGreaterThan(lightLevels[0][property]);
    expect(lightLevels[2][property], `${property}: 100% > 50%`).toBeGreaterThan(lightLevels[1][property]);
  }

  const [offlineVisual, waitingVisual, faultVisual] = await Promise.all([
    marker("B2-L003 오프라인 70%"),
    marker("B2-L004 상태 확인 대기 70%"),
    marker("B2-L002 장애 42%")
  ].map((fixtureMarker) => fixtureMarker.evaluate((element) => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, boxShadow: style.boxShadow, borderStyle: style.borderStyle };
  })));
  expect(offlineVisual.boxShadow).toBe("none");
  expect(waitingVisual.boxShadow).toBe("none");
  expect(offlineVisual.background).not.toBe(faultVisual.background);
  expect(waitingVisual.background).not.toBe(faultVisual.background);
  expect(faultVisual.borderStyle).toBe("double");
  expect(faultVisual.boxShadow).not.toBe("none");
});

test("모니터링 예외 상태는 등록과 지도 실패를 정상 화면과 분리한다", async ({ browser, baseURL }) => {
  const emptyPage = await browser.newPage({ baseURL, viewport: { width: 390, height: 844 } });
  try {
    await installSettingsApiRoutes(emptyPage, "admin", {
      fixtures: [],
      ids: { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway }
    });
    await emptyPage.goto(`/monitoring?siteId=${ids.site}`);
    await expect(emptyPage.getByRole("heading", { name: "등록된 조명이 없습니다" })).toBeVisible();
    await expect(emptyPage.getByRole("button", { name: /조명 등록/ })).toHaveCount(0);
    await expect(emptyPage.getByRole("link", { name: "설정 페이지로 이동" })).toHaveAttribute(
      "href",
      `/settings/registration?siteId=${ids.site}`
    );
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
    await expect(mapFailurePage.getByRole("region", { name: "빠른 상태" })).toHaveCount(0);
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

test("등록된 조명이 있는 관리자도 모니터링에서 등록 UI를 열 수 없다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installSettingsApiRoutes(page, "admin", {
    fixtures,
    ids: { siteId: ids.site, floorId: ids.floor, gatewayId: ids.gateway },
    activeRegistrationSessions: [activeRegistrationSession]
  });
  await page.goto(`/monitoring?siteId=${ids.site}`);

  await expect(page.getByRole("heading", { name: "조명 등록" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "조명 등록" })).toHaveCount(0);
  await expect(page.getByRole("dialog", { name: "조명 등록" })).toHaveCount(0);
});

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
