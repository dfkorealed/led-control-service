import { expect, test, type Page } from "@playwright/test";
import {
  expectMinimumTouchTargets,
  expectNoHorizontalOverflow
} from "./support/layout-assertions";

const generatedAt = "2026-08-26T00:00:00.000Z";

test.beforeEach(async ({ page }) => {
  await page.route("**/auth/me", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify({
      user: {
        id: "user-1",
        organizationId: "organization-1",
        organizationType: "customer",
        loginId: "demo_admin",
        name: "Customer Admin",
        role: "admin",
        status: "active"
      }
    })
  }));
  await page.route("**/sites/default/dashboard**", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(dashboard("site-1"))
  }));
  await page.route("**/sites/*/dashboard**", (route) => {
    const siteId = new URL(route.request().url()).pathname.split("/")[3];
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(dashboard(siteId)) });
  });
  await page.route("**/energy/sites/*/summary", (route) => {
    const siteId = new URL(route.request().url()).pathname.split("/")[4];
    return route.fulfill({ contentType: "application/json", body: JSON.stringify(summary(siteId)) });
  });
  await page.route("**/energy/sites/*/series?**", (route) => {
    const url = new URL(route.request().url());
    const siteId = url.pathname.split("/")[4];
    const granularity = url.searchParams.get("granularity") === "month" ? "month" : "day";
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(series(siteId, granularity, url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? ""))
    });
  });
  await page.route("**/energy/sites/*/comparisons?**", (route) => {
    const url = new URL(route.request().url());
    const siteId = url.pathname.split("/")[4];
    const preset = comparisonPreset(url.searchParams.get("preset"));
    const outcome = siteId === "site-overuse"
      ? "overuse"
      : siteId === "site-empty" ? "unavailable" : "saving";
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(comparison(preset, outcome))
    });
  });
});

test("shows energy cards, daily and monthly lines, partial coverage and savings", async ({ page }) => {
  await page.goto("/statistics?siteId=site-1");

  await expect(page.getByRole("heading", { name: "에너지 리포트" })).toBeVisible();
  await expect(page).toHaveURL(/\/statistics\/overview\?siteId=site-1$/);
  await expect(page.getByRole("navigation", { name: "통계 메뉴" })).toBeVisible();
  await expect(page.getByRole("group", { name: "에너지 절감률" })).toContainText("35 %");
  await expect(page.getByRole("img", { name: "기준 대비 에너지 사용량 비교 차트" })).toBeVisible();
  await expect(page.getByLabel("오늘 전력 사용량")).toContainText("4.25 kWh");
  await expect(page.getByLabel("이번 달 누적 전력 사용량")).toContainText("수집 공백 있음");
  await expect(page.getByRole("region", { name: "상태 기반 추정 사용량" })).toBeVisible();
  await expect(page.getByRole("complementary", { name: "비용 비교" })).toBeVisible();
  await expect(page.getByText("이번 달 예상 비용")).toBeVisible();
  await expect(page.getByText("25,600원")).toBeVisible();
  await expect(page.getByText("22,016원")).toBeVisible();
  await expect(page.getByRole("img", { name: /일별 상태 기반 추정/ })).toBeVisible();
  await expect(page.getByText(/2026년 8월 26일: 4.25 kWh, 680원, 수집 공백 2시간 0분/)).toBeAttached();

  const partialDot = page.locator(".statistics-chart-panel .recharts-line-dots circle").nth(1);
  await partialDot.hover();
  await expect(page.locator(".energy-tooltip")).toContainText("수집 공백 2시간 0분");

  await page.getByRole("button", { name: "월별" }).click();
  await expect(page.getByRole("button", { name: "월별" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("img", { name: /월별 상태 기반 추정/ })).toBeVisible();
  await expect(page.getByText(/2026년 7월: 140 kWh/)).toBeAttached();

  const comparisonRequest = page.waitForRequest((request) => request.url().includes("/comparisons?preset=last_7_days"));
  await page.getByRole("button", { name: "최근 7일" }).click();
  await comparisonRequest;
  await expect(page.getByRole("button", { name: "최근 7일" })).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/\/statistics\/overview\?siteId=site-1$/);
});

test("shows negative savings as overuse without clamping", async ({ page }) => {
  await page.goto("/statistics?siteId=site-overuse");

  await expect(page.getByRole("group", { name: "기준 대비 초과 사용" })).toContainText("-10 %");
  await expect(page.getByRole("group", { name: "기준 초과 전력" })).toContainText("10 kWh");
  await expect(page.getByText("초과 사용", { exact: true })).toBeVisible();
});

test("retries comparison failures without hiding existing usage cards", async ({ page }) => {
  let allowComparison = false;
  await page.route("**/energy/sites/site-comparison-retry/comparisons?**", (route) => {
    return allowComparison
      ? route.fulfill({ contentType: "application/json", body: JSON.stringify(comparison("current_month", "saving")) })
      : route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "failed" }) });
  });

  await page.goto("/statistics?siteId=site-comparison-retry");
  await expect(page.getByLabel("오늘 전력 사용량")).toContainText("4.25 kWh");
  await expect(page.getByText("절감 비교를 불러오지 못했습니다.")).toBeVisible();
  allowComparison = true;
  await page.getByRole("button", { name: "절감 비교 다시 시도" }).click();
  await expect(page.getByRole("group", { name: "에너지 절감률" })).toContainText("35 %");
});

test("shows the no-data state without zero usage cards", async ({ page }) => {
  await page.route("**/energy/sites/site-empty/summary", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(noDataSummary("site-empty"))
  }));

  await page.goto("/statistics?siteId=site-empty");
  await expect(page.getByText("아직 상태 기반 사용량을 표시할 수 없습니다.")).toBeVisible();
  await expect(page.getByText("조명 상태가 수집되면 통계가 표시됩니다.")).toBeVisible();
  await expect(page.getByLabel("오늘 전력 사용량")).toHaveCount(0);
});

test("retries a summary failure and keeps cards during a series failure", async ({ page }) => {
  let allowSummary = false;
  let allowDaySeries = false;
  await page.route("**/energy/sites/site-retry/summary", (route) => {
    return allowSummary
      ? route.fulfill({ contentType: "application/json", body: JSON.stringify(summary("site-retry")) })
      : route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "failed" }) });
  });
  await page.route("**/energy/sites/site-retry/series?**", (route) => {
    const url = new URL(route.request().url());
    const granularity = url.searchParams.get("granularity") === "month" ? "month" : "day";
    if (granularity === "day" && !allowDaySeries) {
      return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ message: "failed" }) });
    }
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(series("site-retry", granularity, url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? ""))
    });
  });

  await page.goto("/statistics?siteId=site-retry");
  await expect(page.getByText("전력 통계를 불러오지 못했습니다.")).toBeVisible();
  allowSummary = true;
  await page.getByRole("button", { name: "전력 통계 다시 시도" }).click();
  await expect(page.getByLabel("오늘 전력 사용량")).toContainText("4.25 kWh");
  await expect(page.getByText("사용량 추이를 불러오지 못했습니다.")).toBeVisible();
  allowDaySeries = true;
  await page.getByRole("button", { name: "사용량 추이 다시 시도" }).click();
  await expect(page.getByRole("img", { name: /일별 상태 기반 추정/ })).toBeVisible();
});

test("packs the statistics report from the top in a tall viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 2400 });
  await page.goto("/statistics");
  await expect(page.getByRole("heading", { name: "에너지 리포트" })).toBeVisible();

  const layout = await page.locator(".statistics-shell").evaluate((shell) => {
    const heading = shell.querySelector("h2");
    const report = shell.querySelector(".statistics-report-layout");
    if (!heading || !report) throw new Error("statistics report layout is incomplete");

    const shellRect = shell.getBoundingClientRect();
    const headingRect = heading.getBoundingClientRect();
    const reportRect = report.getBoundingClientRect();
    return {
      headingOffset: headingRect.top - shellRect.top,
      remainingSpace: shellRect.bottom - reportRect.bottom
    };
  });

  expect(layout.headingOffset).toBeGreaterThan(0);
  expect(layout.headingOffset).toBeLessThan(100);
  expect(layout.remainingSpace).toBeGreaterThan(100);
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 320, height: 740 }
] as const) {
  test(`keeps the statistics report responsive at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto("/statistics");
    await expect(page.getByRole("heading", { name: "에너지 리포트" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "통계 메뉴" })).toBeVisible();
    await expect(page.getByRole("region", { name: "기준 대비 사용량 비교" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "동기간 비교" })).toBeVisible();

    const expectedColumns = viewport.width === 320 ? 1 : viewport.width === 390 ? 2 : 3;
    expect(await gridColumnCount(page)).toBe(expectedColumns);
    await expectReportPanelLayout(page, viewport.width <= 1120);
    await expect(page.getByRole("region", { name: "상태 기반 추정 사용량" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "비용 비교" })).toBeVisible();
    const firstAxisLabel = page.locator(".energy-line-chart .recharts-cartesian-axis-tick-value").first();
    await expect(firstAxisLabel).toBeVisible();
    expect(await firstAxisLabel.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(11);
    await expect(page.getByRole("button", { name: "일별" })).toBeVisible();
    await expect(page.getByRole("button", { name: "월별" })).toBeVisible();
    await expectStatisticsSpacing(page, viewport.width <= 760);
    await expectComparisonPanelLayout(page, viewport.width <= 1120);
    const comparisonOverflow = await page.locator(".statistics-comparison-chart-panel").evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth
    }));
    expect(comparisonOverflow.scrollWidth).toBeLessThanOrEqual(comparisonOverflow.clientWidth);
    await expectNoHorizontalOverflow(page);
    if (viewport.width <= 760) {
      const chartHeading = page.locator(".statistics-chart-heading");
      await chartHeading.evaluate((element) => element.scrollIntoView({ block: "center" }));
      await expect(page.getByRole("button", { name: "일별" })).toBeInViewport();
      await expect(page.getByRole("button", { name: "월별" })).toBeInViewport();
      await expectMinimumTouchTargets(page, ".app-shell");
    }
  });
}

async function expectStatisticsSpacing(page: Page, compact: boolean) {
  const screenGap = await page.locator(".statistics-screen").evaluate((element) => {
    return getComputedStyle(element).rowGap;
  });
  expect(screenGap).toBe("24px");

  const summaryGap = await page.locator(".statistics-summary").evaluate((element) => {
    return getComputedStyle(element).gap;
  });
  expect(summaryGap).toBe("16px");

  const panelPadding = await page.locator(".statistics-chart-panel").evaluate((element) => {
    return getComputedStyle(element).paddingTop;
  });
  expect(panelPadding).toBe(compact ? "16px" : "24px");

  const chartPanelGap = await page.locator(".statistics-chart-panel").evaluate((element) => {
    return getComputedStyle(element).gap;
  });
  expect(chartPanelGap).toBe("16px");

  const metricCardSpacing = await page.locator(".statistics-metric .ui-metric-card").first().evaluate((element) => {
    const styles = getComputedStyle(element);
    return { minHeight: styles.minHeight, paddingBottom: styles.paddingBottom };
  });
  expect(metricCardSpacing).toEqual({ minHeight: "0px", paddingBottom: "16px" });

  const statusPosition = await page.locator(".statistics-metric .ui-status-badge").first().evaluate((element) => {
    return getComputedStyle(element).position;
  });
  expect(statusPosition).toBe("static");

  if (compact) {
    const metricLabelWidth = await page.locator(".statistics-metric .ui-metric-label").first().evaluate((element) => {
      return element.getBoundingClientRect().width;
    });
    expect(metricLabelWidth).toBeGreaterThanOrEqual(100);

    const [chartTitle, chartTabs] = await Promise.all([
      page.locator(".statistics-chart-heading h3").boundingBox(),
      page.locator(".statistics-chart-heading .segmented-control").boundingBox()
    ]);
    expect(chartTitle).not.toBeNull();
    expect(chartTabs).not.toBeNull();
    if (chartTitle && chartTabs) {
      expect(chartTabs.y).toBeGreaterThanOrEqual(chartTitle.y + chartTitle.height);
    }
  }
}

function dashboard(siteId: string) {
  return {
    site: {
      id: siteId,
      name: "테스트 주차장",
      customerName: "테스트 고객사",
      installationStatus: "installed",
      address: "서울시 강남구",
      tariffKwhRate: 160,
      timeZone: "Asia/Seoul"
    },
    summary: { totalFixtures: 10, onlineFixtures: 10, faultFixtures: 0, averageBrightness: 60 },
    floors: [],
    groups: [],
    gateways: []
  };
}

function summary(siteId: string) {
  return {
    siteId,
    timeZone: "Asia/Seoul",
    source: "state_based_estimate",
    generatedAt,
    today: { estimatedKwh: 4.25, estimatedCost: 680, knownSeconds: 43200, unknownSeconds: 0, dataStatus: "available" },
    monthToDate: { estimatedKwh: 120.5, estimatedCost: 19280, knownSeconds: 2073600, unknownSeconds: 7200, dataStatus: "partial" },
    yearToDate: { estimatedKwh: 900, estimatedCost: 144000, knownSeconds: 20000000, unknownSeconds: 7200, dataStatus: "partial" },
    monthForecast: { estimatedKwh: 160, estimatedCost: 25600, observedKnownSeconds: 2073600, reason: "available" },
    baseline24Hours: { estimatedKwh: 297.6, estimatedCost: 47616, fixtureCount: 10, daysInMonth: 31 },
    estimatedSavings: { kwh: 137.6, cost: 22016 },
    lastAggregatedAt: generatedAt
  };
}

function noDataSummary(siteId: string) {
  const period = { estimatedKwh: 0, estimatedCost: 0, knownSeconds: 0, unknownSeconds: 86400, dataStatus: "no_data" };
  return {
    ...summary(siteId),
    today: period,
    monthToDate: period,
    yearToDate: period,
    monthForecast: { estimatedKwh: null, estimatedCost: null, observedKnownSeconds: 0, reason: "insufficient_state" },
    estimatedSavings: { kwh: null, cost: null }
  };
}

function series(siteId: string, granularity: "day" | "month", from: string, to: string) {
  return {
    siteId,
    timeZone: "Asia/Seoul",
    source: "state_based_estimate",
    generatedAt,
    granularity,
    from,
    to,
    points: granularity === "day"
      ? [
          { source: "state_based_estimate", period: "2026-08-25", estimatedKwh: 4.1, estimatedCost: 656, knownSeconds: 86400, unknownSeconds: 0, dataStatus: "available" },
          { source: "state_based_estimate", period: "2026-08-26", estimatedKwh: 4.25, estimatedCost: 680, knownSeconds: 79200, unknownSeconds: 7200, dataStatus: "partial" },
          { source: "state_based_estimate", period: "2026-08-27", estimatedKwh: null, estimatedCost: null, knownSeconds: 0, unknownSeconds: 86400, dataStatus: "no_data" }
        ]
      : [
          { source: "state_based_estimate", period: "2026-07", estimatedKwh: 140, estimatedCost: 22400, knownSeconds: 2678400, unknownSeconds: 0, dataStatus: "available" },
          { source: "state_based_estimate", period: "2026-08", estimatedKwh: 120.5, estimatedCost: 19280, knownSeconds: 2073600, unknownSeconds: 7200, dataStatus: "partial" }
        ]
  };
}

type ComparisonOutcome = "saving" | "overuse" | "unavailable";
type ComparisonPreset = "last_7_days" | "current_month" | "current_year";

function comparisonPreset(value: string | null): ComparisonPreset {
  return value === "last_7_days" || value === "current_year" ? value : "current_month";
}

function comparison(preset: ComparisonPreset, outcome: ComparisonOutcome) {
  const unavailable = outcome === "unavailable";
  const overuse = outcome === "overuse";
  const period = preset === "current_year" ? "2026-08" : "2026-08-25";
  const estimatedKwh = unavailable ? null : overuse ? 110 : 65;
  return {
    siteId: "00000000-0000-4000-8000-000000000003",
    timeZone: "Asia/Seoul",
    source: "state_based_estimate",
    generatedAt,
    preset,
    range: { from: "2026-08-01", to: "2026-08-31", completedThrough: "2026-08-25" },
    summary: {
      baselineKwh: 100,
      estimatedKwh,
      savingsKwh: unavailable ? null : overuse ? -10 : 35,
      savingsCost: unavailable ? null : overuse ? -1_600 : 5_600,
      savingsRatePercent: unavailable ? null : overuse ? -10 : 35,
      outcome,
      forecastReason: preset === "current_month"
        ? unavailable ? "insufficient_state" : "available"
        : "not_applicable"
    },
    priorComparisons: [],
    points: [{
      period,
      baselineKwh: 100,
      estimatedKwh,
      phase: unavailable ? "unavailable" : preset === "current_month" ? "forecast" : "observed",
      knownSeconds: unavailable ? 0 : 79_200,
      unknownSeconds: unavailable ? 86_400 : 7_200,
      coverageRate: unavailable ? null : 0.9167,
      dataStatus: unavailable ? "no_data" : "partial"
    }]
  };
}

async function gridColumnCount(page: Page) {
  return page.locator(".statistics-summary").evaluate((element) => {
    return getComputedStyle(element).gridTemplateColumns.split(" ").length;
  });
}

async function expectReportPanelLayout(page: Page, stacked: boolean) {
  const [chart, costs] = await Promise.all([
    page.locator(".statistics-chart-panel").boundingBox(),
    page.locator(".statistics-cost-panel").boundingBox()
  ]);
  expect(chart).not.toBeNull();
  expect(costs).not.toBeNull();
  if (!chart || !costs) return;

  if (stacked) {
    expect(costs.y).toBeGreaterThanOrEqual(chart.y + chart.height - 1);
  } else {
    expect(costs.x).toBeGreaterThanOrEqual(chart.x + chart.width - 1);
  }
}

async function expectComparisonPanelLayout(page: Page, stacked: boolean) {
  const [chart, comparisonPanel] = await Promise.all([
    page.locator(".statistics-comparison-chart-panel").boundingBox(),
    page.locator(".period-comparison-panel").boundingBox()
  ]);
  expect(chart).not.toBeNull();
  expect(comparisonPanel).not.toBeNull();
  if (!chart || !comparisonPanel) return;

  if (stacked) {
    expect(comparisonPanel.y).toBeGreaterThanOrEqual(chart.y + chart.height - 1);
  } else {
    expect(comparisonPanel.x).toBeGreaterThanOrEqual(chart.x + chart.width - 1);
  }
}
