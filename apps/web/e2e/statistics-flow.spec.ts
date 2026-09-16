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
  await page.goto(`/statistics/reports?siteId=${reportSiteId}`);

  const pagination = page.getByRole("navigation", { name: "페이지 이동" });
  await expect(pagination.getByRole("status")).toContainText("1~20 / 101건");
  await expect(page.getByRole("table", { name: "보고서 생성 이력" }).locator("tbody tr")).toHaveCount(20);

  await pagination.getByRole("button", { name: "다음 페이지" }).click();
  await expect(pagination.getByRole("status")).toContainText("21~40 / 101건");
  await pagination.getByRole("button", { name: "이전 페이지" }).click();
  await expect(pagination.getByRole("status")).toContainText("1~20 / 101건");

  await chooseOption(page, pagination, "페이지당 항목 수", "50개");
  await expect(pagination.getByRole("status")).toContainText("1~50 / 101건");
  await chooseOption(page, pagination, "페이지당 항목 수", "100개");
  await expect(pagination.getByRole("status")).toContainText("1~100 / 101건");

  const filters = page.getByRole("search", { name: "보고서 이력 필터" });
  await filters.getByRole("searchbox", { name: "보고서 검색" }).fill(" 서울 ");
  await chooseOption(page, filters, "상태", "완료");
  await chooseOption(page, filters, "파일 형식", "PDF");
  await chooseOption(page, filters, "범위", "현장");
  await setDateRangePicker(filters, "요청 기간", "2026-09-08", "2026-09-10");
  await expect(pagination.getByRole("status")).toContainText("1~3 / 3건");
  await expect(page.getByRole("table", { name: "보고서 생성 이력" }).getByText("서울 본사")).toBeVisible();
  await expect(page).toHaveURL(/query=%EC%84%9C%EC%9A%B8/);

  await page.reload();
  await expect(filters.getByRole("searchbox", { name: "보고서 검색" })).toHaveValue("서울");
  await expect(filters.getByRole("button", { name: "상태", exact: true })).toContainText("완료");
  await expect(filters.getByRole("button", { name: "파일 형식", exact: true })).toContainText("PDF");
  await expect(filters.getByRole("button", { name: "범위", exact: true })).toContainText("현장");
  await expect(pagination.getByRole("status")).toContainText("1~3 / 3건");

  await filters.getByRole("button", { name: "검색: 서울 조건 제거" }).click();
  await expect(filters.getByRole("searchbox", { name: "보고서 검색" })).toHaveValue("");
  await removeAllReportFilterChips(filters);
  await expect(pagination.getByRole("status")).toContainText("1~100 / 101건");
  await expect(filters.getByLabel("활성 조건")).toHaveCount(0);

  await pagination.getByRole("button", { name: "다음 페이지" }).click();
  await expect(pagination.getByRole("status")).toContainText("101~101 / 101건");
  await page.getByRole("button", { name: "보고서 만들기" }).click();
  await page.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" }).getByRole("button", { name: "보고서 요청" }).click();
  await expect(pagination.getByRole("status")).toContainText("1~100 / 102건");
  await expect(page.getByRole("region", { name: "요청한 보고서" }).getByText("대기 중", { exact: true }).first()).toBeVisible();
  expect(fixture.createdRequests).toHaveLength(1);

  await filters.getByRole("searchbox", { name: "보고서 검색" }).fill("존재하지 않는 대상");
  await expect(page.getByText("요청한 보고서가 없습니다.")).toBeVisible();
  await expect(pagination.getByRole("status")).toContainText("0건");
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
    await page.goto(`/statistics/reports?siteId=${reportSiteId}`);

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
    const touchTargets = [
      filters.getByRole("searchbox", { name: "보고서 검색" }),
      filters.getByRole("button", { name: "상태" }),
      filters.getByRole("button", { name: "파일 형식" }),
      filters.getByRole("button", { name: "범위" }),
      filters.getByRole("group", { name: "요청 기간" }),
      pagination.getByRole("button", { name: "페이지당 항목 수" }),
      pagination.getByRole("button", { name: "이전 페이지" }),
      pagination.getByRole("button", { name: "다음 페이지" }),
      page.getByRole("button", { name: /보고서 (다운로드|다시 생성)$/ }).first()
    ];
    for (const target of touchTargets) {
      await target.scrollIntoViewIfNeeded();
      const bounds = await target.boundingBox();
      expect(bounds, `${viewport.width}px target exists`).not.toBeNull();
      expect(bounds!.width, `${viewport.width}px target width`).toBeGreaterThanOrEqual(44);
      expect(bounds!.height, `${viewport.width}px target height`).toBeGreaterThanOrEqual(44);
    }

    const next = pagination.getByRole("button", { name: "다음 페이지" });
    await next.focus();
    await expect(next).toBeFocused();
    expect(await next.evaluate((element) => getComputedStyle(element).boxShadow)).not.toBe("none");

    await page.getByRole("button", { name: "부산 실패 현장 실패 상세 보기" }).click();
    await expect(page.getByRole("region", { name: "부산 실패 현장 실패 안내" })).toContainText("보고서를 생성하지 못했습니다.");
    await next.click();
    await expect(pagination.getByRole("status")).toContainText("21~40 / 101건");
    await expectNoHorizontalOverflow(page);
  });
}

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
    const sunday00 = energyGrid.getByRole("button", { name: "일요일 00시, 0 kWh", exact: true });
    await sunday00.focus();
    await page.keyboard.press("ArrowRight");
    const sunday01 = energyGrid.getByRole("button", { name: "일요일 01시, 수집 데이터 없음", exact: true });
    await expect(sunday01).toBeFocused();
    await expect(sunday01).toHaveAttribute("aria-pressed", "true");
    await page.keyboard.press("End");
    const sunday23 = energyGrid.getByRole("button", { name: "일요일 23시, 0.5 kWh", exact: true });
    await expect(sunday23).toBeFocused();
    await page.keyboard.press("ArrowDown");
    const monday23 = energyGrid.getByRole("button", { name: "월요일 23시, 0.5 kWh", exact: true });
    await expect(monday23).toBeFocused();
    await page.keyboard.press("Home");
    const monday00 = energyGrid.getByRole("button", { name: "월요일 00시, 0.5 kWh", exact: true });
    await expect(monday00).toBeFocused();
    await page.keyboard.press("ArrowLeft");
    await expect(monday00).toBeFocused();
    await expect(page.getByRole("status").filter({ hasText: "월요일 00시, 0.5 kWh" })).toBeVisible();
    await energyGrid.getByRole("button", { name: "일요일 00시, 0 kWh", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "일요일 00시, 0 kWh" })).toBeVisible();
    const missing = energyGrid.getByRole("button", { name: "일요일 01시, 수집 데이터 없음", exact: true });
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

  const partialDot = page.getByRole("region", { name: "상태 기반 추정 사용량" }).locator(".recharts-line-dots circle").nth(1);
  await partialDot.hover();
  await expect(page.getByText("수집 공백 2시간 0분", { exact: true })).toBeVisible();

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
  const viewport = { width: 1440, height: 2400 };
  await page.setViewportSize(viewport);
  await page.goto("/statistics");
  await expect(page.getByRole("heading", { name: "에너지 리포트" })).toBeVisible();

  const [shellRect, headingRect, reportRect] = await Promise.all([
    page.getByRole("region", { name: "통계", exact: true }).boundingBox(),
    page.getByRole("heading", { name: "에너지 리포트" }).boundingBox(),
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
    await expect(page.getByRole("heading", { name: "사용량 분석" })).toBeVisible();
    await expect(page.getByRole("region", { name: "사용량 순위" })).toBeVisible();
    await expectNoHorizontalOverflow(page);
  });
}

async function expectStatisticsSpacing(page: Page, compact: boolean) {
  const screenGap = await page.getByRole("region", { name: "에너지 통계" }).evaluate((element) => {
    return getComputedStyle(element).rowGap;
  });
  expect(screenGap).toBe("24px");

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
  return { createdRequests };
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
        status: "failed",
        format: "xlsx",
        scope: "site",
        label: "부산 실패 현장",
        requestedAt: "2026-09-07T09:00:00.000Z"
      });
    }
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
  return page.getByRole("group", { name: "에너지 요약" }).locator(":scope > *").evaluateAll((elements) => {
    return new Set(elements.map((element) => Math.round(element.getBoundingClientRect().x))).size;
  });
}

async function chooseOption(page: Page, container: Locator, label: string, option: string) {
  await container.getByRole("button", { name: label }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function setDatePicker(container: Locator, label: string, value: string) {
  const [year, month, day] = value.split("-");
  const segments = container.getByRole("group", { name: label }).getByRole("spinbutton");
  await segments.nth(2).fill(String(Number(day)));
  await segments.nth(1).fill(String(Number(month)));
  await segments.nth(0).fill(year);
}

async function setDateRangePicker(container: Locator, label: string, start: string, end: string) {
  const segments = container.getByRole("group", { name: label }).getByRole("spinbutton");
  for (const [offset, value] of [[0, start], [3, end]] as const) {
    const [year, month, day] = value.split("-");
    await segments.nth(offset + 2).fill(String(Number(day)));
    await segments.nth(offset + 1).fill(String(Number(month)));
    await segments.nth(offset).fill(year);
  }
}

async function removeAllReportFilterChips(filters: Locator) {
  const chips = filters.getByRole("button", { name: /조건 제거$/ });
  while (await chips.count()) await chips.first().click();
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
