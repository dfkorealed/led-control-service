import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createEnergyReport,
  downloadEnergyReport,
  downloadEnergyCsv,
  energyReportRequestErrorMessage,
  useEnergyComparison,
  useEnergyHeatmap,
  useEnergyRankings,
  useEnergyReports,
  useEnergyReportTargets,
  useEnergySeries,
  useEnergySummary
} from "./energy";
import { ApiError } from "./client";

const { apiGet, apiPost } = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));

vi.mock("./client", async (importOriginal) => ({
  ...await importOriginal<typeof import("./client")>(),
  apiGet,
  apiPost
}));

function wrapperFor(client: QueryClient) {
  return function QueryWrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("energy queries", () => {
  beforeEach(() => {
    apiGet.mockReset();
    apiPost.mockReset();
  });
  it("loads strict analytics targets in a dedicated tenant-isolated cache", async () => {
    const targets = { siteId: reportJob.siteId, timeZone: "Asia/Seoul", lastCompletedDate: "2026-09-11",
      targets: [{ scope: "site", identityId: reportJob.siteId, label: "현장" }] };
    apiGet.mockResolvedValue(targets);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const hook = renderHook(() => useEnergyReportTargets(reportJob.siteId), { wrapper: wrapperFor(client) });
    await waitFor(() => expect(hook.result.current.data).toEqual(targets));
    expect(apiGet).toHaveBeenCalledWith(`/energy/sites/${reportJob.siteId}/report-targets`);
    expect(client.getQueryData(["energy-report-targets", reportJob.siteId])).toEqual(targets);
    hook.unmount(); client.clear();
  });

  it("loads a site-scoped summary and isolates its cache by site", async () => {
    apiGet.mockResolvedValue({ siteId: "site-2" });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    renderHook(() => useEnergySummary("site-2"), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/energy/sites/site-2/summary"));
    expect(client.getQueryCache().find({ queryKey: ["energy-summary", "site-2"] })).toBeDefined();
  });

  it("includes site, granularity and inclusive range in the series request and cache key", async () => {
    apiGet.mockResolvedValue({ points: [] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    renderHook(() => useEnergySeries({
      siteId: "site/2",
      granularity: "day",
      from: "2026-08-01",
      to: "2026-08-31",
      enabled: true
    }), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(apiGet).toHaveBeenCalledWith(
      "/energy/sites/site%2F2/series?granularity=day&from=2026-08-01&to=2026-08-31"
    ));
    expect(client.getQueryCache().find({
      queryKey: ["energy-series", "site/2", "day", "2026-08-01", "2026-08-31"]
    })).toBeDefined();
  });

  it("does not call the API until the required identifiers and range are ready", async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    renderHook(() => useEnergySummary(undefined), { wrapper: wrapperFor(client) });
    renderHook(() => useEnergySeries({
      siteId: undefined,
      granularity: "month",
      from: "",
      to: "",
      enabled: false
    }), { wrapper: wrapperFor(client) });

    await Promise.resolve();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it("creates and polls report jobs without putting signed download URLs in the report cache", async () => {
    apiPost.mockResolvedValue(reportJob);
    apiGet.mockResolvedValue({ reports: [reportJob] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    await expect(createEnergyReport("site/2", reportJob.request)).resolves.toEqual(reportJob);
    renderHook(() => useEnergyReports("site/2"), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(apiGet).toHaveBeenCalledWith("/energy/sites/site%2F2/reports"));
    expect(apiPost).toHaveBeenCalledWith("/energy/sites/site%2F2/reports", reportJob.request);
    expect(client.getQueryData(["energy-reports", "site/2"])).toEqual({ reports: [reportJob] });
    expect(JSON.stringify(client.getQueryData(["energy-reports", "site/2"]))).not.toContain("downloadUrl");
  });

  it("gets a completed report's signed URL only on download action", async () => {
    apiGet.mockResolvedValue({
      reportId: reportJob.reportId,
      format: "xlsx",
      downloadUrl: "https://reports.example.test/signed.xlsx",
      expiresInSeconds: 300
    });

    await expect(downloadEnergyReport("site/2", reportJob.reportId)).resolves.toEqual(expect.objectContaining({
      downloadUrl: "https://reports.example.test/signed.xlsx"
    }));
    expect(apiGet).toHaveBeenCalledWith(`/energy/sites/site%2F2/reports/${reportJob.reportId}/download`);
  });

  it("releases the CSV blob URL and temporary anchor when a browser click throws", async () => {
    const createDescriptor = Object.getOwnPropertyDescriptor(URL, "createObjectURL");
    const revokeDescriptor = Object.getOwnPropertyDescriptor(URL, "revokeObjectURL");
    const revoke = vi.fn();
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: () => "blob:csv-failure" });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revoke });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["csv"]) }));
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => { throw new Error("click failed"); });
    try {
      await expect(downloadEnergyCsv(reportJob.siteId, reportJob.request)).rejects.toThrow("click failed");
      expect(document.querySelector('a[href="blob:csv-failure"]')).toBeNull();
      expect(revoke).toHaveBeenCalledWith("blob:csv-failure");
    } finally {
      click.mockRestore(); vi.unstubAllGlobals();
      if (createDescriptor) Object.defineProperty(URL, "createObjectURL", createDescriptor); else Reflect.deleteProperty(URL, "createObjectURL");
      if (revokeDescriptor) Object.defineProperty(URL, "revokeObjectURL", revokeDescriptor); else Reflect.deleteProperty(URL, "revokeObjectURL");
      document.querySelector('a[href="blob:csv-failure"]')?.remove();
    }
  });

  it("preserves the CSV response status as an ApiError", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(
      JSON.stringify({ message: "scope not found" }),
      { status: 404, headers: { "Content-Type": "application/json" } }
    )));
    try {
      await expect(downloadEnergyCsv(reportJob.siteId, reportJob.request)).rejects.toMatchObject({
        name: "ApiError",
        status: 404,
        body: { message: "scope not found" }
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it.each([
    ["create", 400, "보고서 요청 입력을 확인해 주세요. 기간·대상·지원 문자를 수정한 뒤 다시 시도해 주세요."],
    ["create", 422, "보고서 요청 입력을 확인해 주세요. 기간·대상·지원 문자를 수정한 뒤 다시 시도해 주세요."],
    ["regenerate", 404, "다시 생성할 보고서의 대상 또는 이력을 찾을 수 없습니다. 새 조건으로 요청해 주세요."],
    ["download", 404, "보고서 파일이 없거나 만료되었습니다. 다시 생성해 주세요."],
    ["csv", 404, "CSV 대상 또는 이력을 찾을 수 없습니다. 대상을 다시 선택해 주세요."],
    ["create", 409, "보고서 요청이 현재 상태와 충돌했습니다. 삭제 또는 동일 요청 처리가 끝난 뒤 다시 시도해 주세요."],
    ["download", 503, "서버에서 보고서 다운로드를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요."]
  ] as const)("maps %s API status %s without exposing server details", (action, status, expected) => {
    expect(energyReportRequestErrorMessage(
      new ApiError("request failed", status, { message: "raw storage path /secret/key" }),
      action
    )).toBe(expected);
  });

  it("distinguishes fetch failures from API and unexpected client errors", () => {
    expect(energyReportRequestErrorMessage(new TypeError("Failed to fetch"), "csv")).toBe(
      "네트워크 연결을 확인한 뒤 CSV 내보내기를 다시 시도해 주세요."
    );
    expect(energyReportRequestErrorMessage(new Error("invalid response"), "create")).toBe(
      "보고서 요청을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요."
    );
  });

  it.each(["completed", "failed", "expired"])("polls active reports at three seconds and stops after %s", async terminal => {
    vi.useFakeTimers();
    apiGet.mockResolvedValueOnce({ reports: [reportJob] })
      .mockResolvedValueOnce({ reports: [{ ...reportJob, status: "processing", progressPercent: 40 }] })
      .mockResolvedValue({ reports: [{ ...reportJob, status: terminal, progressPercent: terminal === "failed" ? 0 : 100,
        startedAt: reportJob.createdAt, completedAt: terminal === "failed" ? null : reportJob.createdAt,
        expiresAt: terminal === "failed" ? null : "2026-09-18T00:00:00.000Z",
        failureCode: terminal === "failed" ? "REPORT_GENERATION_FAILED" : null,
        failure: terminal === "failed" ? {
          code: "generation_failed", message: "보고서를 생성하지 못했습니다.", action: "다시 생성해 주세요."
        } : null }] });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const hook = renderHook(() => useEnergyReports(reportJob.siteId), { wrapper: wrapperFor(client) });
    try {
      await act(async () => { await vi.advanceTimersByTimeAsync(0); });
      expect(apiGet).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(2999); });
      expect(apiGet).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(1); });
      expect(apiGet).toHaveBeenCalledTimes(2);
      await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
      expect(apiGet).toHaveBeenCalledTimes(3);
      await act(async () => { await vi.advanceTimersByTimeAsync(9000); });
      expect(apiGet).toHaveBeenCalledTimes(3);
    } finally { hook.unmount(); client.clear(); vi.useRealTimers(); }
  });

  it("loads and strictly parses a site-scoped comparison by preset", async () => {
    apiGet.mockResolvedValue(comparisonResponse);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useEnergyComparison("site/2", "current_month"), {
      wrapper: wrapperFor(client)
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiGet).toHaveBeenCalledWith("/energy/sites/site%2F2/comparisons?preset=current_month");
    expect(client.getQueryCache().find({
      queryKey: ["energy-comparison", "site/2", "current_month"]
    })).toBeDefined();
  });

  it("surfaces malformed comparison responses as query errors", async () => {
    apiGet.mockResolvedValue({ ...comparisonResponse, unexpected: true });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    const { result } = renderHook(() => useEnergyComparison("site-2", "current_month"), {
      wrapper: wrapperFor(client)
    });

    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 3_000 });
    expect(result.current.data).toBeUndefined();
  });

  it("loads and strictly parses a ranking request", async () => {
    apiGet.mockResolvedValue(rankingResponse);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useEnergyRankings({
      siteId: "site/2", dimension: "floor", metric: "usage", sort: "desc",
      from: "2026-09-01", to: "2026-09-10", limit: 5
    }), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiGet).toHaveBeenCalledWith(
      "/energy/sites/site%2F2/rankings?dimension=floor&metric=usage&sort=desc&from=2026-09-01&to=2026-09-10&limit=5"
    );
  });

  it("loads a strict, selected-scope heatmap and keeps the metric in its cache key", async () => {
    apiGet.mockResolvedValue(heatmapResponse);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useEnergyHeatmap({
      siteId: "site/2", scope: "floor", identityId: "30000000-0000-4000-8000-000000000020",
      metric: "brightness", from: "2026-08-14", to: "2026-09-10"
    }), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(apiGet).toHaveBeenCalledWith(
      "/energy/sites/site%2F2/heatmap?scope=floor&identityId=30000000-0000-4000-8000-000000000020&metric=brightness&from=2026-08-14&to=2026-09-10"
    );
    expect(client.getQueryCache().find({
      queryKey: ["energy-heatmap", "site/2", "floor", "30000000-0000-4000-8000-000000000020", "brightness", "2026-08-14", "2026-09-10"]
    })).toBeDefined();
  });

  it("surfaces malformed heatmap responses as query errors", async () => {
    apiGet.mockResolvedValue({ ...heatmapResponse, cells: heatmapResponse.cells.slice(1) });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { result } = renderHook(() => useEnergyHeatmap({
      siteId: heatmapResponse.siteId, scope: "site", identityId: heatmapResponse.siteId,
      metric: "energy", from: "2026-08-14", to: "2026-09-10"
    }), { wrapper: wrapperFor(client) });

    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 3_000 });
  });
});

const rankingResponse = {
  siteId: "00000000-0000-4000-8000-000000000003",
  timeZone: "Asia/Seoul",
  source: "state_based_estimate",
  generatedAt: "2026-09-10T03:00:00.000Z",
  dimension: "floor",
  metric: "usage",
  sort: "desc",
  range: { from: "2026-09-01", to: "2026-09-10" },
  siteTotalKwh: 12,
  siteTotalCost: 1920,
  overlappingMemberships: false,
  legacyExcludedBefore: null,
  ranked: [],
  unranked: []
};

const comparisonResponse = {
  siteId: "00000000-0000-4000-8000-000000000003",
  timeZone: "Asia/Seoul",
  source: "state_based_estimate",
  generatedAt: "2026-09-10T03:00:00.000Z",
  preset: "current_month",
  range: { from: "2026-09-01", to: "2026-09-30", completedThrough: "2026-09-09" },
  summary: {
    baselineKwh: 100,
    estimatedKwh: 65,
    savingsKwh: 35,
    savingsCost: 5_600,
    savingsRatePercent: 35,
    outcome: "saving",
    forecastReason: "available"
  },
  priorComparisons: [],
  points: [{
    period: "2026-09-01",
    baselineKwh: 4,
    estimatedKwh: 2.5,
    phase: "observed",
    knownSeconds: 86_400,
    unknownSeconds: 0,
    coverageRate: 1,
    dataStatus: "available"
  }]
};

const heatmapResponse = {
  siteId: "30000000-0000-4000-8000-000000000001",
  timeZone: "Asia/Seoul",
  generatedAt: "2026-09-11T03:00:00.000Z",
  metric: "energy",
  scope: "site",
  identityId: "30000000-0000-4000-8000-000000000001",
  range: { from: "2026-08-14", to: "2026-09-10" },
  cells: Array.from({ length: 168 }, (_, index) => ({
    weekday: Math.floor(index / 24), hour: index % 24, value: index === 0 ? 0 : 1
  }))
};

const reportJob = {
  reportId: "30000000-0000-4000-8000-000000000040",
  siteId: "30000000-0000-4000-8000-000000000001",
  request: {
    from: "2026-09-01",
    to: "2026-09-10",
    scope: "site" as const,
    identityId: "30000000-0000-4000-8000-000000000001",
    format: "xlsx" as const
  },
  status: "queued" as const,
  progressPercent: 0,
  createdAt: "2026-09-10T00:00:00.000Z",
  startedAt: null,
  completedAt: null,
  expiresAt: null,
  failureCode: null,
  target: {
    scope: "site" as const,
    identityId: "30000000-0000-4000-8000-000000000001",
    label: "서울 물류센터"
  },
  requestedAt: "2026-09-10T00:00:00.000Z",
  failure: null
};
