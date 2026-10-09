import type { Page } from "@playwright/test";
import type { EnergyReportJob } from "@led-control/shared/energy-p2-contracts";
const generatedAt = "2026-08-26T00:00:00.000Z";
export async function installFirstScreenStatisticsFixtures(page: Page) {
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
        status: "active",
        mustChangePassword: false
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
  await page.route("**/energy/sites/*/comparisons/range?**", (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({ json: customComparison(url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? "",
      url.pathname.split("/")[4]) });
  });
  // Large daily ticks reproduce the clipped leading digits found in visual QA.
  await page.route("**/energy/sites/*/rankings?**", (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(ranking(
        url.searchParams.get("dimension") ?? "floor",
        url.searchParams.get("metric") ?? "usage",
        url.searchParams.get("sort") ?? "desc",
        url.searchParams.get("from") ?? "2026-08-01",
        url.searchParams.get("to") ?? "2026-08-31",
        url.pathname.split("/")[4]
      ))
    });
  });
  await page.route("**/energy/sites/*/heatmap?**", route => route.fulfill({ json: heatmap(new URL(route.request().url())) }));
  await page.route("**/energy/sites/*/heatmap/observed-mean?**", route => route.fulfill({ json: observedMeanHeatmap(new URL(route.request().url())) }));
  await page.route("**/energy/sites/*/reports*", route => route.fulfill({ json: { reports: [], nextCursor: null, totalCount: 0 } }));
  await page.route("**/energy/sites/*/report-targets", route => route.fulfill({ json: {
    siteId: reportSiteId, timeZone: "Asia/Seoul", lastCompletedDate: "2026-09-11", targets: [
      { scope: "site", identityId: reportSiteId, label: "보고서 현장" },
      { scope: "fixture", identityId: "30000000-0000-4000-8000-000000000021", label: "조명 💡 이력" },
      { scope: "group", identityId: "30000000-0000-4000-8000-000000000031", label: "과거 그룹" }
    ]
  } }));
}

const reportSiteId = "30000000-0000-4000-8000-000000000001";
function heatmap(url: URL) {
  return { siteId: url.pathname.split("/")[4], timeZone: "Asia/Seoul", generatedAt, metric: url.searchParams.get("metric") ?? "energy",
    scope: url.searchParams.get("scope") ?? "floor", identityId: url.searchParams.get("identityId"),
    range: { from: url.searchParams.get("from"), to: url.searchParams.get("to") },
    cells: Array.from({ length: 168 }, (_, index) => ({ weekday: Math.floor(index / 24), hour: index % 24,
      value: index === 1 ? null : index === 0 ? 0 : url.searchParams.get("metric") === "brightness" ? 50 : 0.5 })) };
}
function observedMeanHeatmap(url: URL) {
  const base = heatmap(url);
  return { ...base, cells: base.cells.map((cell, index) => ({ ...cell,
    knownSeconds: index === 1 ? 1800 : 3600,
    expectedSeconds: 3600,
    observedLocalDays: 1,
    eligibleLocalDays: 1,
    coverageRate: index === 1 ? 0.5 : 1
  })) };
}
export function browserReport(
  status: EnergyReportJob["status"],
  request: EnergyReportJob["request"] = {
    from: "2026-09-01", to: "2026-09-07", scope: "site", identityId: reportSiteId, format: "pdf"
  }
): EnergyReportJob {
  const common = { reportId: "30000000-0000-4000-8000-000000000041", siteId: reportSiteId,
    request, status,
    progressPercent: status === "processing" ? 40 : status === "completed" || status === "expired" ? 100 : 0,
    createdAt: generatedAt, startedAt: status === "queued" ? null : generatedAt,
    completedAt: status === "completed" || status === "expired" ? generatedAt : null,
    expiresAt: status === "completed" || status === "expired" ? "2026-09-19T00:00:00.000Z" : null };
  const targetAndRequest = {
    target: { scope: request.scope, identityId: request.identityId, label: request.scope === "site" ? "보고서 현장" : `${request.scope} 이력 대상` },
    requestedAt: generatedAt };
  // Keep the correlated failure union and original serialized field order.
  return status === "failed"
    ? { ...common, failureCode: "REPORT_GENERATION_FAILED", ...targetAndRequest,
      failure: { code: "generation_failed", message: "보고서를 생성하지 못했습니다.", action: "잠시 후 다시 생성해 주세요." } }
    : { ...common, failureCode: null, ...targetAndRequest, failure: null };
}

function dashboard(siteId: string) {
  return {
    capabilities: { read: true, control: true, manage: true, commission: true },
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

function customComparison(from: string, to: string, siteId = reportSiteId) {
  const { preset: _preset, ...base } = comparison("last_7_days", "saving");
  return { ...base, siteId, selection: { kind: "custom", from, to },
    range: { from, to, completedThrough: to },
    summary: { ...base.summary, forecastReason: "not_applicable" },
    points: base.points.map((point) => ({ ...point, period: from, phase: "observed" })) };
}

function ranking(dimension: string, metric: string, sort: string, from: string, to: string, siteId = reportSiteId) {
  const name = dimension === "group" ? "출입구 그룹" : dimension === "fixture" ? "B1-L01" : "B1 주차장";
  return {
    siteId,
    timeZone: "Asia/Seoul",
    source: "state_based_estimate",
    generatedAt,
    dimension,
    metric,
    sort,
    range: { from, to },
    siteTotalKwh: 20,
    siteTotalCost: 3200,
    overlappingMemberships: dimension === "group",
    legacyExcludedBefore: null,
    ranked: Array.from({ length: 4 }, (_, index) => ({
      identityId: `30000000-0000-4000-8000-${String(index + 20).padStart(12, "0")}`,
      operationalId: `30000000-0000-4000-8000-${String(index + 20).padStart(12, "0")}`,
      name: `${name} ${index + 1}`,
      rank: index + 1,
      fixtureCount: 8,
      estimatedKwh: 12.5,
      estimatedCost: 2000,
      contributionRate: 0.625,
      perFixtureAverageKwh: 1.5625,
      metricValue: metric === "cost" ? 2000 : metric === "contribution" ? 0.625 : metric === "per_fixture_average" ? 1.5625 : 12.5,
      knownSeconds: 691200,
      unknownSeconds: 0,
      coverageRate: 1,
      dataStatus: "available",
      historyQuality: "observed",
      unrankedReason: null,
      previousPeriod: { estimatedKwh: 14, changeRatePercent: -10.71, rank: 1 },
      dailyPoints: [{ period: to, estimatedKwh: 1.3, dataStatus: "available" }],
      fixtures: [{ identityId: "30000000-0000-4000-8000-000000000002", name: "B1-L01", estimatedKwh: 2.1 }]
    })),
    unranked: []
  };
}
