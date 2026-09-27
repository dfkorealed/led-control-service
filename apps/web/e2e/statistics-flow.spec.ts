import { expect, test, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { energyReportListResponseSchema, type EnergyReportJob } from "@led-control/shared/energy-p2-contracts";
import {
  expectMinimumTouchTargets,
  expectMinimumTouchTargetsAfterScrolling,
  expectNoHorizontalOverflow
} from "./support/layout-assertions";

const generatedAt = "2026-08-26T00:00:00.000Z";
const expectedReportVisualIds = [
  "daily-chart",
  "comparison-chart/energyKwh",
  "comparison-chart/cost",
  "fixture-ranking-chart",
  "floor-ranking-chart",
  "group-ranking-chart",
  "energy-heatmap-chart",
  "brightness-heatmap-chart"
] as const;

type RendererBrowserFixtures = {
  metadata: {
    schemaVersion: 2;
    scalarManifest: unknown;
    visualIds: string[];
    visualHashes: Record<string, string>;
    files: Record<"xlsx" | "pdf", { byteLength: number; sha256: string }>;
  };
  xlsx: { bytes: string; manifest: unknown; visuals: Array<{ id: string; sha256: string; width: number; height: number }> };
  pdf: { bytes: string; manifest: unknown; visuals: Array<{ id: string; sha256: string; width: number; height: number }> };
};
let downloadFixtureServer: Server | undefined;
test.afterEach(async () => {
  if (downloadFixtureServer) {
    downloadFixtureServer.closeAllConnections();
    await new Promise<void>((resolve, reject) => downloadFixtureServer!.close(error => error ? reject(error) : resolve()));
    downloadFixtureServer = undefined;
  }
});

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
});

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
function browserReport(
  status: EnergyReportJob["status"],
  format: "xlsx" | "pdf" = "xlsx",
  request: EnergyReportJob["request"] = {
    from: "2026-09-01", to: "2026-09-07", scope: "site", identityId: reportSiteId, format
  }
): EnergyReportJob {
  return { reportId: `30000000-0000-4000-8000-0000000000${format === "xlsx" ? "40" : "41"}`, siteId: reportSiteId,
    request, status,
    progressPercent: status === "processing" ? 40 : status === "completed" || status === "expired" ? 100 : 0,
    createdAt: generatedAt, startedAt: status === "queued" ? null : generatedAt,
    completedAt: status === "completed" || status === "expired" ? generatedAt : null,
    expiresAt: status === "completed" || status === "expired" ? "2026-09-19T00:00:00.000Z" : null,
    failureCode: status === "failed" ? "REPORT_GENERATION_FAILED" : null,
    target: { scope: request.scope, identityId: request.identityId, label: request.scope === "site" ? "보고서 현장" : `${request.scope} 이력 대상` },
    requestedAt: generatedAt,
    failure: status === "failed" ? { code: "generation_failed", message: "보고서를 생성하지 못했습니다.", action: "잠시 후 다시 생성해 주세요." } : null };
}

test("creates both report formats, polls state, downloads actual renderer bytes with identical extracted content, and retries", async ({ page }) => {
  test.setTimeout(60_000);
  const fixtures = JSON.parse(execFileSync("pnpm", ["--filter", "@led-control/api", "exec", "tsx", "test/support/render-report-browser-fixtures.ts"],
    { encoding: "utf8", maxBuffer: 30 * 1024 * 1024 })) as RendererBrowserFixtures;
  expect(fixtures.metadata.schemaVersion).toBe(2);
  expect(fixtures.metadata.visualIds).toEqual(expectedReportVisualIds);
  expect(fixtures.xlsx.visuals).toEqual(fixtures.pdf.visuals);
  expect(Object.fromEntries(fixtures.pdf.visuals.map(({ id, sha256 }) => [id, sha256]))).toEqual(fixtures.metadata.visualHashes);
  expect(fixtures.metadata.files.xlsx.byteLength).toBe(Buffer.from(fixtures.xlsx.bytes, "base64").byteLength);
  expect(fixtures.metadata.files.pdf.byteLength).toBe(Buffer.from(fixtures.pdf.bytes, "base64").byteLength);
  expect(fixtures.xlsx.manifest).toEqual(fixtures.metadata.scalarManifest);
  expect(fixtures.pdf.manifest).toEqual(fixtures.metadata.scalarManifest);
  expect(fixtures.xlsx.manifest).toEqual(fixtures.pdf.manifest);
  expect(JSON.stringify(fixtures.metadata.scalarManifest)).toContain("서울 공장");
  expect(JSON.stringify(fixtures.metadata.scalarManifest)).toContain("한글 조명");
  expect(JSON.stringify(fixtures.metadata.scalarManifest)).not.toMatch(/상태 기반 추정|coverage|unknown|forecast|탄소|배출|carbon|emission|최적화/i);
  await page.clock.install();
  // Chromium's anchor downloads can bypass request interception. A loopback server
  // provides deterministic file bytes without relying on a real worker or S3 account.
  downloadFixtureServer = createServer((request, response) => {
    const format = request.url?.includes(".pdf") ? "pdf" : "xlsx";
    response.writeHead(200, { "content-type": format === "pdf" ? "application/pdf" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "content-disposition": `attachment; filename="report.${format}"` });
    response.end(Buffer.from(fixtures[format].bytes, "base64"));
  });
  await new Promise<void>(resolve => downloadFixtureServer!.listen(0, "127.0.0.1", resolve));
  const address = downloadFixtureServer.address();
  if (!address || typeof address === "string") throw new Error("missing fixture port");
  const downloadOrigin = `http://127.0.0.1:${address.port}`;
  let records: EnergyReportJob[] = [];
  let downloadRequests = 0;
  const requests: unknown[] = [];
  await page.route("**/energy/sites/*/reports*", async route => {
    if (route.request().method() === "POST") {
      const request = route.request().postDataJSON(); requests.push(request);
      const job = browserReport("queued", request.format, request);
      records = [job]; await route.fulfill({ status: 202, json: job });
    } else await route.fulfill({ json: { reports: records, nextCursor: null, totalCount: records.length } });
  });
  await page.route("**/energy/sites/*/reports/*/download", route => {
    downloadRequests++;
    const job = records[0];
    return route.fulfill({ json: { reportId: job.reportId, format: job.request.format, expiresInSeconds: 300,
      downloadUrl: `${downloadOrigin}/report.${job.request.format}?signature=fresh-${downloadRequests}` } });
  });
  await page.goto(`/statistics/reports?siteId=${reportSiteId}`);
  await expect(page.getByText("요청한 보고서가 없습니다.")).toBeVisible();
  const reportHistory = page.getByRole("region", { name: "요청한 보고서" });
  for (const format of ["xlsx", "pdf"] as const) {
    await page.getByRole("button", { name: "보고서 만들기" }).click();
    const dialog = page.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" });
    await setDatePicker(dialog, "기간 시작", "2026-09-01");
    await setDatePicker(dialog, "기간 종료", "2026-09-07");
    await chooseOption(page, dialog, "파일 형식", format.toUpperCase());
    await dialog.getByRole("button", { name: "보고서 요청" }).click();
    await expect(reportHistory.getByText("대기 중", { exact: true }).first()).toBeVisible();
    expect(downloadRequests).toBe(format === "xlsx" ? 0 : 1);
    records = [browserReport("processing", format)];
    await page.clock.runFor(3000);
    await expect(reportHistory.getByText("생성 중 40%").first()).toBeVisible();
    await expect(reportHistory.getByRole("progressbar", { name: /보고서 생성 진행률/ }).first()).toHaveAttribute("aria-valuenow", "40");
    records = [browserReport("completed", format)];
    await page.clock.runFor(3000);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: /보고서 다운로드$/ }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(`report.${format}`);
    expect(await readFile((await file.path())!)).toEqual(Buffer.from(fixtures[format].bytes, "base64"));
    await expect(page.getByRole("region", { name: "에너지 보고서" })).not.toContainText(/예상|추정|coverage|known|unknown|forecast|baseline|탄소|배출|최적화/i);
  }
  expect(requests).toEqual([browserReport("queued", "xlsx").request, browserReport("queued", "pdf").request]);
  for (const status of ["failed", "expired"] as const) {
    records = [browserReport(status, "pdf")];
    await page.reload();
    await expect(reportHistory.getByText(status === "failed" ? "생성 실패" : "만료됨", { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: /보고서 다시 생성$/ }).click();
    await expect(reportHistory.getByText("대기 중", { exact: true }).first()).toBeVisible();
    expect(requests.at(-1)).toEqual(browserReport("queued", "pdf").request);
  }
  expect(downloadRequests).toBe(2);
  await expect(page.getByRole("navigation", { name: "통계 메뉴" }).getByRole("link")).toHaveText(["개요", "사용 분석", "보고서"]);
});

test("searches and paginates 101 server records, restores filters, and returns to page one after creation", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const fixture = await installReportHistoryFixture(page);
  fixture.expectNextListQuery({ limit: "20" });
  await page.goto(`/statistics/reports?siteId=${reportSiteId}`);

  const pagination = page.getByRole("navigation", { name: "페이지 이동" });
  await expect(pagination.getByRole("status")).toContainText("1~20 / 101건");
  await expect(page.getByRole("table", { name: "보고서 생성 이력" }).locator("tbody tr")).toHaveCount(20);

  fixture.expectNextListQuery({ limit: "20", cursor: "offset-20" });
  await pagination.getByRole("button", { name: "다음 페이지" }).click();
  await expect(pagination.getByRole("status")).toContainText("21~40 / 101건");
  await expect(page.getByRole("table", { name: "보고서 생성 이력" }).getByText("부산 보고서 021")).toBeVisible();
  const pageTwoUrl = new URL(page.url());
  expect(pageTwoUrl.href.length).toBeLessThan(200);
  expect([...pageTwoUrl.searchParams.keys()].sort()).toEqual(["limit", "siteId"]);

  fixture.expectNextListQuery({ limit: "20", cursor: "offset-20" });
  await page.reload();
  await expect(pagination.getByRole("status")).toContainText("21~40 / 101건");
  await expect(page.getByRole("table", { name: "보고서 생성 이력" }).getByText("부산 보고서 021")).toBeVisible();

  fixture.expectNextListQuery({ limit: "20" });
  await pagination.getByRole("button", { name: "이전 페이지" }).click();
  await expect(pagination.getByRole("status")).toContainText("1~20 / 101건");
  await expect(page.getByRole("table", { name: "보고서 생성 이력" }).getByText("서울 본사")).toBeVisible();

  fixture.expectNextListQuery({ limit: "20", cursor: "offset-20" });
  await page.goBack();
  await expect(pagination.getByRole("status")).toContainText("21~40 / 101건");
  fixture.expectNextListQuery({ limit: "20" });
  await page.goForward();
  await expect(pagination.getByRole("status")).toContainText("1~20 / 101건");

  fixture.expectNextListQuery({ limit: "50" });
  await chooseOption(page, pagination, "페이지당 항목 수", "50개");
  await expect(pagination.getByRole("status")).toContainText("1~50 / 101건");
  fixture.expectNextListQuery({ limit: "100" });
  await chooseOption(page, pagination, "페이지당 항목 수", "100개");
  await expect(pagination.getByRole("status")).toContainText("1~100 / 101건");

  const filters = page.getByRole("search", { name: "보고서 이력 필터" });
  fixture.expectNextListQuery({ limit: "100", query: "서울" });
  await filters.getByRole("searchbox", { name: "보고서 검색" }).fill(" 서울 ");
  await expect(pagination.getByRole("status")).toContainText("1~8 / 8건");
  fixture.expectNextListQuery({ limit: "100", query: "서울", status: "completed" });
  await chooseOption(page, filters, "상태", "완료");
  await expect(pagination.getByRole("status")).toContainText("1~7 / 7건");
  await expect(filters.getByRole("button", { name: "파일 형식" })).toBeVisible();
  await expect(filters.getByRole("button", { name: "범위" })).toBeVisible();
  fixture.expectNextListQuery({ limit: "100", query: "서울", status: "completed", format: "pdf" });
  await chooseOption(page, filters, "파일 형식", "PDF");
  await expect(pagination.getByRole("status")).toContainText("1~6 / 6건");
  fixture.expectNextListQuery({ limit: "100", query: "서울", status: "completed", format: "pdf", scope: "site" });
  await chooseOption(page, filters, "범위", "현장");
  await expect(pagination.getByRole("status")).toContainText("1~5 / 5건");
  fixture.expectNextListQuery({
    limit: "100",
    query: "서울",
    status: "completed",
    format: "pdf",
    scope: "site",
    requestedFrom: "2026-09-08",
    requestedTo: "2026-09-10"
  });
  await setDateRangePicker(filters, "요청 기간", "2026-09-08", "2026-09-10");
  await expect(pagination.getByRole("status")).toContainText("1~3 / 3건");
  await expect(page.getByRole("table", { name: "보고서 생성 이력" }).getByText("서울 본사")).toBeVisible();
  await expect(page.getByRole("table", { name: "보고서 생성 이력" })).not.toContainText(/조건 불일치/);
  await expect(page).toHaveURL(/query=%EC%84%9C%EC%9A%B8/);

  fixture.expectNextListQuery({
    limit: "100",
    query: "서울",
    status: "completed",
    format: "pdf",
    scope: "site",
    requestedFrom: "2026-09-08",
    requestedTo: "2026-09-10"
  });
  await page.reload();
  await expect(filters.getByRole("searchbox", { name: "보고서 검색" })).toHaveValue("서울");
  await expect(filters.getByRole("button", { name: "상태", exact: true })).toContainText("완료");
  await expect(filters.getByRole("button", { name: "형식: PDF 조건 제거" })).toBeVisible();
  await expect(filters.getByRole("button", { name: "범위: 현장 조건 제거" })).toBeVisible();
  const restoredUrl = page.url();
  await expect(filters.getByRole("button", { name: "파일 형식", exact: true })).toContainText("PDF");
  await expect(filters.getByRole("button", { name: "범위", exact: true })).toContainText("현장");
  await expect(page).toHaveURL(restoredUrl);
  await expect(pagination.getByRole("status")).toContainText("1~3 / 3건");

  fixture.expectNextListQuery({
    limit: "100",
    status: "completed",
    format: "pdf",
    scope: "site",
    requestedFrom: "2026-09-08",
    requestedTo: "2026-09-10"
  });
  await filters.getByRole("button", { name: "검색: 서울 조건 제거" }).click();
  await expect(filters.getByRole("searchbox", { name: "보고서 검색" })).toHaveValue("");
  await expect(pagination.getByRole("status")).toContainText("1~4 / 4건");
  await expect(page.getByRole("table", { name: "보고서 생성 이력" }).getByText("부산 검색 조건 불일치")).toBeVisible();

  fixture.expectNextListQuery({
    limit: "100",
    query: "서울",
    status: "completed",
    format: "pdf",
    scope: "site",
    requestedFrom: "2026-09-08",
    requestedTo: "2026-09-10"
  });
  await filters.getByRole("searchbox", { name: "보고서 검색" }).fill("서울");
  await expect(pagination.getByRole("status")).toContainText("1~3 / 3건");

  fixture.expectNextListQuery({ limit: "100" });
  await filters.getByRole("button", { name: "전체 초기화" }).click();
  await expect(pagination.getByRole("status")).toContainText("1~100 / 101건");
  await expect(filters.getByLabel("활성 조건")).toHaveCount(0);
  await expect(filters.getByRole("searchbox", { name: "보고서 검색" })).toHaveValue("");
  await expect(filters.getByRole("button", { name: "상태", exact: true })).toContainText("전체 상태");
  await expect(filters.getByRole("button", { name: "파일 형식", exact: true })).toContainText("전체 형식");
  await expect(filters.getByRole("button", { name: "범위", exact: true })).toContainText("전체 범위");
  await expect(filters.getByRole("button", { name: "요청 기간 선택, 현재 전체 기간" })).toBeVisible();
  expect(new URL(page.url()).searchParams.get("limit")).toBe("100");
  expect([...new URL(page.url()).searchParams.keys()].sort()).toEqual(["limit", "siteId"]);

  fixture.expectNextListQuery({ limit: "100", cursor: "offset-100" });
  await pagination.getByRole("button", { name: "다음 페이지" }).click();
  await expect(pagination.getByRole("status")).toContainText("101~101 / 101건");
  await expect(page.getByRole("table", { name: "보고서 생성 이력" }).getByText("부산 보고서 101")).toBeVisible();
  fixture.expectNextListQuery({ limit: "100" });
  await page.getByRole("button", { name: "보고서 만들기" }).click();
  await page.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" }).getByRole("button", { name: "보고서 요청" }).click();
  await expect(pagination.getByRole("status")).toContainText("1~100 / 102건");
  await expect(page.getByRole("region", { name: "요청한 보고서" }).getByText("대기 중", { exact: true }).first()).toBeVisible();
  expect(fixture.createdRequests).toHaveLength(1);

  fixture.expectNextListQuery({ limit: "100", query: "존재하지 않는 대상" });
  await filters.getByRole("searchbox", { name: "보고서 검색" }).fill("존재하지 않는 대상");
  await expect(page.getByText("요청한 보고서가 없습니다.")).toBeVisible();
  await expect(pagination.getByRole("status")).toContainText("0건");
  fixture.expectAllListQueriesObserved();
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 320, height: 740 }
] as const) {
  test(`report history uses the accessible responsive surface at ${viewport.width}x${viewport.height}`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await installReportHistoryFixture(page);
    await page.goto(`/statistics/reports?siteId=${reportSiteId}&query=%EC%84%9C%EC%9A%B8&format=pdf&scope=site&requestedFrom=2026-09-07&requestedTo=2026-09-11`);

    if (viewport.width >= 1024) {
      await expect(page.getByRole("table", { name: "보고서 생성 이력" })).toBeVisible();
      await expect(page.getByRole("list", { name: "모바일 보고서 생성 이력" })).toBeHidden();
    } else {
      await expect(page.getByRole("list", { name: "모바일 보고서 생성 이력" })).toBeVisible();
      await expect(page.getByRole("table", { name: "보고서 생성 이력" })).toBeHidden();
    }

    await expectNoHorizontalOverflow(page);
    const filters = page.getByRole("search", { name: "보고서 이력 필터" });
    const pagination = page.getByRole("navigation", { name: "페이지 이동" });
    const dateTrigger = filters.getByRole("button", { name: /요청 기간 선택, 현재/ });
    const formatSelect = filters.getByRole("button", { name: "파일 형식", exact: true });
    const scopeSelect = filters.getByRole("button", { name: "범위", exact: true });
    await expect(formatSelect).toBeVisible();
    await expect(scopeSelect).toBeVisible();
    await expect(filters.getByRole("button", { name: "형식: PDF 조건 제거" })).toBeVisible();
    await expect(filters.getByRole("button", { name: "범위: 현장 조건 제거" })).toBeVisible();
    const visibleHistory = viewport.width >= 1024
      ? page.getByRole("table", { name: "보고서 생성 이력" })
      : page.getByRole("list", { name: "모바일 보고서 생성 이력" });
    const touchTargets = [
      filters.getByRole("searchbox", { name: "보고서 검색" }),
      filters.getByRole("button", { name: "상태" }),
      dateTrigger,
      formatSelect,
      scopeSelect,
      pagination.getByRole("button", { name: "페이지당 항목 수" }),
      visibleHistory.getByRole("button", { name: /보고서 다운로드$/ }).first(),
      visibleHistory.getByRole("button", { name: /보고서 다시 생성$/ }).first(),
      visibleHistory.getByRole("button", { name: /실패 상세 보기$/ }).first(),
      filters.getByRole("button", { name: "전체 초기화" }),
      ...await filters.getByRole("button", { name: /조건 제거$/ }).all()
    ];
    for (const target of touchTargets) {
      await expectLocatorTouchTarget(target, `${viewport.width}px visible interactive target`);
    }
    await dateTrigger.click();
    const dateDialog = page.getByRole("dialog", { name: "요청 기간 선택" });
    await expect(dateDialog.getByRole("group", { name: "요청 기간" })).toBeVisible();
    for (const target of await dateDialog.getByRole("group", { name: "요청 기간" }).getByRole("spinbutton").all()) {
      await expectLocatorTouchTarget(target, `${viewport.width}px request-date segment`);
    }
    await dateDialog.press("Escape");
    await expect(dateTrigger).toBeFocused();
    const reset = filters.getByRole("button", { name: "전체 초기화" });
    await reset.focus();
    await expect(reset).toBeFocused();
    expect(await reset.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");

    await visibleHistory.getByRole("button", { name: "서울 상태 조건 불일치 실패 상세 보기" }).click();
    await expect(page.getByRole("region", { name: "서울 상태 조건 불일치 실패 안내" })).toContainText("보고서를 생성하지 못했습니다.");
    await reset.click();
    await expect(pagination.getByRole("status")).toContainText("1~20 / 101건");
    const next = pagination.getByRole("button", { name: "다음 페이지" });
    await expectLocatorTouchTarget(next, `${viewport.width}px enabled next-page target`);
    await next.click();
    await expect(pagination.getByRole("status")).toContainText("21~40 / 101건");
    await expectLocatorTouchTarget(
      pagination.getByRole("button", { name: "이전 페이지" }),
      `${viewport.width}px enabled previous-page target`
    );
    await expectNoHorizontalOverflow(page);
  });
}

test("Atlas desktop statistics surfaces keep filter rows compact and all heatmap hours visible", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/statistics/reports?siteId=${reportSiteId}`);
  const reportFilters = page.getByRole("search", { name: "보고서 이력 필터" });
  const reportControls = [
    reportFilters.getByRole("searchbox", { name: "보고서 검색" }),
    reportFilters.getByRole("button", { name: "상태" }),
    reportFilters.getByRole("button", { name: /요청 기간 선택, 현재/ }),
    reportFilters.getByRole("button", { name: "파일 형식" }),
    reportFilters.getByRole("button", { name: "범위" })
  ];
  const reportRects = await Promise.all(reportControls.map((control) => control.boundingBox()));
  expect(reportRects.every(Boolean)).toBe(true);
  expect(Math.max(...reportRects.map((rect) => rect!.y)) - Math.min(...reportRects.map((rect) => rect!.y))).toBeLessThanOrEqual(2);
  const reportsImage = testInfo.outputPath("statistics-reports-1440.png");
  await page.screenshot({ path: reportsImage, fullPage: true });
  await testInfo.attach("statistics-reports-1440", { path: reportsImage, contentType: "image/png" });

  await page.route("**/energy/sites/*/rankings?**", (route) => {
    const url = new URL(route.request().url());
    const model = ranking(url.searchParams.get("dimension") ?? "floor", url.searchParams.get("metric") ?? "usage",
      url.searchParams.get("sort") ?? "desc", url.searchParams.get("from") ?? "", url.searchParams.get("to") ?? "",
      url.pathname.split("/")[4]);
    model.ranked[0].dailyPoints = [
      { period: "2026-08-24", estimatedKwh: 1_000_000, dataStatus: "available" },
      { period: "2026-08-25", estimatedKwh: 900_000, dataStatus: "available" }
    ];
    return route.fulfill({ json: model });
  });
  await page.goto(`/statistics/analysis?siteId=${reportSiteId}`);
  const filterCard = page.getByRole("region", { name: "사용량 분석 조건" });
  const dimension = filterCard.getByRole("group", { name: "분석 단위" });
  const analysisControls = [dimension, filterCard.getByRole("button", { name: "순위 기준" }),
    filterCard.getByRole("group", { name: "시작일" }), filterCard.getByRole("group", { name: "종료일" }),
    filterCard.getByRole("button", { name: /높은 순|낮은 순/ })];
  const analysisRects = await Promise.all(analysisControls.map((control) => control.boundingBox()));
  expect(analysisRects.every(Boolean)).toBe(true);
  expect(Math.max(...analysisRects.map((rect) => rect!.y + rect!.height)) - Math.min(...analysisRects.map((rect) => rect!.y + rect!.height)), JSON.stringify(analysisRects)).toBeLessThanOrEqual(2);
  expect((await filterCard.boundingBox())!.height).toBeLessThan(125);

  const detail = page.getByRole("complementary", { name: /상세$/ });
  expect((await detail.boundingBox())!.height, "desktop ranking detail should not create a large empty ranking column").toBeLessThanOrEqual(460);
  const chart = detail.locator(".recharts-wrapper");
  const chartLeft = (await chart.boundingBox())!.x;
  const yTicks = chart.locator('svg text[orientation="left"]');
  expect(await yTicks.count()).toBeGreaterThan(0);
  for (const tick of await yTicks.all()) {
    expect((await tick.boundingBox())!.x).toBeGreaterThanOrEqual(chartLeft);
    const leftEdge = await tick.evaluate((element) => {
      const label = element as SVGTextElement;
      return Number(label.getAttribute("x")) - label.getComputedTextLength();
    });
    expect(leftEdge, "numeric Y-axis glyphs remain inside the SVG viewport").toBeGreaterThanOrEqual(0);
  }
  const heatmapPanel = page.getByRole("region", { name: "시간대별 사용량" });
  const scroller = heatmapPanel.getByLabel("시간대별 사용량 표를 가로로 스크롤");
  const hour23 = heatmapPanel.getByRole("group", { name: "시간대별 에너지 사용량" }).getByText("23", { exact: true });
  const panelRect = (await scroller.boundingBox())!;
  const lastHourRect = (await hour23.boundingBox())!;
  expect(lastHourRect.x + lastHourRect.width).toBeLessThanOrEqual(panelRect.x + panelRect.width + 1);
  await expectNoHorizontalOverflow(page);
  const analysisImage = testInfo.outputPath("statistics-analysis-1440.png");
  await page.screenshot({ path: analysisImage, fullPage: true });
  await testInfo.attach("statistics-analysis-1440", { path: analysisImage, contentType: "image/png" });
});

test("selects analytics fixture/group history and bounds dates to the site's completed day", async ({ page }) => {
  const requests: Array<{ scope: string; identityId: string; to: string }> = [];
  await page.route("**/energy/sites/*/reports*", async route => {
    if (route.request().method() === "POST") {
      const request = route.request().postDataJSON(); requests.push(request);
      await route.fulfill({ status: 202, json: browserReport("queued", request.format, request) });
    } else await route.fulfill({ json: { reports: [], nextCursor: null, totalCount: 0 } });
  });
  await page.goto(`/statistics/reports?siteId=${reportSiteId}`);
  for (const [scope, identityId] of [["fixture", "30000000-0000-4000-8000-000000000021"], ["group", "30000000-0000-4000-8000-000000000031"]]) {
    await page.getByRole("button", { name: "보고서 만들기" }).click();
    const dialog = page.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" });
    await expectDatePicker(dialog, "기간 종료", "2026-09-11");
    const endDate = dialog.getByRole("group", { name: "기간 종료" });
    const endDay = endDate.getByRole("spinbutton").nth(2);
    await endDay.focus();
    await page.keyboard.press("ArrowUp");
    await expect(dialog.getByRole("button", { name: "보고서 요청" })).toBeDisabled();
    await endDate.getByRole("button").click();
    await expect(page.getByRole("button", { name: /2026년 9월 12일/ })).toHaveAttribute("aria-disabled", "true");
    await page.keyboard.press("Escape");
    await endDay.focus();
    await page.keyboard.press("ArrowDown");
    await expect(dialog.getByRole("button", { name: "보고서 요청" })).toBeEnabled();
    await chooseOption(page, dialog, "범위", scope === "fixture" ? "조명" : "그룹");
    await expect(dialog.getByRole("button", { name: "대상" })).toContainText(scope === "fixture" ? "조명 💡 이력" : "과거 그룹");
    await dialog.getByRole("button", { name: "보고서 요청" }).click();
    await expect(dialog).not.toBeVisible();
    expect(requests.at(-1)).toMatchObject({ scope, identityId, to: "2026-09-11" });
  }
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 320, height: 740 }
] as const) {
  test(`heatmap and report controls remain usable without document overflow at ${viewport.width}px`, async ({ page }, testInfo) => {
    const { width } = viewport;
    await page.setViewportSize(viewport);
    await page.goto(`/statistics/analysis?siteId=${reportSiteId}`);
    const rankingBounds = await page.getByRole("region", { name: "사용량 순위" }).boundingBox();
    const detailBounds = await page.getByRole("complementary", { name: /상세$/ }).boundingBox();
    expect(rankingBounds).not.toBeNull();
    expect(detailBounds).not.toBeNull();
    if (width >= 1024) {
      expect(Math.abs(rankingBounds!.y - detailBounds!.y), `${width}px analysis cards share one row`).toBeLessThanOrEqual(2);
      expect(detailBounds!.x, `${width}px detail follows ranking horizontally`).toBeGreaterThan(rankingBounds!.x + rankingBounds!.width - 2);
    } else {
      expect(detailBounds!.y, `${width}px detail stacks below ranking`).toBeGreaterThan(rankingBounds!.y + rankingBounds!.height - 2);
    }
    const energyGrid = page.getByRole("group", { name: "시간대별 에너지 사용량" });
    await expect(energyGrid.getByRole("button")).toHaveCount(168);
    const sunday00 = energyGrid.getByRole("button", { name: /일요일 00시, 평균 0 kWh, 수집률 100%/ });
    await sunday00.focus();
    await page.keyboard.press("ArrowRight");
    const sunday01 = energyGrid.getByRole("button", { name: /일요일 01시, 평균 산정 불가, 수집률 50%/ });
    await expect(sunday01).toBeFocused();
    await expect(sunday01).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("End");
    const sunday23 = energyGrid.getByRole("button", { name: /일요일 23시, 평균 0.5 kWh/ });
    await expect(sunday23).toBeFocused();
    await page.keyboard.press("ArrowDown");
    const monday23 = energyGrid.getByRole("button", { name: /월요일 23시, 평균 0.5 kWh/ });
    await expect(monday23).toBeFocused();
    await page.keyboard.press("Home");
    const monday00 = energyGrid.getByRole("button", { name: /월요일 00시, 평균 0.5 kWh/ });
    await expect(monday00).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(monday00).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: "월요일 00시, 평균 0.5 kWh" })).toBeVisible();
    await energyGrid.getByRole("button", { name: /일요일 00시, 평균 0 kWh/ }).click();
    await expect(page.getByRole("status").filter({ hasText: "일요일 00시, 평균 0 kWh" })).toBeVisible();
    const missing = energyGrid.getByRole("button", { name: /일요일 01시, 평균 산정 불가/ });
    await missing.focus(); await page.keyboard.press("Enter");
    await expect(missing).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "밝기", exact: true }).click();
    const brightnessGrid = page.getByRole("group", { name: "시간대별 밝기" });
    await expect(brightnessGrid).toBeVisible();
    const cells = await brightnessGrid.getByRole("button").evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect(); return { width: rect.width, height: rect.height };
    }));
    expect(cells.every(cell => cell.width >= 44 && cell.height >= 44)).toBe(true);
    await expectNoHorizontalOverflow(page);
    await page.getByRole("button", { name: "에너지", exact: true }).scrollIntoViewIfNeeded();
    for (const metricButton of await page.getByRole("region", { name: "시간대별 사용량" }).getByRole("button", { name: /^(에너지|밝기)$/ }).all()) {
      const bounds = await metricButton.boundingBox();
      expect(bounds?.width).toBeGreaterThanOrEqual(44); expect(bounds?.height).toBeGreaterThanOrEqual(44);
    }
    await expectMinimumTouchTargets(page, "[aria-label='히트맵 지표']");
    for (const index of [0, 23, 167]) {
      const cell = brightnessGrid.getByRole("button").nth(index);
      await cell.evaluate((element) => element.scrollIntoView({ block: "center", inline: "center" }));
      const bounds = await cell.boundingBox();
      expect(bounds?.width).toBeGreaterThanOrEqual(44); expect(bounds?.height).toBeGreaterThanOrEqual(44);
      const marker = `heatmap-touch-${index}`;
      await cell.evaluate((element, value) => element.setAttribute("data-e2e-heatmap-touch", value), marker);
      await expectMinimumTouchTargets(page, `[data-e2e-heatmap-touch='${marker}']`);
      await cell.evaluate((element) => element.removeAttribute("data-e2e-heatmap-touch"));
    }
    const heatmapPath = testInfo.outputPath(`heatmap-${width}.png`);
    await page.screenshot({ path: heatmapPath });
    await testInfo.attach(`heatmap-${width}`, { path: heatmapPath, contentType: "image/png" });
    const narrowTargetLabel = "320픽셀에서도 온전히 보이는 매우 긴 보고서 대상 이름";
    if (width === 320) {
      await page.route("**/energy/sites/*/reports*", route => route.fulfill({ json: { reports: [{
        ...browserReport("completed"),
        target: { scope: "site", identityId: reportSiteId, label: narrowTargetLabel }
      }], nextCursor: null, totalCount: 1 } }));
    }
    await page.getByRole("link", { name: "보고서", exact: true }).click();
    if (width === 320) {
      const report = page.getByRole("listitem", { name: `${narrowTargetLabel} 보고서` });
      await expect(report).toBeVisible();
      await expect(report.getByRole("button", { name: `${narrowTargetLabel} 보고서 다운로드` })).toBeVisible();
      const wrapping = await report.getByRole("group", { name: "보고서 메타데이터" }).evaluate((metadata) => {
        const bounds = metadata.getBoundingClientRect();
        const itemBounds = Array.from(metadata.children, child => child.getBoundingClientRect());
        return {
          display: getComputedStyle(metadata).display,
          rowCount: new Set(itemBounds.map(item => Math.round(item.top))).size,
          insideCard: itemBounds.every(item => item.right <= bounds.right + 1)
        };
      });
      expect(wrapping).toMatchObject({ display: "grid", insideCard: true });
      expect(wrapping.rowCount).toBeGreaterThanOrEqual(2);
      await expectNoHorizontalOverflow(page);
    }
    await page.getByRole("button", { name: "보고서 만들기" }).click();
    const dialog = page.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" });
    await expect(dialog.getByRole("button", { name: "CSV 내보내기" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const controls = dialog.getByRole("button").or(dialog.getByRole("spinbutton"));
    for (const control of await controls.all()) {
      await control.scrollIntoViewIfNeeded();
      const bounds = await control.boundingBox();
      expect(bounds?.width).toBeGreaterThanOrEqual(44); expect(bounds?.height).toBeGreaterThanOrEqual(44);
    }
    await expectMinimumTouchTargetsAfterScrolling(page, "[role='dialog'][aria-modal='true']");
    const reportPath = testInfo.outputPath(`report-dialog-${width}.png`);
    await page.screenshot({ path: reportPath });
    await testInfo.attach(`report-dialog-${width}`, { path: reportPath, contentType: "image/png" });
  });
}

test("navigates to usage analysis and drills into fixture, floor, and group rankings", async ({ page }) => {
  await page.goto(`/statistics/overview?siteId=${reportSiteId}`);
  await page.getByRole("link", { name: "사용 분석" }).click();
  await expect(page).toHaveURL(new RegExp(`/statistics/analysis\\?siteId=${reportSiteId}$`));
  await expect(page.getByRole("region", { name: "사용량 분석 결과" })).toBeVisible();
  await expect(page.getByRole("region", { name: "사용량 순위" })).toContainText("B1 주차장");
  await expect(page.getByRole("complementary", { name: "B1 주차장 상세" })).toBeVisible();

  const groupRequest = page.waitForRequest((request) => request.url().includes("dimension=group"));
  await page.getByRole("button", { name: "그룹" }).click();
  await groupRequest;
  await page.getByRole("button", { name: "그룹 중복 안내" }).click();
  await expect(page.getByRole("dialog", { name: "그룹 중복 안내" })).toContainText("그룹 합계는 현장 총계와 다를 수 있습니다.");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog", { name: "그룹 중복 안내" })).not.toBeVisible();
  await expect(page.getByRole("button", { name: "그룹 중복 안내" })).toBeFocused();
  await expectNoHorizontalOverflow(page);
});

test("returns focus to a retained report warning after its retry action", async ({ page }) => {
  let retryRequests = 0;
  let finishRetry: () => void = () => undefined;
  const pendingRetry = new Promise<void>((resolve) => { finishRetry = resolve; });
  await page.route("**/energy/sites/*/reports*", async (route) => {
    if (new URL(route.request().url()).searchParams.has("cursor")) {
      retryRequests++;
      if (retryRequests === 3) await pendingRetry;
      return route.fulfill({ status: 500, json: { message: "failed" } });
    }
    return route.fulfill({ json: { reports: [browserReport("completed")], nextCursor: "next-page", totalCount: 2 } });
  });

  await page.goto(`/statistics/reports?siteId=${reportSiteId}`);
  await expect(page.getByRole("navigation", { name: "페이지 이동" }).getByRole("button", { name: "다음 페이지" })).toBeEnabled();
  await page.getByRole("navigation", { name: "페이지 이동" }).getByRole("button", { name: "다음 페이지" }).click();
  const warning = page.getByRole("button", { name: "목록 갱신 실패 안내" });
  await warning.click();
  await page.getByRole("dialog", { name: "목록 갱신 실패 안내" }).getByRole("button", { name: "다시 시도" }).click();
  await expect.poll(() => retryRequests).toBeGreaterThanOrEqual(3);
  await warning.click();
  const busyDetails = page.getByRole("dialog", { name: "목록 갱신 실패 안내" });
  await expect(busyDetails.getByRole("status")).toHaveText("확인 중");
  await expect(busyDetails.getByRole("button", { name: "다시 시도" })).toHaveCount(0);
  expect(retryRequests).toBe(3);
  await page.keyboard.press("Escape");
  finishRetry();
  await expect(warning).toBeFocused();
});

test("moves focus to the report list after a successful warning retry", async ({ page }) => {
  let cursorRequests = 0;
  await page.route("**/energy/sites/*/reports*", (route) => {
    if (new URL(route.request().url()).searchParams.has("cursor")) {
      cursorRequests++;
      if (cursorRequests <= 2) return route.fulfill({ status: 500, json: { message: "failed" } });
      return route.fulfill({ json: { reports: [browserReport("completed")], nextCursor: null, totalCount: 2 } });
    }
    return route.fulfill({ json: { reports: [browserReport("completed")], nextCursor: "next-page", totalCount: 2 } });
  });

  await page.goto(`/statistics/reports?siteId=${reportSiteId}`);
  await page.getByRole("navigation", { name: "페이지 이동" }).getByRole("button", { name: "다음 페이지" }).click();
  await page.getByRole("button", { name: "목록 갱신 실패 안내" }).click();
  await page.getByRole("dialog", { name: "목록 갱신 실패 안내" }).getByRole("button", { name: "다시 시도" }).click();
  await expect(page.getByRole("button", { name: "목록 갱신 실패 안내" })).toHaveCount(0);
  await expect(page.getByRole("region", { name: "요청한 보고서" })).toBeFocused();
});

test("keeps search focus when a pending warning retry later succeeds", async ({ page }) => {
  let cursorRequests = 0;
  let finishRetry: () => void = () => undefined;
  const pendingRetry = new Promise<void>((resolve) => { finishRetry = resolve; });
  await page.route("**/energy/sites/*/reports*", async (route) => {
    if (new URL(route.request().url()).searchParams.has("cursor")) {
      cursorRequests++;
      if (cursorRequests <= 2) return route.fulfill({ status: 500, json: { message: "failed" } });
      await pendingRetry;
      return route.fulfill({ json: { reports: [browserReport("completed")], nextCursor: null, totalCount: 2 } });
    }
    return route.fulfill({ json: { reports: [browserReport("completed")], nextCursor: "next-page", totalCount: 2 } });
  });

  await page.goto(`/statistics/reports?siteId=${reportSiteId}`);
  await page.getByRole("navigation", { name: "페이지 이동" }).getByRole("button", { name: "다음 페이지" }).click();
  await page.getByRole("button", { name: "목록 갱신 실패 안내" }).click();
  await page.getByRole("dialog", { name: "목록 갱신 실패 안내" }).getByRole("button", { name: "다시 시도" }).click();
  await expect.poll(() => cursorRequests).toBeGreaterThanOrEqual(3);
  const search = page.getByRole("searchbox", { name: "보고서 검색" });
  await search.focus();
  finishRetry();
  await expect(page.getByRole("button", { name: "목록 갱신 실패 안내" })).toHaveCount(0);
  await expect(search).toBeFocused();
});

test("shows energy cards, daily and monthly lines, partial coverage and savings", async ({ page }) => {
  await page.goto("/statistics?siteId=site-1");

  await expect(page.getByRole("heading", { name: "기준 대비 에너지 절감" })).toBeVisible();
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

  const partialDot = page.getByRole("region", { name: "상태 기반 추정 사용량" }).locator(".recharts-line-dots circle").nth(1);
  await partialDot.hover();
  await expect(page.getByText("수집 공백 2시간 0분", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "월별" }).click();
  await expect(page.getByRole("button", { name: "월별" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("img", { name: /월별 상태 기반 추정/ })).toBeVisible();
  await expect(page.getByText(/2026년 7월: 140 kWh/)).toBeAttached();

  const comparisonRequest = page.waitForRequest((request) => request.url().includes("/comparisons?preset=last_7_days"));
  await page.getByRole("button", { name: "최근 7일", exact: true }).click();
  await comparisonRequest;
  await expect(page.getByRole("button", { name: "최근 7일", exact: true })).toHaveAttribute("aria-pressed", "true");
  await expect(page).toHaveURL(/\/statistics\/overview\?siteId=site-1$/);
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 320, height: 740 }
] as const) {
  test(`completed comparison picker and analysis range stay coherent at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`/statistics/overview?siteId=${reportSiteId}`);
    const opener = page.getByRole("button", { name: /완료 기간 날짜 범위 선택, 현재/ });
    await opener.click();
    const dialog = page.getByRole("dialog", { name: "완료일 비교 기간 선택" });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("group", { name: "완료 기간 시작일과 종료일" }).getByRole("spinbutton").first()).toBeFocused();
    await dialog.getByRole("group", { name: "빠른 기간 선택" }).getByRole("button", { name: "최근 7일" }).click();
    const customRequest = page.waitForRequest((request) => request.url().includes("/comparisons/range?from=2026-08-19&to=2026-08-25"));
    await dialog.getByRole("button", { name: "선택 기간 적용" }).click();
    await customRequest;
    await expect(dialog).not.toBeVisible();
    await expect(opener).toBeFocused();
    await expect(opener).toHaveAccessibleName("완료 기간 날짜 범위 선택, 현재 2026-08-19 ~ 2026-08-25");
    await expect(page.getByRole("group", { name: "오늘 전력 사용량" })).toContainText("4.25 kWh");
    await expect(page.getByRole("heading", { name: "이번 달 비용 비교" })).toBeVisible();
    await expectNoHorizontalOverflow(page);

    await page.route("**/energy/sites/*/rankings?**", (route) => {
      const url = new URL(route.request().url());
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";
      const model = ranking(url.searchParams.get("dimension") ?? "floor", url.searchParams.get("metric") ?? "usage",
        url.searchParams.get("sort") ?? "desc", from, to, url.pathname.split("/")[4]);
      if (from === "2026-08-10" && to === "2026-08-20") {
        model.siteTotalKwh = 42;
        model.siteTotalCost = 6720;
        model.ranked[0].estimatedKwh = 31.5;
        model.ranked[0].metricValue = 31.5;
      }
      return route.fulfill({ json: model });
    });
    await page.getByRole("link", { name: "사용 분석" }).click();
    const analysis = page.getByRole("region", { name: "사용량 분석 결과" });
    await expect(analysis.getByRole("region", { name: "시간대별 사용량" })).toContainText("2026-08-01 ~ 2026-08-25");
    const rankingRequest = page.waitForRequest((request) => request.url().includes("/rankings?") &&
      request.url().includes("from=2026-08-10") && request.url().includes("to=2026-08-20"));
    const meanRequest = page.waitForRequest((request) => request.url().includes("/heatmap/observed-mean?") &&
      request.url().includes("from=2026-08-10") && request.url().includes("to=2026-08-20"));
    await setDatePicker(analysis, "시작일", "2026-08-10");
    await setDatePicker(analysis, "종료일", "2026-08-20");
    await rankingRequest;
    await meanRequest;
    await expect(analysis.getByRole("group", { name: "현장 사용량" })).toContainText("42 kWh");
    await expect(analysis.getByRole("complementary", { name: "B1 주차장 상세" })).toContainText("31.5 kWh");
    await expect(analysis.getByRole("region", { name: "시간대별 사용량" })).toContainText("2026-08-10 ~ 2026-08-20");
    const meanCells = analysis.getByRole("group", { name: "시간대별 에너지 사용량" });
    await expect(meanCells.getByRole("button", { name: /일요일 00시, 평균 0 kWh, 수집률 100%/ })).toBeVisible();
    await expect(meanCells.getByRole("button", { name: /일요일 01시, 평균 산정 불가, 수집률 50%/ })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
}

test("changing the analysis period clears old results while the new request is pending and after failure", async ({ page }) => {
  let releaseNewRange!: () => void;
  const newRangeGate = new Promise<void>((resolve) => { releaseNewRange = resolve; });
  await page.route("**/energy/sites/*/rankings?**", async (route) => {
    const url = new URL(route.request().url());
    const from = url.searchParams.get("from") ?? "";
    const to = url.searchParams.get("to") ?? "";
    if (from === "2026-08-10" && to === "2026-08-20") {
      await newRangeGate;
      await route.fulfill({ status: 503, json: { message: "temporarily unavailable" } });
      return;
    }
    await route.fulfill({ json: ranking(url.searchParams.get("dimension") ?? "floor",
      url.searchParams.get("metric") ?? "usage", url.searchParams.get("sort") ?? "desc", from, to,
      url.pathname.split("/")[4]) });
  });
  try {
    await page.goto(`/statistics/analysis?siteId=${reportSiteId}`);
    const analysis = page.getByRole("region", { name: "사용량 분석 결과" });
    await expect(analysis.getByRole("group", { name: "현장 사용량" })).toContainText("20 kWh");
    await expect(analysis.getByRole("region", { name: "시간대별 사용량" })).toBeVisible();

    await setDatePicker(analysis, "시작일", "2026-08-10");
    const nextRequest = page.waitForRequest((request) => request.url().includes("/rankings?") &&
      request.url().includes("from=2026-08-10") && request.url().includes("to=2026-08-20"));
    await setDatePicker(analysis, "종료일", "2026-08-20");
    await nextRequest;
    await expect(analysis.getByRole("group", { name: "현장 사용량" })).not.toBeVisible();
    await expect(analysis.getByRole("region", { name: "사용량 순위" })).not.toBeVisible();
    await expect(analysis.getByRole("complementary", { name: "B1 주차장 상세" })).not.toBeVisible();
    await expect(analysis.getByRole("region", { name: "시간대별 사용량" })).not.toBeVisible();

    releaseNewRange();
    await expect(analysis.getByText("사용량 분석을 불러오지 못했습니다.")).toBeVisible();
    await expect(analysis.getByRole("group", { name: "현장 사용량" })).not.toBeVisible();
    await expect(analysis.getByRole("region", { name: "시간대별 사용량" })).not.toBeVisible();
  } finally {
    releaseNewRange();
  }
});

test("hides a cached analysis after same-period refetch fails and restores it on retry", async ({ page }) => {
  let floorRequests = 0;
  await page.route("**/energy/sites/*/rankings?**", (route) => {
    const url = new URL(route.request().url());
    const dimension = url.searchParams.get("dimension") ?? "floor";
    if (dimension === "floor") {
      floorRequests += 1;
      if (floorRequests === 2 || floorRequests === 3) {
        return route.fulfill({ status: 503, json: { message: "temporarily unavailable" } });
      }
    }
    return route.fulfill({ json: ranking(dimension, url.searchParams.get("metric") ?? "usage",
      url.searchParams.get("sort") ?? "desc", url.searchParams.get("from") ?? "",
      url.searchParams.get("to") ?? "", url.pathname.split("/")[4]) });
  });

  await page.goto(`/statistics/analysis?siteId=${reportSiteId}`);
  const analysis = page.getByRole("region", { name: "사용량 분석 결과" });
  await expect(analysis.getByRole("group", { name: "현장 사용량" })).toContainText("20 kWh");
  await analysis.getByRole("button", { name: "조명", exact: true }).click();
  await expect(analysis.getByRole("region", { name: "사용량 순위" })).toContainText("B1-L01");
  await analysis.getByRole("button", { name: "층", exact: true }).click();
  await expect(analysis.getByText("사용량 분석을 불러오지 못했습니다.")).toBeVisible();
  expect(floorRequests).toBe(3);
  await expect(analysis.getByRole("group", { name: "현장 사용량" })).not.toBeVisible();
  await expect(analysis.getByRole("region", { name: "사용량 순위" })).not.toBeVisible();
  await expect(analysis.getByRole("complementary", { name: "B1 주차장 상세" })).not.toBeVisible();
  await expect(analysis.getByRole("region", { name: "시간대별 사용량" })).not.toBeVisible();

  await analysis.getByRole("button", { name: "다시 시도" }).click();
  await expect(analysis.getByRole("group", { name: "현장 사용량" })).toContainText("20 kWh");
  await expect(analysis.getByRole("region", { name: "시간대별 사용량" })).toBeVisible();
});

for (const mismatch of ["site", "range"] as const) {
  test(`rejects a custom comparison response for another ${mismatch}`, async ({ page }) => {
    await page.route("**/energy/sites/*/comparisons/range?**", (route) => {
      const url = new URL(route.request().url());
      const from = url.searchParams.get("from") ?? "";
      const to = url.searchParams.get("to") ?? "";
      const response = mismatch === "site"
        ? customComparison(from, to, "30000000-0000-4000-8000-000000000099")
        : customComparison("2026-08-01", "2026-08-07", reportSiteId);
      return route.fulfill({ json: response });
    });
    await page.goto(`/statistics/overview?siteId=${reportSiteId}`);
    await page.getByRole("button", { name: /완료 기간 날짜 범위 선택, 현재/ }).click();
    const dialog = page.getByRole("dialog", { name: "완료일 비교 기간 선택" });
    await dialog.getByRole("group", { name: "빠른 기간 선택" }).getByRole("button", { name: "최근 7일" }).click();
    await dialog.getByRole("button", { name: "선택 기간 적용" }).click();

    const comparison = page.locator('section[aria-labelledby="statistics-comparison-title"]');
    await expect(comparison.getByText("절감 비교를 불러오지 못했습니다.")).toBeVisible();
    await expect(comparison.getByRole("group", { name: "기준 및 동기간 비교" })).not.toBeVisible();
    await expect(page.getByRole("group", { name: "오늘 전력 사용량" })).toContainText("4.25 kWh");
  });
}

for (const viewport of [
  { width: 390, height: 844 },
  { width: 320, height: 740 },
  { width: 760, height: 900 }
] as const) {
  test(`${viewport.width}px control modes use the statistics underline navigation visual with optional icons`, async ({ page }) => {
    await page.setViewportSize(viewport);
    const emptyPage = { items: [], nextCursor: null };
    await page.route("**/api/sites/*/automation/schedules**", (route) => route.fulfill({ json: emptyPage }));
    await page.route("**/api/sites/*/automation/vehicle-event-rules**", (route) => route.fulfill({ json: emptyPage }));
    await page.goto("/control?siteId=site-1&mode=manual");

    const controlNavigation = page.getByRole("tablist", { name: "제어 방식" });
    const controlTabs = controlNavigation.getByRole("tab");
    await expect(controlTabs).toHaveCount(3);
    expect(await controlTabs.locator("svg").count()).toBe(3);

    const controlMetrics = await controlNavigation.evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth
    }));
    if (viewport.width === 320) {
      expect(controlMetrics.scrollWidth).toBeGreaterThan(controlMetrics.clientWidth);
    } else {
      expect(controlMetrics.scrollWidth).toBeGreaterThanOrEqual(controlMetrics.clientWidth);
    }
    for (const tab of await controlTabs.all()) {
      const bounds = await tab.boundingBox();
      expect(bounds).not.toBeNull();
      expect(bounds!.height).toBeGreaterThanOrEqual(44);
    }
    let controlVisual: Awaited<ReturnType<typeof underlineNavigationVisual>> | undefined;
    for (const [mode, label] of [["manual", "수동 제어"], ["schedule", "스케줄 제어"], ["event", "이벤트 제어"]] as const) {
      const selectedTab = controlNavigation.getByRole("tab", { name: label });
      if (mode !== "manual") await selectedTab.click();
      await expect(page).toHaveURL(new RegExp(`[?&]mode=${mode}(?:&|$)`));
      await expect(selectedTab).toHaveAttribute("aria-selected", "true");
      const modePanel = page.locator(`#control-mode-panel-${mode}`);
      await expect(modePanel).toBeVisible();

      const alignment = await underlineNavigationAlignment(controlNavigation);
      expect(Math.abs(alignment.wrapperHeight - alignment.trackHeight), `${mode} wrapper/track height`).toBeLessThanOrEqual(1);
      expect(Math.abs(alignment.trackHeight - alignment.tabHeight), `${mode} track/tab height`).toBeLessThanOrEqual(1);
      expect(Math.abs(alignment.wrapperBottom - alignment.trackBottom), `${mode} bottom alignment`).toBeLessThanOrEqual(1);
      await expect.poll(async () => {
        const currentAlignment = await underlineNavigationAlignment(controlNavigation);
        const panelTop = await modePanel.evaluate((element) => element.getBoundingClientRect().top);
        return Math.abs(panelTop - currentAlignment.wrapperBottom - 16);
      }, { message: `${mode} navigation/panel gap` }).toBeLessThanOrEqual(1);
      controlVisual ??= await underlineNavigationVisual(controlNavigation, selectedTab);
    }
    await expectNoHorizontalOverflow(page);

    await page.goto("/statistics/overview?siteId=site-1#summary");
    const statisticsNavigation = page.getByRole("navigation", { name: "통계 메뉴" });
    const selectedStatisticsLink = statisticsNavigation.getByRole("link", { name: "개요" });
    await expect(statisticsNavigation.getByRole("link")).toHaveCount(3);
    await expect(selectedStatisticsLink).toHaveAttribute("aria-current", "page");
    await expect(selectedStatisticsLink).toHaveAttribute("href", "/statistics/overview?siteId=site-1#summary");
    expect(await statisticsNavigation.locator("svg").count()).toBe(0);

    const statisticsVisual = await underlineNavigationVisual(statisticsNavigation, selectedStatisticsLink);
    expect(controlVisual).toEqual(statisticsVisual);
    await expectNoHorizontalOverflow(page);
  });
}

test("underline navigation keeps keyboard focus visible inside its overflow edge", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/control?siteId=site-1&mode=manual");

  const controlTab = page.getByRole("tab", { name: "수동 제어" });
  await controlTab.focus();
  await expect(controlTab).toBeFocused();
  expect(await controlTab.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");

  await page.goto("/statistics/overview?siteId=site-1");
  const statisticsLink = page.getByRole("link", { name: "개요" });
  await statisticsLink.focus();
  await expect(statisticsLink).toBeFocused();
  expect(await statisticsLink.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");
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
  await page.setViewportSize({ width: 320, height: 740 });
  await page.route("**/energy/sites/site-empty/summary", (route) => route.fulfill({
    contentType: "application/json",
    body: JSON.stringify(noDataSummary("site-empty"))
  }));

  await page.goto("/statistics?siteId=site-empty");
  await expect(page.getByText("아직 상태 기반 사용량을 표시할 수 없습니다.")).toBeVisible();
  await expect(page.getByText("조명 상태가 수집되면 통계가 표시됩니다.")).toBeVisible();
  await expect(page.getByLabel("오늘 전력 사용량")).toHaveCount(0);
  await expectMinimumTouchTargetsAfterScrolling(page, '[aria-label="기준 대비 사용량 비교"]');
  await page.getByRole("button", { name: "산정 불가 기간 안내" }).click();
  await expect(page.getByRole("dialog", { name: "산정 불가 기간 안내" })).toContainText("기준 사용량만 표시합니다.");
  await expectNoHorizontalOverflow(page);
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
  const viewport = { width: 1440, height: 2400 };
  await page.setViewportSize(viewport);
  await page.goto("/statistics");
  await expect(page.getByRole("heading", { name: "기준 대비 에너지 절감" })).toBeVisible();

  const [shellRect, headingRect, reportRect] = await Promise.all([
    page.getByRole("region", { name: "통계", exact: true }).boundingBox(),
    page.getByRole("heading", { name: "기준 대비 에너지 절감" }).boundingBox(),
    page.getByRole("group", { name: "사용량 및 비용" }).boundingBox()
  ]);
  if (!shellRect || !headingRect || !reportRect) throw new Error("statistics report layout is incomplete");
  const layout = {
    headingOffset: headingRect.y - shellRect.y,
    remainingViewportSpace: viewport.height - (reportRect.y + reportRect.height)
  };

  expect(layout.headingOffset).toBeGreaterThan(0);
  expect(layout.headingOffset).toBeLessThan(100);
  expect(
    layout.remainingViewportSpace,
    "intrinsic statistics content should leave proportional space below it instead of stretching to the viewport bottom"
  ).toBeGreaterThan(viewport.height * 0.1);
});

test("keeps KPI helper ranges readable without oversized cards at 320px", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/statistics");

  const cards = page.getByRole("group", { name: "에너지 요약" }).locator("[data-metric-card]");
  await expect(cards).toHaveCount(3);
  for (const card of await cards.all()) {
    const layout = await card.evaluate((element) => {
      const helper = element.querySelector("p");
      if (!helper) throw new Error("KPI helper is missing");
      const cardBounds = element.getBoundingClientRect();
      const helperBounds = helper.getBoundingClientRect();
      const lineHeight = Number.parseFloat(getComputedStyle(helper).lineHeight);
      return {
        cardHeight: cardBounds.height,
        cardWidth: element.clientWidth,
        contentWidth: element.scrollWidth,
        helperRight: helperBounds.right,
        cardRight: cardBounds.right,
        helperBottom: helperBounds.bottom,
        cardBottom: cardBounds.bottom,
        helperLines: helperBounds.height / lineHeight
      };
    });
    expect(layout.contentWidth).toBeLessThanOrEqual(layout.cardWidth + 1);
    expect(layout.helperRight).toBeLessThanOrEqual(layout.cardRight + 1);
    expect(layout.helperBottom).toBeLessThanOrEqual(layout.cardBottom + 1);
    expect(layout.helperLines).toBeLessThanOrEqual(3.1);
    expect(layout.cardHeight).toBeLessThanOrEqual(230);
  }

  const chart = page.getByRole("region", { name: "상태 기반 추정 사용량" });
  await expect(chart.getByText("결측·수집 공백")).toBeVisible();
  await expect(chart.getByText("선이 끊긴 기간은 수집 데이터가 없으며, 수집 공백이 있는 기간은 추정값이 불완전할 수 있습니다.")).toHaveCount(0);
  await expectNoHorizontalOverflow(page);
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 390, height: 844 },
  { width: 320, height: 740 }
] as const) {
  test(`keeps the statistics report responsive at ${viewport.width}px`, async ({ page }) => {
    await page.setViewportSize(viewport);
    await page.goto(`/statistics?siteId=${reportSiteId}`);
    await expect(page.getByRole("heading", { name: "기준 대비 에너지 절감" })).toBeVisible();
    await expect(page.getByRole("navigation", { name: "통계 메뉴" })).toBeVisible();
    await expect(page.getByRole("region", { name: "기준 대비 사용량 비교" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "동기간 비교" })).toBeVisible();

    const expectedColumns = viewport.width === 320 ? 1 : viewport.width === 390 ? 2 : 3;
    expect(await gridColumnCount(page)).toBe(expectedColumns);
    await expectReportPanelLayout(page, viewport.width <= 760);
    await expect(page.getByRole("region", { name: "상태 기반 추정 사용량" })).toBeVisible();
    await expect(page.getByRole("complementary", { name: "비용 비교" })).toBeVisible();
    const firstAxisLabel = page.getByRole("region", { name: "상태 기반 추정 사용량" }).locator(".recharts-cartesian-axis-tick-value").first();
    await expect(firstAxisLabel).toBeVisible();
    expect(await firstAxisLabel.evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize))).toBeGreaterThanOrEqual(11);
    await expect(page.getByRole("button", { name: "일별" })).toBeVisible();
    await expect(page.getByRole("button", { name: "월별" })).toBeVisible();
    await expectStatisticsSpacing(page, viewport.width <= 760);
    await expectComparisonPanelLayout(page, viewport.width <= 760);
    const comparisonOverflow = await page.getByRole("region", { name: "기준 대비 사용량 비교" }).evaluate((element) => ({
      clientWidth: element.clientWidth,
      scrollWidth: element.scrollWidth
    }));
    expect(comparisonOverflow.scrollWidth).toBeLessThanOrEqual(comparisonOverflow.clientWidth);
    await expectNoHorizontalOverflow(page);
    if (viewport.width <= 760) {
      await page.getByRole("heading", { name: "상태 기반 추정 사용량" }).scrollIntoViewIfNeeded();
      await expect(page.getByRole("button", { name: "일별" })).toBeInViewport();
      await expect(page.getByRole("button", { name: "월별" })).toBeInViewport();
      await expectMinimumTouchTargets(page, "[data-app-shell]");
    }

    await page.getByRole("link", { name: "사용 분석" }).click();
    await expect(page.getByRole("region", { name: "사용량 분석 결과" })).toBeVisible();
    await expect(page.getByRole("region", { name: "사용량 순위" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
}

async function expectStatisticsSpacing(page: Page, compact: boolean) {
  const screenGap = await page.getByRole("region", { name: "에너지 통계" }).evaluate((element) => {
    return getComputedStyle(element).rowGap;
  });
  expect(screenGap).toBe("20px");

  const summary = page.getByRole("group", { name: "에너지 요약" });
  const summaryGap = await summary.evaluate((element) => {
    return getComputedStyle(element).gap;
  });
  expect(summaryGap).toBe("16px");

  const chartPanel = page.getByRole("region", { name: "상태 기반 추정 사용량" });
  const panelPadding = await chartPanel.evaluate((element) => {
    return getComputedStyle(element).paddingTop;
  });
  expect(panelPadding).toBe(compact ? "16px" : "24px");

  const chartPanelGap = await chartPanel.evaluate((element) => {
    return getComputedStyle(element).gap;
  });
  expect(chartPanelGap).toBe("16px");

  const metricCardSpacing = await summary.locator("[data-metric-card]").first().evaluate((element) => {
    const styles = getComputedStyle(element);
    return { minHeight: styles.minHeight, paddingBottom: styles.paddingBottom };
  });
  expect(metricCardSpacing).toEqual({ minHeight: "0px", paddingBottom: "16px" });

  const statusPosition = await summary.getByRole("group", { name: "오늘 전력 사용량" }).locator("[data-tone=success]").evaluate((element) => {
    return getComputedStyle(element).position;
  });
  expect(statusPosition).toBe("static");

  if (compact) {
    const metricLabelWidth = await summary.locator("[data-metric-label]").first().evaluate((element) => {
      return element.getBoundingClientRect().width;
    });
    expect(metricLabelWidth).toBeGreaterThanOrEqual(100);

    const [chartTitle, chartTabs] = await Promise.all([
      page.getByRole("heading", { name: "상태 기반 추정 사용량" }).boundingBox(),
      chartPanel.getByRole("button", { name: "일별" }).boundingBox()
    ]);
    expect(chartTitle).not.toBeNull();
    expect(chartTabs).not.toBeNull();
    if (chartTitle && chartTabs) {
      expect(chartTabs.y).toBeGreaterThanOrEqual(chartTitle.y + chartTitle.height);
    }
  }
}

async function installReportHistoryFixture(page: Page) {
  let records = reportHistoryRecords();
  energyReportListResponseSchema.parse({ reports: records.slice(0, 20), nextCursor: "offset-20", totalCount: records.length });
  const createdRequests: EnergyReportJob["request"][] = [];
  let expectedListQuery: URLSearchParams | undefined;
  let lastObservedListQuery: string | undefined;
  await page.route("**/energy/sites/*/reports*", async (route) => {
    if (route.request().method() === "POST") {
      const request = route.request().postDataJSON() as EnergyReportJob["request"];
      createdRequests.push(request);
      const created = historyReport(1_000, {
        status: "queued",
        format: request.format,
        scope: request.scope,
        label: "새 보고서",
        requestedAt: "2026-09-11T12:00:00.000Z",
        request
      });
      records = [created, ...records];
      await route.fulfill({ status: 202, json: created });
      return;
    }

    const url = new URL(route.request().url());
    const actualListQuery = url.searchParams.toString();
    if (expectedListQuery) {
      const expectedQueryString = expectedListQuery.toString();
      if (actualListQuery === expectedQueryString) {
        expectedListQuery = undefined;
      } else if (actualListQuery !== lastObservedListQuery) {
        expect(
          [...url.searchParams.entries()],
          `normalized report query for ${url.pathname}`
        ).toEqual([...expectedListQuery.entries()]);
      }
    }
    lastObservedListQuery = actualListQuery;
    const query = (url.searchParams.get("query") ?? "").trim().toLocaleLowerCase("ko-KR");
    const status = url.searchParams.get("status");
    const format = url.searchParams.get("format");
    const scope = url.searchParams.get("scope");
    const requestedFrom = url.searchParams.get("requestedFrom");
    const requestedTo = url.searchParams.get("requestedTo");
    const filtered = records.filter((record) => {
      const requestedDate = record.requestedAt.slice(0, 10);
      return (!query || record.target.label.toLocaleLowerCase("ko-KR").includes(query))
        && (!status || record.status === status)
        && (!format || record.request.format === format)
        && (!scope || record.request.scope === scope)
        && (!requestedFrom || requestedDate >= requestedFrom)
        && (!requestedTo || requestedDate <= requestedTo);
    });
    const limit = Number(url.searchParams.get("limit") ?? 20);
    const cursor = url.searchParams.get("cursor");
    const offset = cursor?.startsWith("offset-") ? Number(cursor.slice("offset-".length)) : 0;
    const reports = filtered.slice(offset, offset + limit);
    const response = energyReportListResponseSchema.parse({
      reports,
      nextCursor: offset + reports.length < filtered.length ? `offset-${offset + reports.length}` : null,
      totalCount: filtered.length
    });
    await route.fulfill({ json: response });
  });
  return {
    createdRequests,
    expectNextListQuery(query: Record<string, string>) {
      expect(expectedListQuery, "previous expected report query was observed").toBeUndefined();
      expectedListQuery = new URLSearchParams(query);
    },
    expectAllListQueriesObserved() {
      expect(expectedListQuery, "all expected report queries were observed").toBeUndefined();
    }
  };
}

function reportHistoryRecords(): EnergyReportJob[] {
  return Array.from({ length: 101 }, (_, index) => {
    if (index < 3) {
      return historyReport(index, {
        status: "completed",
        format: "pdf",
        scope: "site",
        label: ["서울 본사", "서울 강남", "서울 연구소"][index],
        requestedAt: `2026-09-${String(10 - index).padStart(2, "0")}T09:00:00.000Z`
      });
    }
    if (index === 3) {
      return historyReport(index, {
        status: "completed",
        format: "pdf",
        scope: "site",
        label: "부산 검색 조건 불일치",
        requestedAt: "2026-09-10T09:00:00.000Z"
      });
    }
    if (index === 4) return historyReport(index, {
      status: "failed", format: "pdf", scope: "site", label: "서울 상태 조건 불일치", requestedAt: "2026-09-10T09:00:00.000Z"
    });
    if (index === 5) return historyReport(index, {
      status: "completed", format: "xlsx", scope: "site", label: "서울 형식 조건 불일치", requestedAt: "2026-09-10T09:00:00.000Z"
    });
    if (index === 6) return historyReport(index, {
      status: "completed", format: "pdf", scope: "floor", label: "서울 범위 조건 불일치", requestedAt: "2026-09-10T09:00:00.000Z"
    });
    if (index === 7) return historyReport(index, {
      status: "completed", format: "pdf", scope: "site", label: "서울 시작일 조건 불일치", requestedAt: "2026-09-07T09:00:00.000Z"
    });
    if (index === 8) return historyReport(index, {
      status: "completed", format: "pdf", scope: "site", label: "서울 종료일 조건 불일치", requestedAt: "2026-09-11T09:00:00.000Z"
    });
    const formats = ["xlsx", "pdf"] as const;
    const scopes = ["site", "floor", "group", "fixture"] as const;
    return historyReport(index, {
      status: index % 19 === 0 ? "processing" : index % 17 === 0 ? "queued" : "completed",
      format: formats[index % formats.length],
      scope: scopes[index % scopes.length],
      label: `부산 보고서 ${String(index + 1).padStart(3, "0")}`,
      requestedAt: new Date(Date.parse("2026-09-07T08:00:00.000Z") - index * 3_600_000).toISOString()
    });
  });
}

function historyReport(index: number, options: {
  status: EnergyReportJob["status"];
  format: "xlsx" | "pdf";
  scope: EnergyReportJob["request"]["scope"];
  label: string;
  requestedAt: string;
  request?: EnergyReportJob["request"];
}): EnergyReportJob {
  const identityId = options.scope === "site"
    ? reportSiteId
    : `50000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
  const request = options.request ?? {
    from: "2026-08-01",
    to: "2026-08-31",
    scope: options.scope,
    identityId,
    format: options.format
  };
  const report = browserReport(options.status, options.format, request);
  return {
    ...report,
    reportId: `40000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    createdAt: options.requestedAt,
    requestedAt: options.requestedAt,
    startedAt: options.status === "queued" ? null : options.requestedAt,
    completedAt: options.status === "completed" || options.status === "expired" ? options.requestedAt : null,
    expiresAt: options.status === "completed" ? "2026-10-01T00:00:00.000Z"
      : options.status === "expired" ? "2026-09-01T00:00:00.000Z" : null,
    target: { scope: request.scope, identityId: request.identityId, label: options.label }
  };
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
    ranked: [{
      identityId: "30000000-0000-4000-8000-000000000020",
      operationalId: "30000000-0000-4000-8000-000000000020",
      name,
      rank: 1,
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
    }],
    unranked: []
  };
}

async function gridColumnCount(page: Page) {
  return page.getByRole("group", { name: "에너지 요약" }).locator(":scope > *").evaluateAll((elements) => {
    return new Set(elements.map((element) => Math.round(element.getBoundingClientRect().x))).size;
  });
}

async function chooseOption(page: Page, container: Locator, label: string, option: string) {
  await container.getByRole("button", { name: label, exact: true }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function expectLocatorTouchTarget(target: Locator, label: string) {
  await target.scrollIntoViewIfNeeded();
  await expect(target, `${label} is enabled`).toBeEnabled();
  const bounds = await target.boundingBox();
  expect(bounds, `${label} exists`).not.toBeNull();
  expect(bounds!.width, `${label} width`).toBeGreaterThanOrEqual(44);
  expect(bounds!.height, `${label} height`).toBeGreaterThanOrEqual(44);
}

async function setDatePicker(container: Locator, label: string, value: string) {
  const [year, month, day] = value.split("-");
  const segments = container.getByRole("group", { name: label }).getByRole("spinbutton");
  await segments.nth(2).fill(String(Number(day)));
  await segments.nth(1).fill(String(Number(month)));
  await segments.nth(0).fill(year);
}

async function setDateRangePicker(container: Locator, label: string, start: string, end: string) {
  await container.getByRole("button", { name: /요청 기간 선택, 현재/ }).click();
  const dialog = container.page().getByRole("dialog", { name: "요청 기간 선택" });
  const segments = dialog.getByRole("group", { name: label }).getByRole("spinbutton");
  for (const [offset, value] of [[0, start], [3, end]] as const) {
    const [year, month, day] = value.split("-");
    await segments.nth(offset + 2).fill(String(Number(day)));
    await segments.nth(offset + 1).fill(String(Number(month)));
    await segments.nth(offset).fill(year);
  }
  await dialog.getByRole("button", { name: "완료", exact: true }).click();
}

async function expectDatePicker(container: Locator, label: string, value: string) {
  const [year, month, day] = value.split("-").map(Number);
  const segments = container.getByRole("group", { name: label }).getByRole("spinbutton");
  await expect(segments.nth(0)).toHaveAttribute("aria-valuenow", String(year));
  await expect(segments.nth(1)).toHaveAttribute("aria-valuenow", String(month));
  await expect(segments.nth(2)).toHaveAttribute("aria-valuenow", String(day));
}

async function underlineNavigationVisual(container: Locator, item: Locator) {
  const [containerVisual, itemVisual] = await Promise.all([
    container.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderBottomWidth: style.borderBottomWidth,
        borderLeftWidth: style.borderLeftWidth,
        borderRadius: style.borderRadius,
        borderRightWidth: style.borderRightWidth,
        borderTopWidth: style.borderTopWidth,
        padding: style.padding
      };
    }),
    item.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        backgroundColor: style.backgroundColor,
        borderBottomColor: style.borderBottomColor,
        borderBottomWidth: style.borderBottomWidth,
        borderRadius: style.borderRadius,
        boxShadow: style.boxShadow,
        color: style.color,
        height: element.getBoundingClientRect().height,
        padding: style.padding
      };
    })
  ]);
  return { container: containerVisual, item: itemVisual };
}

async function underlineNavigationAlignment(container: Locator) {
  return container.evaluate((element) => {
    const track = element.querySelector<HTMLElement>("[data-navigation-track]") ?? element;
    const selected = element.querySelector<HTMLElement>("[role='tab'][aria-selected='true']");
    if (!selected) throw new Error("underline navigation layout is incomplete");
    const wrapperRect = element.getBoundingClientRect();
    const trackRect = track.getBoundingClientRect();
    const tabRect = selected.getBoundingClientRect();
    return {
      wrapperHeight: wrapperRect.height,
      wrapperBottom: wrapperRect.bottom,
      trackHeight: trackRect.height,
      trackBottom: trackRect.bottom,
      tabHeight: tabRect.height
    };
  });
}

async function expectReportPanelLayout(page: Page, stacked: boolean) {
  const [chart, costs] = await Promise.all([
    page.getByRole("region", { name: "상태 기반 추정 사용량" }).boundingBox(),
    page.getByRole("complementary", { name: "비용 비교" }).boundingBox()
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
    page.getByRole("region", { name: "기준 대비 사용량 비교" }).boundingBox(),
    page.getByRole("complementary", { name: "동기간 비교" }).boundingBox()
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
