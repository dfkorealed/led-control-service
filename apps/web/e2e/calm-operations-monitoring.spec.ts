import { expect, test, type Page } from "@playwright/test";
import { expectMinimumTouchTargetsAfterScrolling, expectNoHorizontalOverflow } from "./support/layout-assertions";
import { installSettingsApiRoutes, type SettingsFixture } from "./support/settings-api";
import type { RegistrationSession } from "../src/api/registration";
import type { IncidentAction, MonitoringIncident, MonitoringPolicy } from "../src/api/monitoring-incidents";

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
  ...Array.from({ length: 10 }, (_, index) => fixture(
    `B2-밝기-단계-${index + 1}`,
    "online",
    "reported",
    70 + index * 95,
    520 + (index % 2) * 80,
    index * 10
  )),
  fixture("B2-밝기-단계-1-경계", "online", "reported", 1030, 520, 9)
];
const viewports = [
  { width: 1440, height: 900, columns: 4, rows: 1 },
  { width: 1024, height: 768, columns: 2, rows: 2 },
  { width: 390, height: 844, columns: 2, rows: 2 },
  { width: 320, height: 740, columns: 1, rows: 4 }
] as const;

const monitoringSnapshotAt = "2026-09-12T00:00:00.000Z";
const staleFixtureId = "33333333-3333-4333-8333-000000000440";
const reliabilityFixtures = fixtures.map((item) => item.id === staleFixtureId ? {
  ...item,
  status: "offline" as const,
  statusReason: "fixture_stale" as const,
  lastSeenAt: "2026-09-11T23:55:00.000Z"
} : item);

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

async function installMonitoringFixture(
  page: Page,
  { snapshotGeneratedAt, fixtureRows = fixtures }: { snapshotGeneratedAt?: string; fixtureRows?: SettingsFixture[] } = {}
) {
  return installSettingsApiRoutes(page, "admin", {
    fixtures: fixtureRows,
    snapshotGeneratedAt,
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

  await mapViewport.evaluate((element) => {
    element.scrollLeft = (element.scrollWidth - element.clientWidth) / 2;
    element.scrollTop = (element.scrollHeight - element.clientHeight) / 2;
    return { left: element.scrollLeft, top: element.scrollTop };
  });
  const viewportBox = await mapViewport.boundingBox();
  if (!viewportBox) throw new Error("monitoring map viewport has no layout box");
  const dragStart = { x: viewportBox.x + viewportBox.width / 2 + 120, y: viewportBox.y + viewportBox.height / 2 + 60 };
  const dragEnd = { x: viewportBox.x + viewportBox.width / 2 + 20, y: viewportBox.y + viewportBox.height / 2 - 20 };
  await page.mouse.move(dragStart.x, dragStart.y);
  const dragOrigin = await mapViewport.evaluate((element) => ({ left: element.scrollLeft, top: element.scrollTop }));
  await page.mouse.down();
  await page.mouse.move(dragEnd.x, dragEnd.y, { steps: 5 });
  await page.mouse.up();
  const draggedScroll = await mapViewport.evaluate((element) => ({
    left: element.scrollLeft,
    top: element.scrollTop,
    maxLeft: element.scrollWidth - element.clientWidth,
    maxTop: element.scrollHeight - element.clientHeight
  }));
  expect(draggedScroll.left).toBeCloseTo(
    Math.min(dragOrigin.left + dragStart.x - dragEnd.x, draggedScroll.maxLeft),
    0
  );
  expect(draggedScroll.top).toBeCloseTo(
    Math.min(dragOrigin.top + dragStart.y - dragEnd.y, draggedScroll.maxTop),
    0
  );
  expect(draggedScroll.left).toBeLessThanOrEqual(draggedScroll.maxLeft);
  expect(draggedScroll.top).toBeLessThanOrEqual(draggedScroll.maxTop);

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

test("조명 마커는 3px 네모와 고정 20px를 유지하고 online 밝기를 10단계로 표시한다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installMonitoringFixture(page);
  await page.goto(`/monitoring?siteId=${ids.site}`);

  const marker = (name: string) => page.getByRole("button", { name });
  const active = marker("B2-L002 장애 42%");
  const levels = Array.from({ length: 10 }, (_, index) => marker(`B2-밝기-단계-${index + 1} 정상 ${index * 10}%`));

  await expect(active).toHaveJSProperty("childElementCount", 0);
  await expect(active).toHaveCSS("width", "20px");
  await expect(active).toHaveCSS("height", "20px");
  await expect(active).toHaveCSS("border-radius", "3px");
  await levels[4].hover();
  await expect(levels[4]).toHaveCSS("width", "20px");
  await expect(levels[4]).toHaveCSS("height", "20px");
  await expect(levels[4]).toHaveCSS("border-radius", "3px");
  await levels[9].focus();
  await expect(levels[9]).toHaveCSS("width", "20px");
  await expect(levels[9]).toHaveCSS("height", "20px");
  await expect(levels[9]).toHaveCSS("border-radius", "3px");

  await page.locator(".fixture-dot").evaluateAll(async (markers) => {
    await Promise.all(markers.flatMap((marker) => marker.getAnimations().map((animation) => animation.finished)));
  });
  const lightLevels = await Promise.all(levels.map((fixtureMarker) => fixtureMarker.evaluate((element) => {
    const style = getComputedStyle(element);
    const colorChannels = style.backgroundColor.match(/[\d.]+/g)?.slice(0, 3).map(Number);
    const outerGlow = style.boxShadow.match(/^rgba?\([^)]*?,\s*([\d.]+)\)\s+0px\s+0px\s+([\d.]+)px\s+([\d.]+)px/);
    if (!colorChannels || colorChannels.length !== 3 || !outerGlow) {
      throw new Error(`조명 마커의 실제 밝기 스타일을 해석할 수 없습니다: ${style.backgroundColor} / ${style.boxShadow}`);
    }
    return {
      level: element.getAttribute("data-brightness-level"),
      fill: style.backgroundColor,
      glow: style.boxShadow,
      renderedLuminance: colorChannels[0] * 0.2126 + colorChannels[1] * 0.7152 + colorChannels[2] * 0.0722,
      renderedGlowAlpha: Number(outerGlow[1]),
      renderedGlowBlur: Number(outerGlow[2]),
      renderedGlowSpread: Number(outerGlow[3])
    };
  })));
  expect(lightLevels.map(({ level }) => level)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);
  expect(lightLevels.map(({ fill }) => fill)).toEqual([
    "rgb(51, 65, 85)",
    "rgb(71, 85, 105)",
    "rgb(100, 116, 139)",
    "rgb(148, 163, 184)",
    "rgb(183, 192, 204)",
    "rgb(209, 216, 224)",
    "rgb(232, 229, 207)",
    "rgb(246, 235, 150)",
    "rgb(255, 245, 184)",
    "rgb(255, 253, 232)"
  ]);
  expect(new Set(lightLevels.map(({ fill }) => fill)).size).toBe(10);
  expect(new Set(lightLevels.map(({ glow }) => glow)).size).toBe(10);
  for (const property of ["renderedLuminance", "renderedGlowAlpha", "renderedGlowBlur", "renderedGlowSpread"] as const) {
    for (let index = 1; index < lightLevels.length; index += 1) {
      expect(lightLevels[index][property], `${property}: ${index + 1}단계 > ${index}단계`).toBeGreaterThan(lightLevels[index - 1][property]);
    }
  }

  const sameLevelBoundary = marker("B2-밝기-단계-1-경계 정상 9%");
  await expect(sameLevelBoundary).toHaveAttribute("data-brightness-level", "1");
  expect(await sameLevelBoundary.evaluate((element) => {
    const style = getComputedStyle(element);
    return { fill: style.backgroundColor, glow: style.boxShadow };
  })).toEqual({ fill: lightLevels[0].fill, glow: lightLevels[0].glow });

  const [offlineVisual, waitingVisual, faultVisual] = await Promise.all([
    marker("B2-L003 오프라인 70%"),
    marker("B2-L004 상태 확인 대기 70%"),
    marker("B2-L002 장애 42%")
  ].map((fixtureMarker) => fixtureMarker.evaluate((element) => {
    const style = getComputedStyle(element);
    const badgeStyle = getComputedStyle(element, "::after");
    return {
      background: style.backgroundColor,
      boxShadow: style.boxShadow,
      borderColor: style.borderColor,
      borderRadius: style.borderRadius,
      borderStyle: style.borderStyle,
      badgeBackground: badgeStyle.backgroundColor,
      badgeWidth: badgeStyle.width,
      badgeHeight: badgeStyle.height
    };
  })));
  expect(offlineVisual.boxShadow).toBe("none");
  expect(waitingVisual.boxShadow).toBe("none");
  expect(offlineVisual.borderRadius).toBe("3px");
  expect(waitingVisual.borderRadius).toBe("3px");
  expect(faultVisual.borderRadius).toBe("3px");
  expect(faultVisual.borderStyle).toBe("solid");
  expect(faultVisual.borderColor).toBe(await levels[4].evaluate((element) => getComputedStyle(element).borderColor));
  expect(faultVisual.background).toBe(lightLevels[4].fill);
  expect(faultVisual.boxShadow).toBe(lightLevels[4].glow);
  expect(faultVisual.badgeBackground).toBe("rgb(220, 38, 38)");
  expect({ width: faultVisual.badgeWidth, height: faultVisual.badgeHeight }).toEqual({ width: "8px", height: "8px" });
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

test("dashboard/map과 fixture의 부분 갱신 실패에도 cached 화면과 지도·조명 선택을 유지한다", async ({ page }) => {
  const api = await installMonitoringFixture(page, { fixtureRows: reliabilityFixtures });
  const failures = await installMonitoringRefreshFailures(page);
  await page.goto(`/monitoring?siteId=${ids.site}`);
  await expect(page.getByRole("region", { name: "층 도면" })).toBeVisible();

  await page.getByRole("button", { name: "B2-L003 상태 수신 지연 70%" }).click();
  await page.getByRole("button", { name: "지도 확대" }).click();
  await page.getByRole("button", { name: "지도 확대" }).click();
  await expect(page.getByRole("button", { name: "지도 배율 120%" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "선택 조명 상세" })).toContainText("조명의 마지막 상태 보고가 현장 freshness 기준을 지났습니다.");
  await expect(page.getByRole("complementary", { name: "선택 조명 상세" })).toContainText("조명 통신 상태 확인");

  failures.failNextDashboardRequests(3);
  api.failNextMapSnapshots(3);
  await page.getByRole("button", { name: "새로고침" }).click();

  await expect(page.getByText("일부 현황 데이터를 새로고침하지 못했습니다.")).toBeVisible();
  await expect(page.getByText("저장된 지도를 유지하고 있습니다. 지도 갱신에 실패했습니다.")).toBeVisible();
  expect(failures.failedDashboardRequests()).toBe(3);
  await expectMonitoringSelectionToRemain(page);

  await page.getByRole("button", { name: "지도 다시 시도" }).click();
  await expect(page.getByText("저장된 지도를 유지하고 있습니다. 지도 갱신에 실패했습니다.")).toHaveCount(0);
  failures.failNextFixtureRequests(3);
  await page.getByRole("button", { name: "새로고침" }).click();

  await expect(page.getByText("저장된 조명 상태를 유지하고 있습니다. 조명 상태 갱신에 실패했습니다.")).toBeVisible();
  expect(failures.failedFixtureRequests()).toBe(3);
  await expectMonitoringSelectionToRemain(page);
  await expectNoHorizontalOverflow(page);
});

test("서버 snapshot 시각이 60초를 초과하면 stale 경고를 표시한다", async ({ page }) => {
  await page.clock.install({ time: new Date("2026-09-12T00:00:00.000Z") });
  await installMonitoringFixture(page, { snapshotGeneratedAt: monitoringSnapshotAt });
  await page.goto(`/monitoring?siteId=${ids.site}`);

  await expect(page.getByText("마지막 갱신: 2026-09-12T00:00:00.000Z")).toBeVisible();
  await expect(page.getByText("서버 snapshot 시각을 확인할 수 없습니다.")).toHaveCount(0);
  await page.clock.fastForward(60_001);
  await expect(page.getByText("현황 갱신이 지연되고 있습니다.")).toBeVisible();
  await expect(page.getByText(/가장 오래된 선택 층 snapshot이 60초를 초과했습니다/)).toBeVisible();
});

test("관리자는 인시던트를 확인·담당·해결하고 현장 판정 기준을 저장한다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await installMonitoringFixture(page, { fixtureRows: reliabilityFixtures });
  const reliability = await installMonitoringReliabilityRoutes(page);
  await page.goto(`/monitoring?siteId=${ids.site}`);

  const incidentTab = page.getByRole("tab", { name: "인시던트 1" });
  await expect(incidentTab).toBeVisible();
  await incidentTab.click();
  await expect(page.getByRole("heading", { name: "인시던트 이력" })).toBeVisible();
  const incidentList = page.getByRole("list", { name: "인시던트 이력" });
  await expect(incidentList.getByText("조명 수신 지연", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "확인", exact: true }).click();
  await expect(incidentList.getByText("확인됨", { exact: true })).toBeVisible();

  const assignee = page.getByRole("combobox", { name: "담당자" });
  await expect(assignee).toBeEnabled();
  await assignee.selectOption("admin-user-1");
  await page.getByRole("button", { name: "담당 저장" }).click();
  await expect(incidentList.getByRole("definition").filter({ hasText: "고객 관리자 (admin_user)" })).toBeVisible();

  await page.getByRole("textbox", { name: "해결 메모" }).fill("현장 통신 복구 확인");
  await page.getByRole("button", { name: "해결", exact: true }).click();
  await expect(incidentList.getByText("해결됨", { exact: true })).toBeVisible();
  await expect(page.getByText("현장 통신 복구 확인", { exact: true })).toBeVisible();
  await expect(page.getByText("활성 인시던트 0건", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "판정 기준" }).click();
  const dialog = page.getByRole("dialog", { name: "판정 기준" });
  await expect(dialog).toBeVisible();
  await page.getByRole("spinbutton", { name: "게이트웨이 오프라인 기준 (초)" }).fill("120");
  await page.getByRole("spinbutton", { name: "조명 수신 지연 기준 (초)" }).fill("300");
  await dialog.getByRole("button", { name: "저장" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("판정 기준을 저장했습니다.")).toBeVisible();

  expect(reliability.incidentActions.map((action) => action.action)).toEqual(["acknowledge", "assign", "resolve"]);
  expect(reliability.incidentActions[1]).toMatchObject({ action: "assign", userId: "admin-user-1" });
  expect(reliability.incidentActions[2]).toMatchObject({ action: "resolve", note: "현장 통신 복구 확인" });
  expect(reliability.policyUpdates).toEqual([{
    gatewayOfflineAfterSeconds: 120,
    fixtureStaleAfterSeconds: 300,
    expectedUpdatedAt: "2026-09-12T00:00:00.000Z"
  }]);
});

for (const viewport of viewports) {
  test(`${viewport.width}px 인시던트·판정 기준 패널은 page/panel 경계를 벗어나지 않는다`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installMonitoringFixture(page, { fixtureRows: reliabilityFixtures });
    await installMonitoringReliabilityRoutes(page);
    await page.goto(`/monitoring?siteId=${ids.site}`);

    const incidentTab = page.getByRole("tab", { name: "인시던트 1" });
    await expect(incidentTab).toBeVisible();
    await incidentTab.click();
    await expect(page.getByRole("heading", { name: "인시던트 이력" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectElementFitsViewportAndOwnWidth(page, ".detail-panel");
    await expectElementFitsViewportAndOwnWidth(page, ".monitoring-incidents");

    await page.getByRole("button", { name: "판정 기준" }).click();
    await expect(page.getByRole("dialog", { name: "판정 기준" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectElementFitsViewportAndOwnWidth(page, ".monitoring-policy-dialog");
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

async function installMonitoringRefreshFailures(page: Page) {
  let dashboardFailuresRemaining = 0;
  let fixtureFailuresRemaining = 0;
  let failedDashboardRequestCount = 0;
  let failedFixtureRequestCount = 0;

  await page.route(`**/api/sites/${ids.site}/dashboard`, async (route) => {
    if (dashboardFailuresRemaining === 0) return route.fallback();
    dashboardFailuresRemaining -= 1;
    failedDashboardRequestCount += 1;
    return route.fulfill({ status: 503, json: { message: "dashboard unavailable" } });
  });
  await page.route(`**/api/sites/${ids.site}/floors/${ids.floor}/fixtures?**`, async (route) => {
    if (fixtureFailuresRemaining === 0) return route.fallback();
    fixtureFailuresRemaining -= 1;
    failedFixtureRequestCount += 1;
    return route.fulfill({ status: 503, json: { message: "fixtures unavailable" } });
  });

  return {
    failNextDashboardRequests(count: number) { dashboardFailuresRemaining = count; },
    failNextFixtureRequests(count: number) { fixtureFailuresRemaining = count; },
    failedDashboardRequests: () => failedDashboardRequestCount,
    failedFixtureRequests: () => failedFixtureRequestCount
  };
}

async function installMonitoringReliabilityRoutes(page: Page) {
  const currentAdmin = { id: "admin-user-1", name: "고객 관리자", loginId: "admin_user" };
  const incidentActions: Array<IncidentAction & { expectedUpdatedAt: string }> = [];
  const policyUpdates: Array<Omit<MonitoringPolicy, "id" | "updatedAt"> & { expectedUpdatedAt: string }> = [];
  let revision = 0;
  let incident: MonitoringIncident = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    siteId: ids.site,
    type: "fixture_stale",
    status: "open",
    target: { kind: "fixture", id: staleFixtureId, name: "B2-L003", floorId: ids.floor },
    openedAt: "2026-09-12T00:00:00.000Z",
    lastObservedAt: "2026-09-12T00:01:00.000Z",
    acknowledgedAt: null,
    resolvedAt: null,
    createdAt: "2026-09-12T00:00:00.000Z",
    updatedAt: "2026-09-12T00:00:00.000Z",
    acknowledgedBy: null,
    assignedTo: null,
    resolvedBy: null,
    resolutionKind: null,
    resolutionNote: null
  };
  let policy: MonitoringPolicy = {
    id: ids.site,
    gatewayOfflineAfterSeconds: 90,
    fixtureStaleAfterSeconds: 180,
    updatedAt: "2026-09-12T00:00:00.000Z"
  };

  await page.route(`**/api/sites/${ids.site}/monitoring-incidents**`, async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "PATCH") {
      const action = request.postDataJSON() as IncidentAction & { expectedUpdatedAt: string };
      incidentActions.push(action);
      const updatedAt = `2026-09-12T00:00:0${++revision}.000Z`;
      if (action.action === "acknowledge") {
        incident = { ...incident, status: "acknowledged", acknowledgedAt: updatedAt, acknowledgedBy: currentAdmin, updatedAt };
      } else if (action.action === "assign") {
        incident = { ...incident, assignedTo: action.userId ? currentAdmin : null, updatedAt };
      } else {
        incident = {
          ...incident,
          status: "resolved",
          resolvedAt: updatedAt,
          resolvedBy: currentAdmin,
          resolutionKind: "operator_confirmed",
          resolutionNote: action.note,
          updatedAt
        };
      }
      return route.fulfill({ json: incident });
    }

    const status = url.searchParams.get("status") ?? "all";
    const type = url.searchParams.get("type") ?? "all";
    const matches = (status === "all" || status === incident.status) && (type === "all" || type === incident.type);
    return route.fulfill({
      json: {
        incidents: matches ? [incident] : [],
        activeCount: incident.status === "resolved" ? 0 : 1,
        nextCursor: null
      }
    });
  });
  await page.route(`**/api/sites/${ids.site}/monitoring-policy`, async (route) => {
    if (route.request().method() === "PATCH") {
      const update = route.request().postDataJSON() as Omit<MonitoringPolicy, "id" | "updatedAt"> & { expectedUpdatedAt: string };
      policyUpdates.push(update);
      policy = {
        id: ids.site,
        gatewayOfflineAfterSeconds: update.gatewayOfflineAfterSeconds,
        fixtureStaleAfterSeconds: update.fixtureStaleAfterSeconds,
        updatedAt: "2026-09-12T00:10:00.000Z"
      };
    }
    return route.fulfill({ json: policy });
  });
  await page.route(`**/api/sites/${ids.site}/users`, (route) => route.fulfill({
    json: { users: [], count: 0, limit: 100 }
  }));

  return { incidentActions, policyUpdates };
}

async function expectMonitoringSelectionToRemain(page: Page) {
  await expect(page.getByRole("group", { name: "전체 조명" })).toContainText(String(reliabilityFixtures.length));
  await expect(page.getByRole("combobox", { name: "맵 선택" })).toHaveValue(ids.floor);
  await expect(page.locator(".monitoring-fixture-selector select")).toHaveValue(staleFixtureId);
  await expect(page.getByRole("button", { name: "B2-L003 상태 수신 지연 70%" })).toHaveClass(/active/);
  await expect(page.getByRole("button", { name: "지도 배율 120%" })).toBeVisible();
  await expect(page.getByRole("region", { name: "층 도면" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "선택 조명 상세" })).toContainText("상태 수신 지연");
}

async function expectElementFitsViewportAndOwnWidth(page: Page, selector: string) {
  const metrics = await page.locator(selector).evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    return {
      left: bounds.left,
      right: bounds.right,
      viewportWidth: window.innerWidth,
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth
    };
  });
  expect(metrics.left).toBeGreaterThanOrEqual(-1);
  expect(metrics.right).toBeLessThanOrEqual(metrics.viewportWidth + 1);
  expect(metrics.scrollWidth).toBeLessThanOrEqual(metrics.clientWidth + 1);
}

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
