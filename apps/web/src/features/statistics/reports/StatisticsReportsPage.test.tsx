import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import { MemoryRouter, Outlet, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client";
import { measureAutomationContainer } from "../../../test/automation-list";
import { StatisticsReportsPage } from "./StatisticsReportsPage";
import * as fileDelivery from "../../mobile/file-download";
import { initializeMobileRuntime } from "../../mobile/mobile-runtime";
import { Blob as NodeBlob } from "node:buffer";

const reportsApi = vi.hoisted(() => ({
  create: vi.fn(),
  csv: vi.fn(),
  download: vi.fn(),
  reports: vi.fn()
}));
const dashboardState = vi.hoisted(() => ({ data: undefined as unknown, isLoading: false }));
const targetState = vi.hoisted(() => ({ data: undefined as unknown, isLoading: false, isError: false }));

vi.mock("../../../api/energy", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../../api/energy")>(),
  createEnergyReport: (...args: unknown[]) => reportsApi.create(...args),
  downloadEnergyCsv: (...args: unknown[]) => reportsApi.csv(...args),
  downloadEnergyReport: (...args: unknown[]) => reportsApi.download(...args),
  useEnergyReports: (siteId: string | undefined, query: unknown) => reportsApi.reports(siteId, query),
  useEnergyReportTargets: () => targetState
}));

vi.mock("../../../api/queries", () => ({
  useDashboard: () => ({ data: dashboardState.data, isLoading: dashboardState.isLoading })
}));

const siteId = "30000000-0000-4000-8000-000000000001";
const dashboard = {
  site: { id: siteId, name: "서울 물류센터" },
  floors: [{ id: "30000000-0000-4000-8000-000000000010", name: "1층", fixtures: [
    { id: "30000000-0000-4000-8000-000000000020", name: "A-01" }
  ] }],
  groups: [{ id: "30000000-0000-4000-8000-000000000030", name: "입구 그룹" }]
};
const targets = { siteId, timeZone: "Asia/Seoul", lastCompletedDate: "2026-09-11", targets: [
  { scope: "site", identityId: siteId, label: "서울 물류센터" },
  { scope: "fixture", identityId: "30000000-0000-4000-8000-000000000021", label: "A-01 이력" },
  { scope: "floor", identityId: dashboard.floors[0].id, label: "1층" },
  { scope: "group", identityId: "30000000-0000-4000-8000-000000000031", label: "입구 그룹 이력" }
] };

const reports = [
  job("queued", 0), job("processing", 36), job("completed", 100), job("failed", 0), job("expired", 100)
];

describe("StatisticsReportsPage", () => {
  beforeEach(() => {
    measureAutomationContainer(400);
    dashboardState.data = dashboard;
    dashboardState.isLoading = false;
    targetState.data = targets;
    targetState.isLoading = false;
    targetState.isError = false;
    reportsApi.create.mockReset();
    reportsApi.csv.mockReset();
    reportsApi.download.mockReset();
    reportsApi.reports.mockReset();
    reportsApi.create.mockResolvedValue(job("queued", 0));
    reportsApi.download.mockResolvedValue({ downloadUrl: "https://reports.example.test/signed.pdf" });
    reportsApi.reports.mockReturnValue({
      data: { reports, nextCursor: null, totalCount: reports.length },
      isLoading: false,
      isError: false,
      refetch: vi.fn()
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  });
  afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it.each([
    ["partial", 0, "Backspace"], ["reversed", 0, "ArrowUp"],
    ["over 90 days", 3, "ArrowUp"], ["impossible", 1, "ArrowUp"]
  ])("blocks local %s history drafts without publishing, and recovers on reset", async (_name, index, key) => {
    const retry = vi.fn();
    reportsApi.reports.mockReturnValue({ data: undefined, isLoading: false, isError: true, isFetching: false, refetch: retry });
    const from = _name === "impossible" ? "2026-01-31" : "2026-09-01";
    const to = _name === "impossible" ? "2026-02-15" : "2026-09-15";
    renderPage({ initialEntry: `/statistics/reports?siteId=${siteId}&requestedFrom=${from}&requestedTo=${to}` });
    const original = screen.getByTestId("location-search").textContent;
    fireEvent.click(screen.getByRole("button", { name: /보고서 조건 상세 필터/ }));
    const fields = within(screen.getByRole("group", { name: "요청 기간" })).getAllByRole("spinbutton");
    fireEvent.keyDown(fields[Number(index)], { key });
    await waitFor(() => expect(reportsApi.reports).toHaveBeenLastCalledWith(undefined, { limit: 20, requestedFrom: from, requestedTo: to }));
    fireEvent.click(screen.getByRole("button", { name: "필터 닫기" }));
    const retryButton = screen.getByRole("button", { name: "다시 시도" });
    expect(retryButton).toBeDisabled(); fireEvent.click(retryButton); expect(retry).not.toHaveBeenCalled();
    expect(screen.getByTestId("location-search")).toHaveTextContent(original!);
    fireEvent.click(screen.getByRole("button", { name: /보고서 조건 상세 필터/ }));
    fireEvent.click(screen.getByRole("button", { name: "필터 초기화" }));
    await waitFor(() => expect(reportsApi.reports).toHaveBeenLastCalledWith(siteId, { limit: 20 }));
  });

  it.each([
    ["requestedFrom=2026-09-20&requestedTo=2026-09-01", ["2026", "9", "20", "2026", "9", "1"]],
    ["requestedFrom=2026-02-31&requestedTo=2026-09-01", ["2026", "2", "31", "2026", "9", "1"]],
    ["requestedFrom=2026-09-01", ["2026", "9", "1", "연도", "월", "일"]]
  ])("retains date-invalid initial URL %s without fetching, normalizing or showing retained reports", async (dates, segments) => {
    const initialSearch = `?siteId=${siteId}&query=%EC%84%9C%EC%9A%B8&limit=50&${dates}`;
    expect(() => renderPage({ initialEntry: `/statistics/reports${initialSearch}` })).not.toThrow();
    expect(screen.getByTestId("location-search")).toHaveTextContent(initialSearch);
    const rawDates = new URLSearchParams(dates);
    expect(screen.getByText(`URL 요청 기간: ${rawDates.get("requestedFrom")} ~ ${rawDates.get("requestedTo") ?? "미입력"}`)).toBeVisible();
    expect(screen.getByText("URL의 요청 기간을 직접 수정하거나 필터를 초기화해 주세요.")).toBeVisible();
    expect(screen.queryByRole("region", { name: "요청한 보고서" })).not.toBeInTheDocument();
    expect(screen.queryByRole("navigation", { name: "페이지 이동" })).not.toBeInTheDocument();
    expect(screen.queryByText("보고서가 없습니다.")).not.toBeInTheDocument();
    expect(reportsApi.reports).toHaveBeenLastCalledWith(undefined, { limit: 50, query: "서울" });
    fireEvent.click(screen.getByRole("button", { name: /보고서 조건 상세 필터/ }));
    expectDateSegments("요청 기간", segments);
    fireEvent.click(screen.getByRole("button", { name: "필터 닫기" }));
    fireEvent.click(screen.getByRole("button", { name: /보고서 조건 상세 필터/ }));
    expectDateSegments("요청 기간", segments);
    expect(screen.getByTestId("location-search")).toHaveTextContent(initialSearch);
    fireEvent.click(screen.getByRole("button", { name: "필터 초기화" }));
    await waitFor(() => expect(reportsApi.reports).toHaveBeenLastCalledWith(siteId, { limit: 20, query: "서울" }));
    expect(screen.getByTestId("location-search")).not.toHaveTextContent("requestedFrom");
    fireEvent.click(screen.getByRole("button", { name: "필터 닫기" }));
    expect(screen.getByRole("region", { name: "요청한 보고서" })).toBeInTheDocument();
    expect(reportsApi.create).not.toHaveBeenCalled(); expect(reportsApi.csv).not.toHaveBeenCalled();
  });

  it("does not replay an invalid-URL search or partial date across A→B→A", () => {
    vi.useFakeTimers();
    const initialEntry = `/statistics/reports?siteId=${siteId}&query=서울&requestedFrom=2026-09-20&requestedTo=2026-09-01`;
    const client = new QueryClient();
    const view = renderPage({ initialEntry, queryClient: client });
    const originalSearch = screen.getByTestId("location-search").textContent;
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "이전 A의 초안" } });
    fireEvent.click(screen.getByRole("button", { name: /보고서 조건 상세 필터/ }));
    fireEvent.keyDown(within(screen.getByRole("group", { name: "요청 기간" })).getAllByRole("spinbutton")[0], { key: "Backspace" });
    fireEvent.click(screen.getByRole("button", { name: "필터 닫기" }));
    view.rerender(pageTree("new-site", client, initialEntry));
    view.rerender(pageTree(siteId, client, initialEntry));
    act(() => vi.advanceTimersByTime(300));
    expect(screen.getByRole("searchbox")).toHaveValue("서울");
    expect(screen.getByTestId("location-search")).toHaveTextContent(originalSearch!);
    expect(reportsApi.reports).toHaveBeenLastCalledWith(undefined, { limit: 20, query: "서울" });
    fireEvent.click(screen.getByRole("button", { name: /보고서 조건 상세 필터/ }));
    expectDateSegments("요청 기간", ["2026", "9", "20", "2026", "9", "1"]);
    vi.useRealTimers();
  });

  it.each(["status=unknown", "scope=unknown", "limit=500"])("still rejects non-date initial URL %s even with invalid dates", (condition) => {
    expect(() => renderPage({ initialEntry: `/statistics/reports?${condition}&requestedFrom=2026-09-20&requestedTo=2026-09-01` })).toThrow();
  });

  it("keeps valid report creation independent of invalid history without normalizing its URL", async () => {
    const initialSearch = `?siteId=${siteId}&requestedFrom=2026-09-20&requestedTo=2026-09-01`;
    renderPage({ initialEntry: `/statistics/reports${initialSearch}` });
    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" });
    expectDateSegments("기간 시작", ["2026", "8", "13"]);
    expect(within(dialog).getByRole("button", { name: "보고서 요청" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "CSV 내보내기" })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "보고서 요청" }));
    await waitFor(() => expect(reportsApi.create).toHaveBeenCalledWith(siteId, { from: "2026-08-13", to: "2026-09-11", scope: "site", identityId: siteId, format: "pdf" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "에너지 사용량 보고서 만들기" })).not.toBeInTheDocument());
    expect(screen.getByTestId("location-search")).toHaveTextContent(initialSearch);
    expect(reportsApi.reports).toHaveBeenLastCalledWith(undefined, { limit: 20 });
    expect(screen.getByText("URL의 요청 기간을 직접 수정하거나 필터를 초기화해 주세요.")).toBeVisible();
  });

  it("drops a legacy XLSX URL and restores the first PDF history page", async () => {
    renderPage({ initialEntry: "/statistics/reports?siteId=" + siteId + "&format=xlsx&scope=site" });

    await waitFor(() => expect(screen.getByTestId("location-search")).not.toHaveTextContent("format="));
    expect(reportsApi.reports).toHaveBeenLastCalledWith(siteId, { limit: 20, scope: "site" });
    expect(screen.getByRole("search", { name: "보고서 이력 필터" })).not.toHaveTextContent("형식");
  });

  it("offers a PDF request without format selection and omits history format metadata", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" });
    expect(within(dialog).queryByRole("button", { name: "파일 형식" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "CSV 내보내기" })).toBeEnabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "닫기" }));
    expect(screen.getByRole("list", { name: "보고서 생성 이력" })).not.toHaveTextContent("형식");
  });

  it("keeps the page header concise and omits the static result preview", () => {
    renderPage();

    const heading = screen.getByRole("heading", { name: "보고서" });
    expect(heading.closest("header")).not.toHaveTextContent("현장 에너지 사용량을 기간과 범위에 맞춰 내보냅니다.");
    expect(screen.queryByText(/PDF\s*·\s*XLSX 결과 미리보기/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "보고서 만들기" })).toBeEnabled();
  });

  it("frames external search and the PDF condition popover as one panel", () => {
    renderPage();

    const filters = screen.getByRole("search", { name: "보고서 이력 필터" });
    expect(filters.closest('[data-variant="default"]')).toBeInTheDocument();
    expect(within(filters).getByRole("searchbox", { name: "보고서 검색" })).toBeVisible();
    expect(within(filters).queryByRole("button", { name: "파일 형식" })).not.toBeInTheDocument();
    expect(within(filters).getByRole("button", { name: /보고서 조건 상세 필터/ })).toBeVisible();
    fireEvent.click(within(filters).getByRole("button", { name: /보고서 조건 상세 필터/ }));
    expect(screen.getByRole("dialog", { name: "보고서 조건" })).toHaveTextContent("범위");
  });

  it("keeps the job list and paging in one history card with cost context in the request dialog", () => {
    renderPage();

    const history = screen.getByRole("region", { name: "보고서 이력" });
    expect(within(history).getByRole("region", { name: "요청한 보고서" })).toBeInTheDocument();
    expect(within(history).getByRole("navigation", { name: "페이지 이동" })).toBeInTheDocument();
    expect(screen.queryByText("보고서와 CSV 비용은 당시 적용 단가의 저장 비용입니다.")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));
    expect(within(screen.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" }))
      .getByText(/당시 적용 단가의 저장 비용/)).toBeInTheDocument();
  });

  it("uses analytics targets even when the operational dashboard contains no fixture details", async () => {
    dashboardState.data = { ...dashboard, floors: [{ ...dashboard.floors[0], fixtures: [] }] };
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));
    await chooseSelect("범위", "조명", screen.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" }));
    expect(screen.getByRole("button", { name: "대상" })).toHaveTextContent("A-01 이력");
    fireEvent.click(screen.getByRole("button", { name: "보고서 요청" }));
    await waitFor(() => expect(reportsApi.create).toHaveBeenCalledWith(siteId, expect.objectContaining({ identityId: targets.targets[1].identityId })));
  });

  it("defaults both date controls to the server's last completed site-local day", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));
    expectDateSegments("기간 종료", ["2026", "9", "11"]);
    expectDateSegments("기간 시작", ["2026", "8", "13"]);
  });

  it("labels the creation dates as the report document period rather than request dates", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));

    expect(screen.getByText("보고서 대상 기간은 현장 시간대의 마지막 완료일까지 선택할 수 있습니다.")).toBeVisible();
    expect(screen.getByRole("group", { name: "기간 시작" })).toBeInTheDocument();
    expect(screen.getByRole("group", { name: "기간 종료" })).toBeInTheDocument();
  });

  it("keeps a restored cursor page and URL unchanged while all four PDF filters are visible", async () => {
    reportsApi.reports.mockReturnValue(reportQueryResult(pageJobs(21, 20), { nextCursor: null, totalCount: 40 }));
    const fingerprint = "limit=20&scope=floor";
    renderPage({ initialEntry: {
      pathname: "/statistics/reports",
      search: `?${fingerprint}&siteId=${siteId}`,
      state: reportLocationState(2, "cursor-20", { filterFingerprint: fingerprint })
    } });

    await waitFor(() => expect(reportsApi.reports).toHaveBeenLastCalledWith(siteId, {
      limit: 20, scope: "floor", cursor: "cursor-20"
    }));
    const search = screen.getByTestId("location-search").textContent;
    const calls = reportsApi.reports.mock.calls.length;
    fireEvent.click(screen.getByRole("button", { name: /보고서 조건 상세 필터/ }));
    expect(screen.getByRole("button", { name: "범위" })).toHaveTextContent("층");
    fireEvent.click(screen.getByRole("button", { name: "필터 닫기" }));

    expect(screen.getByText("2페이지")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "이전 페이지" })).toBeEnabled();
    expect(screen.getByTestId("location-search")).toHaveTextContent(search ?? "");
    expect(reportsApi.reports).toHaveBeenCalledTimes(calls);
  });

  it("renders deterministic API pages and navigates forward and backward with a cursor stack", async () => {
    reportsApi.reports.mockImplementation((_activeSiteId: string, query: { limit: number; cursor?: string } = { limit: 20 }) => {
      const secondPage = query.cursor === "cursor-20";
      return {
        data: {
          reports: pageJobs(secondPage ? 21 : 1, 20),
          nextCursor: secondPage ? "cursor-40" : "cursor-20",
          totalCount: 101
        },
        isLoading: false,
        isError: false,
        refetch: vi.fn()
      };
    });
    renderPage();

    expect(reportsApi.reports).toHaveBeenLastCalledWith(siteId, { limit: 20 });
    expect(screen.getByText("1~20 / 101건")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));

    await waitFor(() => expect(reportsApi.reports).toHaveBeenLastCalledWith(siteId, {
      limit: 20,
      cursor: "cursor-20"
    }));
    expect(screen.getByText("21~40 / 101건")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "이전 페이지" })).toBeEnabled();

    fireEvent.click(screen.getByRole("button", { name: "이전 페이지" }));
    await waitFor(() => expect(reportsApi.reports).toHaveBeenLastCalledWith(siteId, { limit: 20 }));
    expect(screen.getByText("1~20 / 101건")).toBeInTheDocument();
  });

  it("blocks repeated forward navigation while the next cursor page is unresolved", async () => {
    let pageTwoResolved = false;
    reportsApi.reports.mockImplementation((_activeSiteId: string, query: { limit: number; cursor?: string } = { limit: 20 }) => {
      if (query.cursor === "cursor-20" && !pageTwoResolved) {
        return {
          data: { reports: pageJobs(1, 20), nextCursor: "cursor-20", totalCount: 101 },
          isLoading: false,
          isError: false,
          isFetching: true,
          isPlaceholderData: true,
          refetch: vi.fn()
        };
      }
      const secondPage = query.cursor === "cursor-20";
      return {
        data: { reports: pageJobs(secondPage ? 21 : 1, 20), nextCursor: secondPage ? "cursor-40" : "cursor-20", totalCount: 101 },
        isLoading: false,
        isError: false,
        isFetching: false,
        isPlaceholderData: false,
        refetch: vi.fn()
      };
    });
    const queryClient = new QueryClient();
    const view = render(pageTree(siteId, queryClient));

    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    await waitFor(() => expect(screen.getByRole("button", { name: "다음 페이지" })).toBeDisabled());
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    expect(reportsApi.reports).not.toHaveBeenCalledWith(siteId, { limit: 20, cursor: "cursor-40" });

    pageTwoResolved = true;
    view.rerender(pageTree(siteId, queryClient));
    await waitFor(() => expect(screen.getByText("21~40 / 101건")).toBeInTheDocument());
    expect(screen.getByText("2페이지")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "이전 페이지" })).toBeEnabled();
  });

  it("retains the last successful rows and range when a delayed next-page request rejects", async () => {
    const retry = vi.fn();
    let secondPageState: "pending" | "failed" = "pending";
    reportsApi.reports.mockImplementation((_activeSiteId: string, query: { limit: number; cursor?: string } = { limit: 20 }) => {
      if (!query.cursor) return reportQueryResult(pageJobs(1, 20), { nextCursor: "cursor-20", totalCount: 101 });
      if (secondPageState === "pending") return {
        data: { reports: pageJobs(1, 20), nextCursor: "cursor-20", totalCount: 101 },
        isLoading: false,
        isError: false,
        isFetching: true,
        isPlaceholderData: true,
        refetch: retry
      };
      return {
        data: undefined,
        isLoading: false,
        isError: true,
        isFetching: false,
        isPlaceholderData: false,
        error: new Error("raw-next-page-secret"),
        refetch: retry
      };
    });
    const queryClient = new QueryClient();
    const view = render(pageTree(siteId, queryClient));
    await waitFor(() => expect(screen.getAllByText("대상 1")).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    await waitFor(() => expect(screen.getByRole("region", { name: "요청한 보고서" })).toHaveAttribute("aria-busy", "true"));
    secondPageState = "failed";
    view.rerender(pageTree(siteId, queryClient));

    const refreshNotice = await screen.findByRole("button", { name: "목록 갱신 실패 안내" });
    expect(refreshNotice).toHaveClass("border-status-danger-border");
    expect(screen.queryByText("보고서 목록을 새로 불러오지 못했습니다. 기존 결과를 표시합니다.")).not.toBeInTheDocument();
    expect(screen.getAllByText("대상 1")).toHaveLength(1);
    expect(screen.getByText("1~20 / 101건")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "이전 페이지" })).toBeEnabled();
    expect(document.body).not.toHaveTextContent("raw-next-page-secret");
    fireEvent.click(refreshNotice);
    const refreshDetails = await screen.findByRole("dialog", { name: "목록 갱신 실패 안내" });
    expect(refreshDetails).toHaveTextContent("보고서 목록을 새로 불러오지 못했습니다. 기존 결과를 표시합니다.");
    fireEvent.click(within(refreshDetails).getByRole("button", { name: "다시 시도" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("retains rows during a background refetch failure and exposes only sanitized recovery", async () => {
    const retry = vi.fn();
    let backgroundFailed = false;
    reportsApi.reports.mockImplementation(() => backgroundFailed
      ? {
          data: undefined,
          isLoading: false,
          isError: true,
          isFetching: false,
          isPlaceholderData: false,
          error: new Error("raw-background-secret"),
          refetch: retry
        }
      : reportQueryResult(pageJobs(1, 20), { nextCursor: "cursor-20", totalCount: 101, refetch: retry }));
    const queryClient = new QueryClient();
    const view = render(pageTree(siteId, queryClient));
    await waitFor(() => expect(screen.getAllByText("대상 1")).toHaveLength(1));

    backgroundFailed = true;
    view.rerender(pageTree(siteId, queryClient));

    const refreshNotice = await screen.findByRole("button", { name: "목록 갱신 실패 안내" });
    expect(screen.queryByText("보고서 목록을 새로 불러오지 못했습니다. 기존 결과를 표시합니다.")).not.toBeInTheDocument();
    expect(screen.getAllByText("대상 1")).toHaveLength(1);
    expect(screen.getByText("1~20 / 101건")).toBeInTheDocument();
    expect(document.body).not.toHaveTextContent("raw-background-secret");
    fireEvent.click(refreshNotice);
    const refreshDetails = await screen.findByRole("dialog", { name: "목록 갱신 실패 안내" });
    expect(refreshDetails).toHaveTextContent("보고서 목록을 새로 불러오지 못했습니다. 기존 결과를 표시합니다.");
    fireEvent.click(within(refreshDetails).getByRole("button", { name: "다시 시도" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("does not steal focus after retry when the user switches cursor pages", async () => {
    const retry = vi.fn(() => new Promise(() => undefined));
    reportsApi.reports.mockImplementation((_activeSiteId: string, query: { cursor?: string }) => query.cursor
      ? {
          data: undefined,
          isLoading: false,
          isError: true,
          isFetching: false,
          isPlaceholderData: false,
          refetch: retry
        }
      : reportQueryResult(pageJobs(1, 20), { nextCursor: "cursor-20", totalCount: 40 }));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    const warning = await screen.findByRole("button", { name: "목록 갱신 실패 안내" });
    fireEvent.click(warning);
    fireEvent.click(within(await screen.findByRole("dialog", { name: "목록 갱신 실패 안내" }))
      .getByRole("button", { name: "다시 시도" }));
    expect(retry).toHaveBeenCalledOnce();

    const previous = screen.getByRole("button", { name: "이전 페이지" });
    previous.focus();
    fireEvent.click(previous);
    await waitFor(() => expect(screen.getByText("1~20 / 40건")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "목록 갱신 실패 안내" })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "요청한 보고서" })).not.toHaveFocus();
  });

  it("does not focus the list on an unrelated refresh after a failed retry", async () => {
    const retry = vi.fn(() => new Promise(() => undefined));
    let cursorState: "failed" | "pending" | "recovered" = "failed";
    reportsApi.reports.mockImplementation((_activeSiteId: string, query: { cursor?: string }) => {
      if (!query.cursor) return reportQueryResult(pageJobs(1, 20), { nextCursor: "cursor-20", totalCount: 40 });
      if (cursorState === "recovered") return reportQueryResult(pageJobs(21, 20), { nextCursor: null, totalCount: 40 });
      return {
        data: undefined,
        isLoading: false,
        isError: cursorState === "failed",
        isFetching: cursorState === "pending",
        isPlaceholderData: false,
        refetch: retry
      };
    });
    const queryClient = new QueryClient();
    const view = render(pageTree(siteId, queryClient));
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    fireEvent.click(await screen.findByRole("button", { name: "목록 갱신 실패 안내" }));
    fireEvent.click(within(await screen.findByRole("dialog", { name: "목록 갱신 실패 안내" }))
      .getByRole("button", { name: "다시 시도" }));
    cursorState = "pending";
    view.rerender(pageTree(siteId, queryClient));
    expect(screen.getByRole("region", { name: "요청한 보고서" })).toHaveAttribute("aria-busy", "true");
    cursorState = "failed";
    view.rerender(pageTree(siteId, queryClient));
    const search = screen.getByRole("searchbox", { name: "보고서 검색" });
    search.focus();

    cursorState = "recovered";
    view.rerender(pageTree(siteId, queryClient));
    expect(search).toHaveFocus();
    expect(screen.getByRole("region", { name: "요청한 보고서" })).not.toHaveFocus();
  });

  it.each(["site", "filter"] as const)("never reuses retained rows for a different %s scope", async (scope) => {
    let activeScope: "initial" | "failed" = "initial";
    reportsApi.reports.mockImplementation((_activeSiteId: string) => activeScope === "initial"
      ? reportQueryResult(pageJobs(1, 20), { nextCursor: "cursor-20", totalCount: 101 })
      : {
          data: undefined,
          isLoading: false,
          isError: true,
          isFetching: false,
          isPlaceholderData: false,
          error: new Error("raw-cross-scope-secret"),
          refetch: vi.fn()
        });
    const queryClient = new QueryClient();
    const view = render(pageTree(siteId, queryClient));
    await waitFor(() => expect(screen.getAllByText("대상 1")).toHaveLength(1));

    activeScope = "failed";
    if (scope === "site") {
      view.rerender(pageTree("30000000-0000-4000-8000-000000000099", queryClient));
    } else {
      await chooseSelect("상태", "완료");
    }

    expect(await screen.findByText("보고서 목록을 불러오지 못했습니다.")).toBeInTheDocument();
    expect(screen.queryAllByText("대상 1")).toHaveLength(0);
    expect(document.body).not.toHaveTextContent("raw-cross-scope-secret");
  });

  it("removes legacy cursor URL state and safely starts on page one", async () => {
    reportsApi.reports.mockImplementation((_activeSiteId: string, query: { limit: number; cursor?: string } = { limit: 20 }) => ({
      data: {
        reports: pageJobs(query.cursor === "cursor-20" ? 21 : 1, 20),
        nextCursor: query.cursor === "cursor-20" ? "cursor-40" : "cursor-20",
        totalCount: 101
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      isPlaceholderData: false,
      refetch: vi.fn()
    }));
    renderPage({
      initialEntry: `/statistics/reports?limit=20&cursor=cursor-20&reportPage=2&reportHistory=%5Bnull%5D&reportSite=${siteId}`
    });

    await waitFor(() => expect(reportsApi.reports).toHaveBeenLastCalledWith(siteId, { limit: 20 }));
    expect(screen.getByText("1~20 / 101건")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "이전 페이지" })).toBeDisabled();
    expect(screen.getByTestId("location-search")).toHaveTextContent(`?limit=20&siteId=${siteId}`);
    expect(screen.getByTestId("location-search")).not.toHaveTextContent(/cursor|reportPage|reportHistory|reportSite/);
  });

  it.each([50, 1_000, 1_001])("restores page %i from matching history state without growing the URL", async (page) => {
    const currentCursor = `cursor-${(page - 1) * 20}`;
    reportsApi.reports.mockImplementation((_activeSiteId: string, query: { limit: number; cursor?: string } = { limit: 20 }) => ({
      data: {
        reports: pageJobs((page - 1) * 20 + 1, 20),
        nextCursor: null,
        totalCount: 20_000
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      isPlaceholderData: false,
      refetch: vi.fn()
    }));
    renderPage({
      initialEntry: {
        pathname: "/statistics/reports",
        search: `?limit=20&siteId=${siteId}`,
        state: reportLocationState(page, currentCursor)
      }
    });

    await waitFor(() => expect(reportsApi.reports).toHaveBeenLastCalledWith(siteId, { limit: 20, cursor: currentCursor }));
    expect(screen.getByText(`${page}페이지`)).toBeInTheDocument();
    const search = screen.getByTestId("location-search").textContent ?? "";
    expect(search.length).toBeLessThan(100);
    expect(search).not.toMatch(/cursor|reportPage|reportHistory|reportSite/);
  });

  it("moves from page 1000 to 1001 without growing the URL and restores both entries", async () => {
    reportsApi.reports.mockImplementation((_activeSiteId: string, query: { limit: number; cursor?: string } = { limit: 20 }) => ({
      data: {
        reports: pageJobs(query.cursor === "cursor-20000" ? 20_001 : 19_981, 20),
        nextCursor: query.cursor === "cursor-20000" ? null : "cursor-20000",
        totalCount: 25_000
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      isPlaceholderData: false,
      refetch: vi.fn()
    }));
    renderPage({
      initialEntry: {
        pathname: "/statistics/reports",
        search: `?limit=20&siteId=${siteId}`,
        state: reportLocationState(1_000, "cursor-19980")
      }
    });
    const initialSearch = screen.getByTestId("location-search").textContent;

    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    await waitFor(() => expect(reportsApi.reports).toHaveBeenLastCalledWith(siteId, { limit: 20, cursor: "cursor-20000" }));
    expect(screen.getByText("1001페이지")).toBeInTheDocument();
    expect(screen.getByTestId("location-search")).toHaveTextContent(initialSearch ?? "");

    fireEvent.click(screen.getByRole("button", { name: "브라우저 뒤로" }));
    await waitFor(() => expect(reportsApi.reports).toHaveBeenLastCalledWith(siteId, { limit: 20, cursor: "cursor-19980" }));
    expect(screen.getByText("1000페이지")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "브라우저 앞으로" }));
    await waitFor(() => expect(reportsApi.reports).toHaveBeenLastCalledWith(siteId, { limit: 20, cursor: "cursor-20000" }));
    expect(screen.getByText("1001페이지")).toBeInTheDocument();
  });

  it("restores a valid deep cursor stack and Previous selects the exact prior cursor", async () => {
    reportsApi.reports.mockImplementation((_activeSiteId: string, query: { limit: number; cursor?: string } = { limit: 20 }) => reportQueryResult(
      pageJobs(query.cursor === "cursor-40" ? 41 : 61, 20),
      { nextCursor: null, totalCount: 100 }
    ));
    renderPage({
      initialEntry: {
        pathname: "/statistics/reports",
        search: `?limit=20&siteId=${siteId}`,
        state: reportLocationState(4, "cursor-60")
      }
    });

    await waitFor(() => expect(reportsApi.reports).toHaveBeenLastCalledWith(siteId, { limit: 20, cursor: "cursor-60" }));
    fireEvent.click(screen.getByRole("button", { name: "이전 페이지" }));
    await waitFor(() => expect(reportsApi.reports).toHaveBeenLastCalledWith(siteId, { limit: 20, cursor: "cursor-40" }));
    expect(screen.getByText("3페이지")).toBeInTheDocument();
  });

  it.each([
    ["second null sentinel", 3, "cursor-40", [null, null]],
    ["duplicate prior cursor", 4, "cursor-60", [null, "cursor-20", "cursor-20"]],
    ["current cursor duplicated in history", 3, "cursor-20", [null, "cursor-20"]],
    ["missing prior cursor", 3, "cursor-40", [null]],
    ["sparse cursor hole", 3, "cursor-40", sparseCursorStack(2, [[0, null]])],
    ["explicit undefined cursor", 3, "cursor-40", [null, undefined]],
    ["inherited cursor index", 3, "cursor-40", inheritedCursorStack()],
    ["sparse duplicate edge", 5, "cursor-60", sparseCursorStack(4, [[0, null], [1, "cursor-20"], [3, "cursor-20"]])]
  ])("normalizes a corrupt history state with %s", async (_case, page, currentCursor, previousCursors) => {
    renderPage({
      initialEntry: {
        pathname: "/statistics/reports",
        search: `?limit=20&siteId=${siteId}`,
        state: {
          statisticsReportHistory: {
            version: 1,
            siteId,
            filterFingerprint: "limit=20",
            page,
            currentCursor,
            previousCursors
          }
        }
      }
    });

    await waitFor(() => expect(reportsApi.reports).toHaveBeenLastCalledWith(siteId, { limit: 20 }));
    expect(screen.getByText("1페이지")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "이전 페이지" })).toBeDisabled();
  });

  it("normalizes an unsafe page integer", async () => {
    renderPage({
      initialEntry: {
        pathname: "/statistics/reports",
        search: `?limit=20&siteId=${siteId}`,
        state: {
          statisticsReportHistory: {
            version: 1,
            siteId,
            filterFingerprint: "limit=20",
            page: Number.MAX_SAFE_INTEGER + 1,
            currentCursor: "cursor-unsafe",
            previousCursors: []
          }
        }
      }
    });

    await waitFor(() => expect(reportsApi.reports).toHaveBeenLastCalledWith(siteId, { limit: 20 }));
    expect(screen.getByText("1페이지")).toBeInTheDocument();
  });

  it.each([
    ["site", "30000000-0000-4000-8000-000000000099", "limit=20"],
    ["filter", siteId, "limit=20&status=completed"]
  ])("rejects a history page whose %s origin does not match", async (_origin, stateSiteId, filterFingerprint) => {
    renderPage({
      initialEntry: {
        pathname: "/statistics/reports",
        search: `?limit=20&siteId=${siteId}`,
        state: reportLocationState(2, "cursor-20", { stateSiteId, filterFingerprint })
      }
    });

    await waitFor(() => expect(reportsApi.reports).toHaveBeenLastCalledWith(siteId, { limit: 20 }));
    expect(screen.getByText("1페이지")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "이전 페이지" })).toBeDisabled();
  });

  it("synchronizes filters, cursor history and range across browser back and forward", async () => {
    reportsApi.reports.mockImplementation((_activeSiteId: string, query: { limit: number; cursor?: string } = { limit: 20 }) => ({
      data: {
        reports: pageJobs(query.cursor === "cursor-20" ? 21 : 1, 20),
        nextCursor: query.cursor === "cursor-20" ? "cursor-40" : "cursor-20",
        totalCount: 101
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      isPlaceholderData: false,
      refetch: vi.fn()
    }));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    await waitFor(() => expect(screen.getByText("21~40 / 101건")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "브라우저 뒤로" }));
    await waitFor(() => expect(reportsApi.reports).toHaveBeenLastCalledWith(siteId, { limit: 20 }));
    expect(screen.getByText("1~20 / 101건")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "이전 페이지" })).toBeDisabled();

    fireEvent.click(screen.getByRole("button", { name: "브라우저 앞으로" }));
    await waitFor(() => expect(reportsApi.reports).toHaveBeenLastCalledWith(siteId, { limit: 20, cursor: "cursor-20" }));
    expect(screen.getByText("21~40 / 101건")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "이전 페이지" })).toBeEnabled();
  });

  it("resets to the first page when the page size or a filter changes", async () => {
    reportsApi.reports.mockImplementation((_activeSiteId: string, query: { limit: number; cursor?: string } = { limit: 20 }) => ({
      data: {
        reports: pageJobs(query.cursor ? 21 : 1, Math.min(query.limit, 20)),
        nextCursor: query.cursor ? null : "cursor-20",
        totalCount: 101
      },
      isLoading: false,
      isError: false,
      refetch: vi.fn()
    }));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    await waitFor(() => expect(screen.getByText("21~40 / 101건")).toBeInTheDocument());

    await chooseSelect("페이지당 항목 수", "100개");
    await waitFor(() => expect(reportsApi.reports).toHaveBeenLastCalledWith(siteId, { limit: 100 }));
    expect(screen.getByText("1~100 / 101건")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    await chooseSelect("상태", "완료");
    await waitFor(() => expect(reportsApi.reports).toHaveBeenLastCalledWith(siteId, {
      limit: 100,
      status: "completed"
    }));
    expect(screen.getByText("1~100 / 101건")).toBeInTheDocument();
  });

  it("resets cursor history when the active site changes", async () => {
    reportsApi.reports.mockImplementation((_activeSiteId: string, query: { limit: number; cursor?: string } = { limit: 20 }) => ({
      data: { reports: pageJobs(query.cursor ? 21 : 1, 20), nextCursor: query.cursor ? null : "cursor-20", totalCount: 40 },
      isLoading: false,
      isError: false,
      refetch: vi.fn()
    }));
    const client = new QueryClient();
    const view = render(pageTree(siteId, client));
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    await waitFor(() => expect(screen.getByText("21~40 / 40건")).toBeInTheDocument());

    const nextSiteId = "30000000-0000-4000-8000-000000000099";
    view.rerender(pageTree(nextSiteId, client));
    await waitFor(() => expect(reportsApi.reports).toHaveBeenLastCalledWith(nextSiteId, { limit: 20 }));
    expect(screen.getByText("1~20 / 40건")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "이전 페이지" })).toBeDisabled();
  });

  it("never restores another site's cursor when browser Back follows a site change", async () => {
    reportsApi.reports.mockImplementation((_activeSiteId: string, query: { limit: number; cursor?: string } = { limit: 20 }) => ({
      data: {
        reports: pageJobs(query.cursor === "cursor-20" ? 21 : 1, 20),
        nextCursor: query.cursor === "cursor-20" ? null : "cursor-20",
        totalCount: 40
      },
      isLoading: false,
      isError: false,
      isFetching: false,
      isPlaceholderData: false,
      refetch: vi.fn()
    }));
    const queryClient = new QueryClient();
    const view = render(pageTree(siteId, queryClient));
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    await waitFor(() => expect(screen.getByText("21~40 / 40건")).toBeInTheDocument());

    const nextSiteId = "30000000-0000-4000-8000-000000000099";
    view.rerender(pageTree(nextSiteId, queryClient));
    await waitFor(() => expect(reportsApi.reports).toHaveBeenLastCalledWith(nextSiteId, { limit: 20 }));
    const callsBeforeBack = reportsApi.reports.mock.calls.length;

    fireEvent.click(screen.getByRole("button", { name: "브라우저 뒤로" }));
    await waitFor(() => expect(reportsApi.reports.mock.calls.length).toBeGreaterThan(callsBeforeBack));
    expect(reportsApi.reports).toHaveBeenLastCalledWith(nextSiteId, { limit: 20 });
    expect(reportsApi.reports).not.toHaveBeenCalledWith(nextSiteId, { limit: 20, cursor: "cursor-20" });
    expect(screen.getByText("1~20 / 40건")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "이전 페이지" })).toBeDisabled();
  });

  it("invalidates the report query prefix and returns to page one after report creation", async () => {
    reportsApi.reports.mockImplementation((_activeSiteId: string, query: { limit: number; cursor?: string } = { limit: 20 }) => ({
      data: { reports: pageJobs(query.cursor ? 21 : 1, 20), nextCursor: query.cursor ? null : "cursor-20", totalCount: 40 },
      isLoading: false,
      isError: false,
      refetch: vi.fn()
    }));
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    renderPage({ queryClient });
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    await waitFor(() => expect(screen.getByText("21~40 / 40건")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));
    fireEvent.click(screen.getByRole("button", { name: "보고서 요청" }));

    await waitFor(() => expect(reportsApi.create).toHaveBeenCalledOnce());
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["energy-reports", siteId] }));
    await waitFor(() => expect(reportsApi.reports).toHaveBeenLastCalledWith(siteId, { limit: 20 }));
    await waitFor(() => expect(screen.getByText("1~20 / 40건")).toBeInTheDocument());
  });

  it("preserves the latest filters when regeneration resolves after a filter change", async () => {
    const pending = deferred<ReturnType<typeof job>>();
    reportsApi.create.mockReturnValueOnce(pending.promise);
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    renderPage({ queryClient });

    const list = screen.getByRole("list", { name: "보고서 생성 이력" });
    fireEvent.click(within(list).getByRole("button", { name: "대상 failed 보고서 다시 생성" }));
    await waitFor(() => expect(reportsApi.create).toHaveBeenCalledOnce());
    await chooseSelect("상태", "완료");
    await waitFor(() => expect(reportsApi.reports).toHaveBeenLastCalledWith(siteId, { limit: 20, status: "completed" }));

    pending.resolve(job("queued", 0));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["energy-reports", siteId] }));
    expect(reportsApi.reports).toHaveBeenLastCalledWith(siteId, { limit: 20, status: "completed" });
  });

  it("invalidates the request site without resetting the new site when report creation resolves late", async () => {
    const pending = deferred<ReturnType<typeof job>>();
    reportsApi.create.mockReturnValueOnce(pending.promise);
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const view = render(pageTree(siteId, queryClient));

    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));
    fireEvent.click(screen.getByRole("button", { name: "보고서 요청" }));
    await waitFor(() => expect(reportsApi.create).toHaveBeenCalledOnce());

    const nextSiteId = "30000000-0000-4000-8000-000000000099";
    view.rerender(pageTree(nextSiteId, queryClient));
    await waitFor(() => expect(reportsApi.reports).toHaveBeenLastCalledWith(nextSiteId, { limit: 20 }));
    pending.resolve(job("queued", 0));

    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ["energy-reports", siteId] }));
    expect(reportsApi.reports).toHaveBeenLastCalledWith(nextSiteId, { limit: 20 });
  });

  it.each([400, 1440])("renders one measured report surface with all labeled metadata at container %ipx", (width) => {
    measureAutomationContainer(width);
    renderPage();
    const surface = screen.getByRole(width === 1440 ? "table" : "list", { name: "보고서 생성 이력" });
    expect(screen.queryByRole(width === 1440 ? "list" : "table", { name: "보고서 생성 이력" })).not.toBeInTheDocument();
    const labels = width === 1440 ? within(surface).getAllByRole("columnheader") : within(surface).getAllByRole("term").slice(0, 7);
    expect(labels.map(label => label.textContent)).toEqual(["대상", "범위", "기간", "상태", "요청 시각", "파일 만료 시각", "작업"]);
    expect(within(surface).getAllByTitle("2026-09-17T00:00:04.000Z")[0]).toHaveAttribute("datetime", "2026-09-17T00:00:04.000Z");
    if (width === 1440) expect(within(surface).getAllByRole("columnheader").every(header => header.classList.contains("text-center"))).toBe(true);
    else {
      const completed = within(surface).getByText("대상 completed").closest("li")!;
      const expiry = within(completed).getByText("파일 만료 시각");
      expect(expiry.nextElementSibling?.querySelector("time")).toHaveAttribute("datetime", "2026-09-17T00:00:04.000Z");
      for (const status of ["queued", "failed"]) {
        const card = within(surface).getByText(`대상 ${status}`).closest("li")!;
        expect(within(card).getByText("파일 만료 시각").nextElementSibling).toHaveTextContent("—");
      }
    }
  });

  it("identifies the site's timezone for report request and expiry metadata", () => {
    targetState.data = { ...targets, timeZone: "America/Los_Angeles" };
    renderPage();

    const list = screen.getByRole("list", { name: "보고서 생성 이력" });
    const completed = within(list).getByText("대상 completed", { exact: true }).closest("li")!;
    expect(screen.getByText("시각: 현장 시간대 America/Los_Angeles")).toBeInTheDocument();
    expect(within(completed).getByTitle("2026-09-17T00:00:04.000Z")).toHaveTextContent("2026-09-16 17:00:04");
  });

  it.each([400, 1440])("keeps processing progress and busy semantics on the measured %ipx surface", (width) => {
    measureAutomationContainer(width);
    reportsApi.reports.mockReturnValue({
      data: { reports, nextCursor: null, totalCount: reports.length },
      isLoading: false, isError: false, isFetching: true, isPlaceholderData: false, refetch: vi.fn()
    });
    renderPage();
    const history = screen.getByRole("region", { name: "요청한 보고서" });
    expect(history).toHaveAttribute("aria-busy", "true");
    const surface = screen.getByRole(width === 1440 ? "table" : "list", { name: "보고서 생성 이력" });
    expect(surface.closest("[aria-busy]")).toHaveAttribute("aria-busy", "true");
    const progress = within(surface).getByRole("progressbar", { name: "대상 processing 보고서 생성 진행률" });
    expect(progress).toHaveAttribute("aria-valuenow", "36");
    expect(progress).toHaveAttribute("aria-valuemin", "0");
    expect(progress).toHaveAttribute("aria-valuemax", "100");
  });

  it("discloses only the sanitized failure message and action with linked ARIA state", () => {
    renderPage();
    const list = screen.getByRole("list", { name: "보고서 생성 이력" });
    const toggle = within(list).getByRole("button", { name: "대상 failed 실패 상세 보기" });
    const panelId = toggle.getAttribute("aria-controls");

    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(panelId).toBeTruthy();
    expect(document.getElementById(panelId!)).toBeNull();
    fireEvent.click(toggle);

    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById(panelId!)).toHaveTextContent(
      "보고서를 생성하지 못했습니다.잠시 후 다시 생성해 주세요."
    );
    expect(document.body).not.toHaveTextContent("REPORT_GENERATION_FAILED");
  });

  it("edits the report range through design-system date pickers", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));

    const dialog = screen.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" });
    expect(within(dialog).getByRole("button", { name: "보고서 요청" })).toBeEnabled();
    const startDate = within(dialog).getByRole("group", { name: "기간 시작" });
    fireEvent.click(within(startDate).getByRole("button"));

    expect(await screen.findByRole("grid")).toBeInTheDocument();
  });

  it("uses design-system selectors without changing the report request payload", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));

    const dialog = screen.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" });
    const scope = within(dialog).getByRole("button", { name: "범위" });
    fireEvent.keyDown(scope, { key: "ArrowDown" });
    fireEvent.keyDown(await screen.findByRole("option", { name: "조명" }), { key: "Enter" });
    fireEvent.keyUp(document.activeElement!, { key: "Enter" });

    fireEvent.click(within(dialog).getByRole("button", { name: "보고서 요청" }));

    await waitFor(() => expect(reportsApi.create).toHaveBeenCalledWith(siteId, {
      from: "2026-08-13",
      to: "2026-09-11",
      scope: "fixture",
      identityId: targets.targets[1].identityId,
      format: "pdf"
    }));
  });

  it("disables report actions when a required date picker is cleared", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));

    const startDate = screen.getByRole("group", { name: "기간 시작" });
    for (const segment of within(startDate).getAllByRole("spinbutton")) {
      act(() => segment.focus());
      for (let index = 0; index < 4; index++) fireEvent.keyDown(segment, { key: "Backspace", code: "Backspace" });
    }

    expect(screen.getByRole("button", { name: "보고서 요청" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "CSV 내보내기" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "보고서 요청" }));
    expect(reportsApi.create).not.toHaveBeenCalled();
    expect(reportsApi.csv).not.toHaveBeenCalled();
  });

  it("keeps an out-of-domain start-year draft editable and blocks PDF and CSV until corrected", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));
    const year = within(screen.getByRole("group", { name: "기간 시작" })).getAllByRole("spinbutton")[0]!;
    act(() => year.focus());
    fireEvent.keyDown(year, { key: "ArrowUp" });
    expect(year).toHaveTextContent("2027");
    expect(screen.getByRole("button", { name: "보고서 요청" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "CSV 내보내기" })).toBeDisabled();
    expect(screen.getByText("시작일과 종료일을 마지막 완료일 이내의 순서대로 선택해 주세요.")).toBeInTheDocument();
    expect(reportsApi.create).not.toHaveBeenCalled();
    expect(reportsApi.csv).not.toHaveBeenCalled();
    fireEvent.keyDown(year, { key: "ArrowDown" });
    expectDateSegments("기간 시작", ["2026", "8", "13"]);
    expect(screen.getByRole("button", { name: "보고서 요청" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "CSV 내보내기" })).toBeEnabled();
  });

  it("preserves a reversed report draft without PDF or CSV requests", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));
    const year = within(screen.getByRole("group", { name: "기간 종료" })).getAllByRole("spinbutton")[0]!;
    act(() => year.focus());
    fireEvent.keyDown(year, { key: "ArrowDown" });
    expect(year).toHaveTextContent("2025");
    expect(screen.getByRole("button", { name: "보고서 요청" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "CSV 내보내기" })).toBeDisabled();
    expect(screen.getByText("시작일과 종료일을 마지막 완료일 이내의 순서대로 선택해 주세요.")).toBeInTheDocument();
    expect(reportsApi.create).not.toHaveBeenCalled();
    expect(reportsApi.csv).not.toHaveBeenCalled();
  });

  it("creates one standard PDF report from a period and identity without section choices", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));

    const dialog = screen.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" });
    expect(within(dialog).getByRole("group", { name: "기간 시작" })).toBeInTheDocument();
    expect(within(dialog).getByRole("group", { name: "기간 종료" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "범위" })).toHaveTextContent("현장");
    expect(within(dialog).getByRole("button", { name: "대상" })).toHaveTextContent("서울 물류센터");
    expect(dialog).toHaveTextContent("PDF 보고서로 만듭니다.");
    expect(within(dialog).queryByText(/섹션/)).not.toBeInTheDocument();

    await chooseSelect("범위", "조명", dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "보고서 요청" }));

    await waitFor(() => expect(reportsApi.create).toHaveBeenCalledWith(siteId, expect.objectContaining({
      scope: "fixture", identityId: targets.targets[1].identityId, format: "pdf"
    })));
  });

  it("exports CSV with the same period and selected scope", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" });
    await chooseSelect("범위", "층", dialog);
    fireEvent.click(within(dialog).getByRole("button", { name: "CSV 내보내기" }));

    await waitFor(() => expect(reportsApi.csv).toHaveBeenCalledWith(siteId, expect.objectContaining({
      scope: "floor", identityId: dashboard.floors[0].id
    }), expect.objectContaining({ signal: expect.any(AbortSignal) })));
  });

  it("blocks fixture report actions while target data is loading instead of using the site identity", async () => {
    targetState.data = undefined;
    targetState.isLoading = true;
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" });
    await chooseSelect("범위", "조명", dialog);

    expect(within(dialog).getByRole("status")).toHaveTextContent("대상을 불러오는 중입니다.");
    expect(within(dialog).getByRole("button", { name: "CSV 내보내기" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "보고서 요청" })).toBeDisabled();
  });

  it("blocks fixture report actions when the selected scope has no target", async () => {
    targetState.data = { ...targets, targets: targets.targets.slice(0, 1) };
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" });
    await chooseSelect("범위", "조명", dialog);

    expect(within(dialog).getByRole("status")).toHaveTextContent("선택한 범위에 등록된 대상이 없습니다.");
    expect(within(dialog).getByRole("button", { name: "CSV 내보내기" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "보고서 요청" })).toBeDisabled();
    expect(reportsApi.create).not.toHaveBeenCalled();
    expect(reportsApi.csv).not.toHaveBeenCalled();
  });

  it("blocks all export actions when target loading fails, including stale cached targets", () => {
    targetState.isError = true;
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));
    expect(screen.getByRole("status")).toHaveTextContent("대상 정보를 불러오지 못했습니다.");
    expect(screen.getByRole("button", { name: "보고서 요청" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "CSV 내보내기" })).toBeDisabled();
  });

  it("renders every report state and uses a fresh signed download only for completed reports", async () => {
    renderPage();
    const list = screen.getByRole("list", { name: "보고서 생성 이력" });

    expect(within(list).getByText("대기 중")).toBeInTheDocument();
    expect(within(list).getByText("생성 중 36%")).toBeInTheDocument();
    expect(within(list).getByText("완료")).toBeInTheDocument();
    expect(within(list).getByText("생성 실패")).toBeInTheDocument();
    expect(within(list).getByText("만료됨")).toBeInTheDocument();
    expect(within(list).getByText("대상 completed")).toBeInTheDocument();
    expect(within(list).getAllByText("요청 시각")).toHaveLength(5);
    expect(within(list).getAllByText("파일 만료 시각")).toHaveLength(5);
    expect(within(list).getByRole("button", { name: "대상 failed 실패 상세 보기" })).toHaveAttribute("aria-expanded", "false");
    const requestedAt = within(list).getAllByTitle("2026-09-10T00:00:00.000Z")[0];
    expect(requestedAt).toHaveAttribute("datetime", "2026-09-10T00:00:00.000Z");
    fireEvent.click(within(list).getByRole("button", { name: "대상 completed 보고서 다운로드" }));
    await waitFor(() => expect(reportsApi.download).toHaveBeenCalledWith(siteId, reports[2].reportId, { signal: expect.any(AbortSignal) }));
    expect(within(list).getByRole("button", { name: "대상 failed 보고서 다시 생성" })).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: "대상 expired 보고서 다시 생성" })).toBeInTheDocument();
  });

  it("keeps report metadata and actions in separate wrapping regions", () => {
    renderPage();

    const list = screen.getByRole("list", { name: "보고서 생성 이력" });
    const completed = within(list).getByText("대상 completed", { exact: true }).closest("li")!;
    const metadata = completed.querySelector("dl")!;
    expect(metadata).not.toHaveTextContent("형식");
    expect(metadata).toHaveTextContent("범위현장");
    expect(metadata).toHaveTextContent("요청 시각");
    expect(within(completed).getByRole("button", { name: "대상 completed 보고서 다운로드" }).closest("dd")).toContainElement(
      within(completed).getByRole("button", { name: "대상 completed 보고서 다운로드" })
    );
  });

  it("keeps the report list available when a signed download request fails", async () => {
    reportsApi.download.mockRejectedValueOnce(new Error("download failed"));
    renderPage();
    fireEvent.click(within(screen.getByRole("list", { name: "보고서 생성 이력" })).getByRole("button", { name: "대상 completed 보고서 다운로드" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("보고서 다운로드를 완료하지 못했습니다.");
    expect(screen.getByRole("region", { name: "요청한 보고서" })).toBeInTheDocument();
  });

  it.each([400, 1440])("blocks duplicate PDF downloads on the measured %ipx history surface while preparing the file", async (width) => {
    measureAutomationContainer(width);
    const pending = deferred<{ downloadUrl: string }>();
    reportsApi.download.mockReturnValueOnce(pending.promise);
    renderPage();
    const buttons = screen.getAllByRole("button", { name: "대상 completed 보고서 다운로드" });
    fireEvent.click(buttons[0]);
    try {
      expect(buttons).toHaveLength(1);
      for (const button of buttons) expect(button).toBeDisabled();
      expect(buttons[0]).toHaveAttribute("aria-busy", "true");
      fireEvent.click(buttons[0]);
      expect(reportsApi.download).toHaveBeenCalledOnce();
      expect(screen.getByRole("search", { name: "보고서 이력 필터" })).toBeInTheDocument();
    } finally {
      await act(async () => pending.resolve({ downloadUrl: "https://reports.example.test/fresh.pdf" }));
    }
    await waitFor(() => expect(buttons[0]).toBeEnabled());
  });

  it("ignores a late PDF download failure after the selected site changes", async () => {
    const pending = deferred<{ downloadUrl: string }>();
    reportsApi.download.mockReturnValueOnce(pending.promise);
    const client = new QueryClient();
    const view = renderPage({ queryClient: client });
    fireEvent.click(within(screen.getByRole("list", { name: "보고서 생성 이력" }))
      .getByRole("button", { name: "대상 completed 보고서 다운로드" }));

    view.rerender(pageTree("30000000-0000-4000-8000-000000000099", client));
    await act(async () => pending.reject(new TypeError("Failed to fetch")));

    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "요청한 보고서" })).toBeInTheDocument();
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
  });

  it("rejects a PDF descriptor from the previous native document before file delivery", async () => {
    installNativeEnvironment();
    vi.stubGlobal("Blob", NodeBlob);
    const sent: Array<Record<string, unknown>> = [];
    vi.stubGlobal("ReactNativeWebView", { postMessage: (raw: string) => {
      const message = JSON.parse(raw) as Record<string, unknown>;
      sent.push(message);
      const reply = message.type === "file.begin" ? { type: "file.ack", nextIndex: 0, receivedBytes: 0 }
        : message.type === "file.chunk" ? { type: "file.ack", nextIndex: 1, receivedBytes: 8 }
        : message.type === "file.end" ? { type: "file.result", status: "handoff" } : null;
      if (reply) queueMicrotask(() => window.dispatchEvent(new CustomEvent("led-control:native-message", {
        detail: { version: 1, documentId: message.documentId, requestId: message.requestId, ...reply }
      })));
    } });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("%PDF-1.7", { headers: { "content-type": "application/pdf" } })));
    const cleanupRuntime = initializeMobileRuntime();
    const pending = deferred<{ downloadUrl: string }>();
    reportsApi.download.mockReturnValueOnce(pending.promise);
    renderPage();
    fireEvent.click(screen.getAllByRole("button", { name: "대상 completed 보고서 다운로드" })[0]);
    try {
      window.__LED_CONTROL_NATIVE_DOCUMENT_ID__ = "pdf-new-document";
      window.dispatchEvent(new CustomEvent("led-control:native-message", { detail: {
        version: 1, type: "mobile.bootstrap", documentId: "pdf-new-document", requestId: "pdf-new-bootstrap",
        mobile: true, state: "active", online: true
      } }));
      await act(async () => pending.resolve({ downloadUrl: "https://reports.example.test/old-document.pdf" }));
      expect(fetch).not.toHaveBeenCalled();
      expect(sent.filter(message => message.type === "file.begin")).toEqual([]);
      expect(await screen.findByRole("alert")).toHaveTextContent("화면이 변경되어");
      expect(screen.queryByText("공유창을 닫았습니다.")).not.toBeInTheDocument();
    } finally { cleanupRuntime(); }
  });

  it.each(["cancel", "site", "unmount", "document"] as const)("aborts the actual PDF descriptor GET on %s before any file delivery", async (change) => {
    installNativeEnvironment();
    const energy = await vi.importActual<typeof import("../../../api/energy")>("../../../api/energy");
    reportsApi.download.mockImplementation(energy.downloadEnergyReport);
    const cleanupRuntime = initializeMobileRuntime();
    let descriptorSignal: AbortSignal | undefined;
    vi.stubGlobal("fetch", vi.fn((_url: string, options: RequestInit) => new Promise((_resolve, reject) => {
      descriptorSignal = options.signal ?? undefined;
      descriptorSignal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    })));
    const client = new QueryClient();
    const view = renderPage({ queryClient: client });
    fireEvent.click(screen.getAllByRole("button", { name: "대상 completed 보고서 다운로드" })[0]);
    try {
      await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
      if (change === "cancel") fireEvent.click(screen.getByRole("button", { name: "파일 준비 취소" }));
      else if (change === "site") view.rerender(pageTree("30000000-0000-4000-8000-000000000099", client));
      else if (change === "unmount") view.unmount();
      else {
        window.__LED_CONTROL_NATIVE_DOCUMENT_ID__ = "descriptor-new-document";
        window.dispatchEvent(new CustomEvent("led-control:native-message", { detail: {
          version: 1, type: "mobile.bootstrap", documentId: "descriptor-new-document", requestId: "descriptor-bootstrap",
          mobile: true, state: "active", online: true
        } }));
      }
      expect(descriptorSignal?.aborted).toBe(true);
      await waitFor(() => expect(screen.queryByRole("button", { name: "파일 준비 취소" })).not.toBeInTheDocument());
      expect(fetch).toHaveBeenCalledOnce();
      expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
      if (change === "document") expect(await screen.findByRole("alert")).toHaveTextContent("화면이 변경되어");
      else if (change === "cancel") expect(screen.getByText("파일 공유를 취소했습니다.")).toHaveAttribute("role", "status");
      else expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    } finally { view.unmount(); cleanupRuntime(); client.clear(); }
  });

  it("shows native PDF CORS failures without opening a browser or exposing the signed URL", async () => {
    installNativeEnvironment();
    const fetchFile = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    vi.stubGlobal("fetch", fetchFile);
    renderPage();
    fireEvent.click(within(screen.getByRole("list", { name: "보고서 생성 이력" }))
      .getByRole("button", { name: "대상 completed 보고서 다운로드" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("네트워크 연결");
    expect(fetchFile).toHaveBeenCalledWith("https://reports.example.test/signed.pdf", expect.objectContaining({
      credentials: "omit"
    }));
    expect(HTMLAnchorElement.prototype.click).not.toHaveBeenCalled();
    expect(screen.getByRole("region", { name: "요청한 보고서" })).toBeInTheDocument();
    expect(screen.queryByText(/reports\.example\.test/)).not.toBeInTheDocument();
  });

  it("announces a PDF handoff without claiming the file was saved", async () => {
    vi.spyOn(fileDelivery, "downloadMobileAwareUrl").mockResolvedValueOnce("handoff");
    renderPage();
    fireEvent.click(screen.getAllByRole("button", { name: "대상 completed 보고서 다운로드" })[0]);
    expect(await screen.findByText("공유창을 닫았습니다.")).toHaveAttribute("role", "status");
    expect(screen.queryByText(/저장 완료/)).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "대상 completed 보고서 다운로드" })[0]).toBeEnabled();
  });

  it("keeps CSV selections and the dialog after explicit cancellation", async () => {
    reportsApi.csv.mockResolvedValueOnce("cancelled");
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));
    const dialog = screen.getByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "CSV 내보내기" }));
    expect(await within(dialog).findByText("파일 공유를 취소했습니다.")).toHaveAttribute("role", "status");
    expect(within(dialog).getByRole("button", { name: "CSV 내보내기" })).toBeEnabled();
    expect(within(dialog).getByRole("button", { name: "대상" })).toHaveTextContent("서울 물류센터");
  });

  it("aborts CSV preparation on cancel and prevents duplicate export requests", async () => {
    const pending = deferred<string>();
    reportsApi.csv.mockReturnValueOnce(pending.promise);
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));
    const dialog = screen.getByRole("dialog");
    const button = within(dialog).getByRole("button", { name: "CSV 내보내기" });
    fireEvent.click(button); fireEvent.click(button);
    expect(reportsApi.csv).toHaveBeenCalledOnce();
    const signal = reportsApi.csv.mock.calls[0][2]?.signal;
    expect(signal?.aborted).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: "파일 준비 취소" }));
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve("cancelled"));
    expect(await within(dialog).findByText("파일 공유를 취소했습니다.")).toBeInTheDocument();
  });

  it("aborts pending PDF delivery when switching sites and ignores its late result", async () => {
    const pending = deferred<fileDelivery.MobileFileDownloadOutcome>();
    const exportFile = vi.spyOn(fileDelivery, "downloadMobileAwareUrl").mockReturnValueOnce(pending.promise);
    const client = new QueryClient();
    const view = renderPage({ queryClient: client });
    fireEvent.click(screen.getAllByRole("button", { name: "대상 completed 보고서 다운로드" })[0]);
    await waitFor(() => expect(exportFile).toHaveBeenCalled());
    const signal = exportFile.mock.calls[0][0].signal;
    view.rerender(pageTree("30000000-0000-4000-8000-000000000099", client));
    expect(signal?.aborted).toBe(true);
    await act(async () => pending.resolve("handoff"));
    expect(screen.queryByText("공유창을 닫았습니다.")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not label a late PDF handoff as success after explicit cancellation", async () => {
    const pending = deferred<fileDelivery.MobileFileDownloadOutcome>();
    const exportFile = vi.spyOn(fileDelivery, "downloadMobileAwareUrl").mockReturnValueOnce(pending.promise);
    renderPage();
    fireEvent.click(screen.getAllByRole("button", { name: "대상 completed 보고서 다운로드" })[0]);
    await waitFor(() => expect(exportFile).toHaveBeenCalled());
    fireEvent.click(screen.getByRole("button", { name: "파일 준비 취소" }));
    await act(async () => pending.resolve("handoff"));
    expect(await screen.findByText("파일 공유를 취소했습니다.")).toHaveAttribute("role", "status");
    expect(screen.queryByText("공유창을 닫았습니다.")).not.toBeInTheDocument();
  });

  it("aborts CSV on dialog replacement and keeps late errors out of the new site", async () => {
    const pending = deferred<fileDelivery.MobileFileDownloadOutcome>();
    reportsApi.csv.mockReturnValueOnce(pending.promise);
    const client = new QueryClient();
    const view = renderPage({ queryClient: client });
    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));
    fireEvent.click(screen.getByRole("button", { name: "CSV 내보내기" }));
    const signal = reportsApi.csv.mock.calls[0][2].signal;
    view.rerender(pageTree("30000000-0000-4000-8000-000000000099", client));
    expect(signal.aborted).toBe(true);
    await act(async () => pending.reject(new Error("old native file failure")));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("dialog")).toBeInTheDocument();
  });

  it("keeps the report list available and reports a retry failure", async () => {
    reportsApi.create.mockRejectedValueOnce(new Error("retry failed"));
    renderPage();
    fireEvent.click(within(screen.getByRole("list", { name: "보고서 생성 이력" })).getByRole("button", { name: "대상 failed 보고서 다시 생성" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("보고서 다시 생성을 완료하지 못했습니다.");
    expect(screen.getByRole("region", { name: "요청한 보고서" })).toBeInTheDocument();
  });

  it.each([
    ["create", () => reportsApi.create.mockRejectedValueOnce(new ApiError("invalid", 400, null)), "보고서 요청 입력을 확인해 주세요."],
    ["csv", () => reportsApi.csv.mockRejectedValueOnce(new TypeError("Failed to fetch")), "네트워크 연결을 확인한 뒤 CSV 내보내기를 다시 시도해 주세요."],
    ["download", () => reportsApi.download.mockRejectedValueOnce(new ApiError("gone", 404, null)), "보고서 파일이 없거나 만료되었습니다."],
    ["regenerate", () => reportsApi.create.mockRejectedValueOnce(new ApiError("conflict", 409, null)), "보고서 다시 생성이 현재 상태와 충돌했습니다."]
  ] as const)("shows the mapped %s error while preserving the current view", async (action, reject, expected) => {
    reject();
    renderPage();
    if (action === "create" || action === "csv") {
      fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));
      fireEvent.click(screen.getByRole("button", { name: action === "create" ? "보고서 요청" : "CSV 내보내기" }));
    } else {
      fireEvent.click(within(screen.getByRole("list", { name: "보고서 생성 이력" })).getByRole("button", {
        name: action === "download" ? "대상 completed 보고서 다운로드" : "대상 failed 보고서 다시 생성"
      }));
    }
    expect(await screen.findByRole("alert")).toHaveTextContent(expected);
    if (action === "create" || action === "csv") {
      expect(screen.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" })).toBeInTheDocument();
    } else {
      expect(screen.getByRole("region", { name: "요청한 보고서" })).toBeInTheDocument();
    }
  });
});

function renderPage({
  activeSiteId = siteId,
  queryClient = new QueryClient(),
  initialEntry = "/statistics/reports"
}: {
  activeSiteId?: string;
  queryClient?: QueryClient;
  initialEntry?: MemoryRouterInitialEntry;
} = {}) {
  return render(pageTree(activeSiteId, queryClient, initialEntry));
}

type MemoryRouterInitialEntry = NonNullable<ComponentProps<typeof MemoryRouter>["initialEntries"]>[number];

function pageTree(activeSiteId: string, queryClient: QueryClient, initialEntry: MemoryRouterInitialEntry = "/statistics/reports") {
  return (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/statistics" element={<><HistoryControls /><Outlet context={{ siteId: activeSiteId }} /></>}>
            <Route path="reports" element={<StatisticsReportsPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function HistoryControls() {
  const navigate = useNavigate();
  const location = useLocation();
  return <div>
    <button type="button" aria-label="브라우저 뒤로" onClick={() => navigate(-1)} />
    <button type="button" aria-label="브라우저 앞으로" onClick={() => navigate(1)} />
    <output data-testid="location-search">{location.search}</output>
  </div>;
}

async function chooseSelect(label: string, option: string, container: HTMLElement = document.body) {
  const historyFilter = container === document.body;
  if (historyFilter && !screen.queryByRole("dialog", { name: "보고서 조건" })) fireEvent.click(screen.getByRole("button", { name: /보고서 조건 상세 필터/ }));
  const trigger = within(container).getByRole("button", { name: label === "페이지당 항목 수" ? "페이지 크기" : label });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const choice = await screen.findByRole("option", { name: option });
  fireEvent.keyDown(choice, { key: "Enter" });
  fireEvent.keyUp(document.activeElement!, { key: "Enter" });
  if (historyFilter) fireEvent.click(screen.getByRole("button", { name: "필터 닫기" }));
}

function expectDateSegments(label: string, expected: string[]) {
  expect(within(screen.getByRole("group", { name: label })).getAllByRole("spinbutton").map((segment) => segment.textContent)).toEqual(expected);
}

function job(status: "queued" | "processing" | "completed" | "failed" | "expired", progressPercent: number) {
  const done = status === "completed" || status === "expired";
  const started = status !== "queued";
  return {
    reportId: `30000000-0000-4000-8000-0000000000${({ queued: 41, processing: 42, completed: 43, failed: 44, expired: 45 })[status]}`,
    siteId,
    request: { from: "2026-09-01", to: "2026-09-10", scope: "site" as const, identityId: siteId, format: "pdf" as const },
    status, progressPercent,
    createdAt: "2026-09-10T00:00:00.000Z",
    startedAt: started ? "2026-09-10T00:00:02.000Z" : null,
    completedAt: done ? "2026-09-10T00:00:04.000Z" : null,
    expiresAt: done ? "2026-09-17T00:00:04.000Z" : null,
    failureCode: status === "failed" ? "REPORT_GENERATION_FAILED" : null,
    target: { scope: "site" as const, identityId: siteId, label: `대상 ${status}` },
    requestedAt: "2026-09-10T00:00:00.000Z",
    failure: status === "failed" ? {
      code: "generation_failed" as const,
      message: "보고서를 생성하지 못했습니다.",
      action: "잠시 후 다시 생성해 주세요."
    } : null
  };
}

function pageJobs(start: number, count: number) {
  return Array.from({ length: count }, (_, offset) => {
    const item = start + offset;
    return {
      ...job("queued", 0),
      reportId: `30000000-0000-4000-8000-${String(item).padStart(12, "0")}`,
      target: { scope: "site" as const, identityId: siteId, label: `대상 ${item}` }
    };
  });
}

function reportQueryResult(
  items: ReturnType<typeof pageJobs>,
  options: { nextCursor: string | null; totalCount: number; refetch?: ReturnType<typeof vi.fn> }
) {
  return {
    data: { reports: items, nextCursor: options.nextCursor, totalCount: options.totalCount },
    isLoading: false,
    isError: false,
    isFetching: false,
    isPlaceholderData: false,
    refetch: options.refetch ?? vi.fn()
  };
}

function reportLocationState(
  page: number,
  currentCursor: string,
  {
    stateSiteId = siteId,
    filterFingerprint = "limit=20"
  }: { stateSiteId?: string; filterFingerprint?: string } = {}
) {
  return {
    statisticsReportHistory: {
      version: 1,
      siteId: stateSiteId,
      filterFingerprint,
      page,
      currentCursor,
      previousCursors: Array.from({ length: page - 1 }, (_, index) => index === 0 ? null : `cursor-${index * 20}`)
    }
  };
}

function sparseCursorStack(length: number, entries: Array<[number, unknown]>) {
  const stack = new Array<unknown>(length);
  for (const [index, value] of entries) stack[index] = value;
  return stack;
}

function inheritedCursorStack() {
  const stack = sparseCursorStack(2, [[0, null]]);
  const prototype = Object.create(Array.prototype);
  Object.defineProperty(prototype, "1", { configurable: true, enumerable: true, value: "cursor-20" });
  Object.setPrototypeOf(stack, prototype);
  return stack;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((complete, fail) => { resolve = complete; reject = fail; });
  return { promise, resolve, reject };
}

function installNativeEnvironment() {
  vi.stubGlobal("__LED_CONTROL_NATIVE_DOCUMENT_ID__", "statistics-document");
  vi.stubGlobal("__LED_CONTROL_NATIVE_ENVIRONMENT__", {
    version: 1, type: "mobile.bootstrap", documentId: "statistics-document", requestId: "bootstrap",
    mobile: true, state: "active", online: true
  });
  vi.stubGlobal("ReactNativeWebView", { postMessage: vi.fn() });
}
