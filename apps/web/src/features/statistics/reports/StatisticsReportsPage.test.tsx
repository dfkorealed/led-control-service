import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../../../api/client";
import { StatisticsReportsPage } from "./StatisticsReportsPage";

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
    reportsApi.download.mockResolvedValue({ downloadUrl: "https://reports.example.test/signed.xlsx" });
    reportsApi.reports.mockReturnValue({
      data: { reports, nextCursor: null, totalCount: reports.length },
      isLoading: false,
      isError: false,
      refetch: vi.fn()
    });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("uses analytics targets even when the operational dashboard contains no fixture details", async () => {
    dashboardState.data = { ...dashboard, floors: [{ ...dashboard.floors[0], fixtures: [] }] };
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));
    await chooseSelect("범위", "조명");
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

  it("restores a serialized cursor page on reload", () => {
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
      initialEntry: "/statistics/reports?limit=20&cursor=cursor-20&reportPage=2&reportHistory=%5Bnull%5D"
    });

    expect(reportsApi.reports).toHaveBeenLastCalledWith(siteId, { limit: 20, cursor: "cursor-20" });
    expect(screen.getByText("21~40 / 101건")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "이전 페이지" })).toBeEnabled();
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
    expect(screen.getByText("1~20 / 40건")).toBeInTheDocument();
  });

  it("preserves the latest filters when regeneration resolves after a filter change", async () => {
    const pending = deferred<ReturnType<typeof job>>();
    reportsApi.create.mockReturnValueOnce(pending.promise);
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    renderPage({ queryClient });

    const list = screen.getByRole("list", { name: "모바일 보고서 생성 이력" });
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

  it("renders a semantic desktop table and a separate mobile list with headings and metadata", () => {
    renderPage();

    const table = screen.getByRole("table", { name: "보고서 생성 이력", hidden: true });
    expect(table.closest("div.hidden")).toHaveClass("desktop:block");
    expect(within(table).getAllByRole("columnheader", { hidden: true }).map((header) => header.textContent)).toEqual([
      "대상", "기간", "형식", "상태", "요청 시각", "만료 시각", "작업"
    ]);

    const list = screen.getByRole("list", { name: "모바일 보고서 생성 이력" });
    expect(list).toHaveClass("desktop:hidden");
    expect(within(list).getAllByRole("heading")).toHaveLength(reports.length);
    expect(within(list).getAllByRole("term").length).toBeGreaterThan(0);
  });

  it("discloses only the sanitized failure message and action with linked ARIA state", () => {
    renderPage();
    const list = screen.getByRole("list", { name: "모바일 보고서 생성 이력" });
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

    const format = within(dialog).getByRole("button", { name: "파일 형식" });
    fireEvent.keyDown(format, { key: "ArrowDown" });
    fireEvent.keyDown(await screen.findByRole("option", { name: "PDF" }), { key: "Enter" });
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
  });

  it("creates one standard XLSX or PDF report from a period and identity without section choices", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));

    const dialog = screen.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" });
    expect(within(dialog).getByRole("group", { name: "기간 시작" })).toBeInTheDocument();
    expect(within(dialog).getByRole("group", { name: "기간 종료" })).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "범위" })).toHaveTextContent("현장");
    expect(within(dialog).getByRole("button", { name: "대상" })).toHaveTextContent("서울 물류센터");
    expect(within(dialog).getByRole("button", { name: "파일 형식" })).toHaveTextContent("XLSX");
    expect(dialog).toHaveTextContent("XLSX와 PDF는 동일한 표준 보고서 내용을 파일 형식만 다르게 제공합니다.");
    expect(within(dialog).queryByText(/섹션/)).not.toBeInTheDocument();

    await chooseSelect("범위", "조명", dialog);
    await chooseSelect("파일 형식", "PDF", dialog);
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
    })));
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
    const list = screen.getByRole("list", { name: "모바일 보고서 생성 이력" });

    expect(within(list).getByText("대기 중")).toBeInTheDocument();
    expect(within(list).getByText("생성 중 36%")).toBeInTheDocument();
    expect(within(list).getByText("완료")).toBeInTheDocument();
    expect(within(list).getByText("생성 실패")).toBeInTheDocument();
    expect(within(list).getByText("만료됨")).toBeInTheDocument();
    expect(within(list).getByText("대상 completed")).toBeInTheDocument();
    expect(within(list).getAllByText("요청 시각")).toHaveLength(5);
    expect(within(list).getAllByText("파일 만료 시각")).toHaveLength(2);
    expect(within(list).getByRole("button", { name: "대상 failed 실패 상세 보기" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByText("보고서와 CSV 비용은 당시 적용 단가의 저장 비용입니다.")).toBeInTheDocument();
    const requestedAt = within(list).getAllByTitle("2026-09-10T00:00:00.000Z")[0];
    expect(requestedAt).toHaveAttribute("datetime", "2026-09-10T00:00:00.000Z");
    fireEvent.click(within(list).getByRole("button", { name: "대상 completed 보고서 다운로드" }));
    await waitFor(() => expect(reportsApi.download).toHaveBeenCalledWith(siteId, reports[2].reportId));
    expect(within(list).getByRole("button", { name: "대상 failed 보고서 다시 생성" })).toBeInTheDocument();
    expect(within(list).getByRole("button", { name: "대상 expired 보고서 다시 생성" })).toBeInTheDocument();
  });

  it("keeps report metadata and actions in separate wrapping regions", () => {
    renderPage();

    const list = screen.getByRole("list", { name: "모바일 보고서 생성 이력" });
    const completed = within(list).getByRole("listitem", { name: "대상 completed 보고서" });
    const metadata = within(completed).getByRole("group", { name: "보고서 메타데이터" });
    expect(metadata).toHaveTextContent("형식XLSX");
    expect(metadata).toHaveTextContent("범위현장");
    expect(metadata).toHaveTextContent("요청 시각");
    expect(within(completed).getByRole("group", { name: "보고서 작업" })).toContainElement(
      within(completed).getByRole("button", { name: "대상 completed 보고서 다운로드" })
    );
  });

  it("keeps the report list available when a signed download request fails", async () => {
    reportsApi.download.mockRejectedValueOnce(new Error("download failed"));
    renderPage();
    fireEvent.click(within(screen.getByRole("list", { name: "모바일 보고서 생성 이력" })).getByRole("button", { name: "대상 completed 보고서 다운로드" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("보고서 다운로드를 완료하지 못했습니다.");
    expect(screen.getByRole("region", { name: "요청한 보고서" })).toBeInTheDocument();
  });

  it("keeps the report list available and reports a retry failure", async () => {
    reportsApi.create.mockRejectedValueOnce(new Error("retry failed"));
    renderPage();
    fireEvent.click(within(screen.getByRole("list", { name: "모바일 보고서 생성 이력" })).getByRole("button", { name: "대상 failed 보고서 다시 생성" }));

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
      fireEvent.click(within(screen.getByRole("list", { name: "모바일 보고서 생성 이력" })).getByRole("button", {
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
  initialEntry?: string;
} = {}) {
  return render(pageTree(activeSiteId, queryClient, initialEntry));
}

function pageTree(activeSiteId: string, queryClient: QueryClient, initialEntry = "/statistics/reports") {
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
  return <div>
    <button type="button" aria-label="브라우저 뒤로" onClick={() => navigate(-1)} />
    <button type="button" aria-label="브라우저 앞으로" onClick={() => navigate(1)} />
  </div>;
}

async function chooseSelect(label: string, option: string, container: HTMLElement = document.body) {
  const trigger = within(container).getByRole("button", { name: label });
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const choice = await screen.findByRole("option", { name: option });
  fireEvent.keyDown(choice, { key: "Enter" });
  fireEvent.keyUp(document.activeElement!, { key: "Enter" });
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
    request: { from: "2026-09-01", to: "2026-09-10", scope: "site" as const, identityId: siteId, format: "xlsx" as const },
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => { resolve = complete; });
  return { promise, resolve };
}
