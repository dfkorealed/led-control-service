import { expect, test, type Locator, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { EnergyReportJob } from "@led-control/shared/energy-p2-contracts";
import {
  expectMinimumTouchTargets,
  expectMinimumTouchTargetsAfterScrolling,
  expectNoHorizontalOverflow
} from "./support/layout-assertions";

const generatedAt = "2026-08-26T00:00:00.000Z";
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
  await page.route("**/energy/sites/*/rankings?**", (route) => {
    const url = new URL(route.request().url());
    return route.fulfill({
      contentType: "application/json",
      body: JSON.stringify(ranking(
        url.searchParams.get("dimension") ?? "floor",
        url.searchParams.get("metric") ?? "usage",
        url.searchParams.get("sort") ?? "desc",
        url.searchParams.get("from") ?? "2026-08-01",
        url.searchParams.get("to") ?? "2026-08-31"
      ))
    });
  });
  await page.route("**/energy/sites/*/heatmap?**", route => route.fulfill({ json: heatmap(new URL(route.request().url())) }));
  await page.route("**/energy/sites/*/reports", route => route.fulfill({ json: { reports: [] } }));
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
  return { siteId: reportSiteId, timeZone: "Asia/Seoul", generatedAt, metric: url.searchParams.get("metric") ?? "energy",
    scope: url.searchParams.get("scope") ?? "floor", identityId: url.searchParams.get("identityId"),
    range: { from: url.searchParams.get("from"), to: url.searchParams.get("to") },
    cells: Array.from({ length: 168 }, (_, index) => ({ weekday: Math.floor(index / 24), hour: index % 24,
      value: index === 1 ? null : index === 0 ? 0 : url.searchParams.get("metric") === "brightness" ? 50 : 0.5 })) };
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
    { encoding: "utf8", maxBuffer: 30 * 1024 * 1024 })) as Record<"xlsx" | "pdf", { bytes: string; manifest: unknown }> & { expected: unknown };
  expect(fixtures.xlsx.manifest).toEqual(fixtures.expected);
  expect(fixtures.pdf.manifest).toEqual(fixtures.expected);
  expect(fixtures.xlsx.manifest).toEqual(fixtures.pdf.manifest);
  expect(JSON.stringify(fixtures.expected)).toContain("187.50 원");
  expect(JSON.stringify(fixtures.expected)).toContain("조명 💡");
  expect(JSON.stringify(fixtures.expected)).not.toMatch(/상태 기반 추정|예상|추정|coverage|known|unknown|forecast|baseline|탄소|배출|carbon|emission|최적화/i);
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
  await page.route("**/energy/sites/*/reports", async route => {
    if (route.request().method() === "POST") {
      const request = route.request().postDataJSON(); requests.push(request);
      const job = browserReport("queued", request.format, request);
      records = [job]; await route.fulfill({ status: 202, json: job });
    } else await route.fulfill({ json: { reports: records } });
  });
  await page.route("**/energy/sites/*/reports/*/download", route => {
    downloadRequests++;
    const job = records[0];
    return route.fulfill({ json: { reportId: job.reportId, format: job.request.format, expiresInSeconds: 300,
      downloadUrl: `${downloadOrigin}/report.${job.request.format}?signature=fresh-${downloadRequests}` } });
  });
  await page.goto(`/statistics/reports?siteId=${reportSiteId}`);
  await expect(page.getByText("요청한 보고서가 없습니다.")).toBeVisible();
  for (const format of ["xlsx", "pdf"] as const) {
    await page.getByRole("button", { name: "보고서 만들기" }).click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("기간 시작").fill("2026-09-01");
    await dialog.getByLabel("기간 종료").fill("2026-09-07");
    await dialog.getByLabel("파일 형식").selectOption(format);
    await dialog.getByRole("button", { name: "보고서 요청" }).click();
    await expect(page.getByText("대기 중", { exact: true })).toBeVisible();
    expect(downloadRequests).toBe(format === "xlsx" ? 0 : 1);
    records = [browserReport("processing", format)];
    await page.clock.runFor(3000);
    await expect(page.getByText("생성 중 40%")).toBeVisible();
    records = [browserReport("completed", format)];
    await page.clock.runFor(3000);
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: /보고서 다운로드$/ }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(`report.${format}`);
    expect(await readFile((await file.path())!)).toEqual(Buffer.from(fixtures[format].bytes, "base64"));
    await expect(page.locator(".statistics-reports-screen")).not.toContainText(/예상|추정|coverage|known|unknown|forecast|baseline|탄소|배출|최적화/i);
  }
  expect(requests).toEqual([browserReport("queued", "xlsx").request, browserReport("queued", "pdf").request]);
  for (const status of ["failed", "expired"] as const) {
    records = [browserReport(status, "pdf")];
    await page.reload();
    await expect(page.getByText(status === "failed" ? "생성 실패" : "만료됨", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: /보고서 다시 생성$/ }).click();
    await expect(page.getByText("대기 중", { exact: true })).toBeVisible();
    expect(requests.at(-1)).toEqual(browserReport("queued", "pdf").request);
  }
  expect(downloadRequests).toBe(2);
  await expect(page.getByRole("navigation", { name: "통계 메뉴" }).getByRole("link")).toHaveText(["개요", "사용 분석", "보고서"]);
});

test("selects analytics fixture/group history and bounds dates to the site's completed day", async ({ page }) => {
  const requests: Array<{ scope: string; identityId: string; to: string }> = [];
  await page.route("**/energy/sites/*/reports", async route => {
    if (route.request().method() === "POST") {
      const request = route.request().postDataJSON(); requests.push(request);
      await route.fulfill({ status: 202, json: browserReport("queued", request.format, request) });
    } else await route.fulfill({ json: { reports: [] } });
  });
  await page.goto(`/statistics/reports?siteId=${reportSiteId}`);
  for (const [scope, identityId] of [["fixture", "30000000-0000-4000-8000-000000000021"], ["group", "30000000-0000-4000-8000-000000000031"]]) {
    await page.getByRole("button", { name: "보고서 만들기" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByLabel("기간 종료")).toHaveValue("2026-09-11");
    await expect(dialog.getByLabel("기간 종료")).toHaveAttribute("max", "2026-09-11");
    await dialog.getByLabel("범위").selectOption(scope);
    await expect(dialog.getByLabel("대상")).toHaveValue(identityId);
    await dialog.getByRole("button", { name: "보고서 요청" }).click();
    await expect(dialog).not.toBeVisible();
    expect(requests.at(-1)).toMatchObject({ scope, identityId, to: "2026-09-11" });
  }
});

for (const width of [1440, 1024, 390, 320]) {
  test(`heatmap and report controls remain usable without document overflow at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`/statistics/analysis?siteId=${reportSiteId}`);
    const grid = page.getByRole("group", { name: "시간대별 에너지 사용량" });
    await expect(grid.getByRole("button")).toHaveCount(168);
    await grid.getByRole("button", { name: "일요일 00시, 0 kWh", exact: true }).click();
    await expect(page.locator(".statistics-heatmap-detail")).toHaveText("일요일 00시, 0 kWh");
    const missing = grid.getByRole("button", { name: "일요일 01시, 수집 데이터 없음", exact: true });
    await missing.focus(); await page.keyboard.press("Enter");
    await expect(missing).toHaveAttribute("aria-pressed", "true");
    await page.getByRole("button", { name: "밝기", exact: true }).click();
    await expect(page.getByRole("group", { name: "시간대별 밝기" })).toBeVisible();
    const cells = await page.locator(".statistics-heatmap-grid button").evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect(); return { width: rect.width, height: rect.height };
    }));
    expect(cells.every(cell => cell.width >= 44 && cell.height >= 44)).toBe(true);
    await expectNoHorizontalOverflow(page);
    await page.locator(".statistics-heatmap-metric-button").first().scrollIntoViewIfNeeded();
    await expectMinimumTouchTargets(page, ".statistics-heatmap-heading");
    for (const index of [0, 23, 167]) {
      const cell = page.locator(".statistics-heatmap-grid button").nth(index);
      await cell.scrollIntoViewIfNeeded();
      await expectMinimumTouchTargets(page, `.statistics-heatmap-grid button:nth-child(${index + 1})`);
    }
    const heatmapPath = testInfo.outputPath(`heatmap-${width}.png`);
    await page.screenshot({ path: heatmapPath });
    await testInfo.attach(`heatmap-${width}`, { path: heatmapPath, contentType: "image/png" });
    const narrowTargetLabel = "320픽셀에서도 온전히 보이는 매우 긴 보고서 대상 이름";
    if (width === 320) {
      await page.route("**/energy/sites/*/reports", route => route.fulfill({ json: { reports: [{
        ...browserReport("completed"),
        target: { scope: "site", identityId: reportSiteId, label: narrowTargetLabel }
      }] } }));
    }
    await page.getByRole("link", { name: "보고서", exact: true }).click();
    if (width === 320) {
      const report = page.getByRole("article", { name: `${narrowTargetLabel} 보고서` });
      await expect(report).toBeVisible();
      await expect(report.getByRole("button", { name: `${narrowTargetLabel} 보고서 다운로드` })).toBeVisible();
      const wrapping = await report.getByRole("group", { name: "보고서 메타데이터" }).evaluate((metadata) => {
        const bounds = metadata.getBoundingClientRect();
        const itemBounds = Array.from(metadata.children, child => child.getBoundingClientRect());
        return {
          flexWrap: getComputedStyle(metadata).flexWrap,
          rowCount: new Set(itemBounds.map(item => Math.round(item.top))).size,
          insideCard: itemBounds.every(item => item.right <= bounds.right + 1)
        };
      });
      expect(wrapping).toMatchObject({ flexWrap: "wrap", insideCard: true });
      expect(wrapping.rowCount).toBeGreaterThanOrEqual(2);
      await expectNoHorizontalOverflow(page);
    }
    await page.getByRole("button", { name: "보고서 만들기" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog.getByRole("button", { name: "CSV 내보내기" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
    const controls = dialog.locator("button,input,select");
    for (const control of await controls.all()) {
      await control.scrollIntoViewIfNeeded();
      const bounds = await control.boundingBox();
      expect(bounds?.width).toBeGreaterThanOrEqual(44); expect(bounds?.height).toBeGreaterThanOrEqual(44);
    }
    await expectMinimumTouchTargetsAfterScrolling(page, ".statistics-report-dialog");
    const reportPath = testInfo.outputPath(`report-dialog-${width}.png`);
    await page.screenshot({ path: reportPath });
    await testInfo.attach(`report-dialog-${width}`, { path: reportPath, contentType: "image/png" });
  });
}

test("navigates to usage analysis and drills into fixture, floor, and group rankings", async ({ page }) => {
  await page.goto("/statistics/overview?siteId=site-1");
  await page.getByRole("link", { name: "사용 분석" }).click();
  await expect(page).toHaveURL(/\/statistics\/analysis\?siteId=site-1$/);
  await expect(page.getByRole("heading", { name: "사용량 분석" })).toBeVisible();
  await expect(page.getByRole("region", { name: "사용량 순위" })).toContainText("B1 주차장");
  await expect(page.getByRole("complementary", { name: "B1 주차장 상세" })).toBeVisible();

  const groupRequest = page.waitForRequest((request) => request.url().includes("dimension=group"));
  await page.getByRole("button", { name: "그룹" }).click();
  await groupRequest;
  await expect(page.getByText(/그룹 중복 소속/)).toBeVisible();
  await expectNoHorizontalOverflow(page);
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
    if (viewport.width <= 390) {
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
  expect(await controlTab.evaluate((element) => getComputedStyle(element).boxShadow)).toContain("inset");

  await page.goto("/statistics/overview?siteId=site-1");
  const statisticsLink = page.getByRole("link", { name: "개요" });
  await statisticsLink.focus();
  await expect(statisticsLink).toBeFocused();
  expect(await statisticsLink.evaluate((element) => getComputedStyle(element).boxShadow)).toContain("inset");
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

    await page.getByRole("link", { name: "사용 분석" }).click();
    await expect(page.getByRole("heading", { name: "사용량 분석" })).toBeVisible();
    await expect(page.getByRole("region", { name: "사용량 순위" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
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

function ranking(dimension: string, metric: string, sort: string, from: string, to: string) {
  const name = dimension === "group" ? "출입구 그룹" : dimension === "fixture" ? "B1-L01" : "B1 주차장";
  return {
    siteId: "30000000-0000-4000-8000-000000000001",
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
      dailyPoints: [{ period: "2026-09-10", estimatedKwh: 1.3, dataStatus: "available" }],
      fixtures: [{ identityId: "30000000-0000-4000-8000-000000000002", name: "B1-L01", estimatedKwh: 2.1 }]
    }],
    unranked: []
  };
}

async function gridColumnCount(page: Page) {
  return page.locator(".statistics-summary").evaluate((element) => {
    return getComputedStyle(element).gridTemplateColumns.split(" ").length;
  });
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
    const track = element.querySelector<HTMLElement>(".ui-underline-navigation-track") ?? element;
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
