import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Outlet, Route, Routes } from "react-router-dom";
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
  useEnergyReports: (siteId: string | undefined) => reportsApi.reports(siteId),
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
    reportsApi.reports.mockReturnValue({ data: { reports }, isLoading: false, isError: false, refetch: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
  });
  afterEach(() => { cleanup(); vi.restoreAllMocks(); });

  it("uses analytics targets even when the operational dashboard contains no fixture details", async () => {
    dashboardState.data = { ...dashboard, floors: [{ ...dashboard.floors[0], fixtures: [] }] };
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));
    fireEvent.change(screen.getByLabelText("범위"), { target: { value: "fixture" } });
    expect(screen.getByLabelText("대상")).toHaveValue(targets.targets[1].identityId);
    fireEvent.click(screen.getByRole("button", { name: "보고서 요청" }));
    await waitFor(() => expect(reportsApi.create).toHaveBeenCalledWith(siteId, expect.objectContaining({ identityId: targets.targets[1].identityId })));
  });

  it("defaults and bounds both date controls to the server's last completed site-local day", () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));
    expect(screen.getByLabelText("기간 종료")).toHaveValue("2026-09-11");
    expect(screen.getByLabelText("기간 종료")).toHaveAttribute("max", "2026-09-11");
    expect(screen.getByLabelText("기간 시작")).toHaveValue("2026-08-13");
    fireEvent.change(screen.getByLabelText("기간 종료"), { target: { value: "2026-09-12" } });
    expect(screen.getByRole("button", { name: "보고서 요청" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "CSV 내보내기" })).toBeDisabled();
  });

  it("creates one standard XLSX or PDF report from a period and identity without section choices", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));

    const dialog = screen.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" });
    expect(within(dialog).getByLabelText("기간 시작")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("기간 종료")).toBeInTheDocument();
    expect(within(dialog).getByLabelText("범위")).toHaveValue("site");
    expect(within(dialog).getByLabelText("대상")).toHaveValue(siteId);
    expect(within(dialog).getByLabelText("파일 형식")).toHaveValue("xlsx");
    expect(dialog).toHaveTextContent("XLSX와 PDF는 동일한 표준 보고서 내용을 파일 형식만 다르게 제공합니다.");
    expect(within(dialog).queryByText(/섹션/)).not.toBeInTheDocument();

    fireEvent.change(within(dialog).getByLabelText("범위"), { target: { value: "fixture" } });
    fireEvent.change(within(dialog).getByLabelText("파일 형식"), { target: { value: "pdf" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "보고서 요청" }));

    await waitFor(() => expect(reportsApi.create).toHaveBeenCalledWith(siteId, expect.objectContaining({
      scope: "fixture", identityId: targets.targets[1].identityId, format: "pdf"
    })));
  });

  it("exports CSV with the same period and selected scope", async () => {
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" });
    fireEvent.change(within(dialog).getByLabelText("범위"), { target: { value: "floor" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "CSV 내보내기" }));

    await waitFor(() => expect(reportsApi.csv).toHaveBeenCalledWith(siteId, expect.objectContaining({
      scope: "floor", identityId: dashboard.floors[0].id
    })));
  });

  it("blocks fixture report actions while target data is loading instead of using the site identity", () => {
    targetState.data = undefined;
    targetState.isLoading = true;
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" });
    fireEvent.change(within(dialog).getByLabelText("범위"), { target: { value: "fixture" } });

    expect(within(dialog).getByRole("status")).toHaveTextContent("대상을 불러오는 중입니다.");
    expect(within(dialog).getByRole("button", { name: "CSV 내보내기" })).toBeDisabled();
    expect(within(dialog).getByRole("button", { name: "보고서 요청" })).toBeDisabled();
  });

  it("blocks fixture report actions when the selected scope has no target", () => {
    targetState.data = { ...targets, targets: targets.targets.slice(0, 1) };
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "보고서 만들기" }));
    const dialog = screen.getByRole("dialog", { name: "에너지 사용량 보고서 만들기" });
    fireEvent.change(within(dialog).getByLabelText("범위"), { target: { value: "fixture" } });

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

    expect(screen.getByText("대기 중")).toBeInTheDocument();
    expect(screen.getByText("생성 중 36%")).toBeInTheDocument();
    expect(screen.getByText("완료")).toBeInTheDocument();
    expect(screen.getByText("생성 실패")).toBeInTheDocument();
    expect(screen.getByText("만료됨")).toBeInTheDocument();
    expect(screen.getByText("대상 completed")).toBeInTheDocument();
    expect(screen.getAllByText("요청 시각")).toHaveLength(5);
    expect(screen.getAllByText("파일 만료 시각")).toHaveLength(2);
    expect(screen.getByRole("region", { name: "대상 failed 실패 안내" })).toHaveTextContent(
      "보고서를 생성하지 못했습니다.잠시 후 다시 생성해 주세요."
    );
    expect(screen.getByText("보고서와 CSV 비용은 당시 적용 단가의 저장 비용입니다.")).toBeInTheDocument();
    const requestedAt = screen.getAllByTitle("2026-09-10T00:00:00.000Z")[0];
    expect(requestedAt).toHaveAttribute("datetime", "2026-09-10T00:00:00.000Z");
    fireEvent.click(screen.getByRole("button", { name: "대상 completed 보고서 다운로드" }));
    await waitFor(() => expect(reportsApi.download).toHaveBeenCalledWith(siteId, reports[2].reportId));
    expect(screen.getByRole("button", { name: "대상 failed 보고서 다시 생성" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "대상 expired 보고서 다시 생성" })).toBeInTheDocument();
  });

  it("keeps report metadata and actions in separate wrapping regions", () => {
    renderPage();

    const completed = screen.getByRole("article", { name: "대상 completed 보고서" });
    expect(within(completed).getByRole("group", { name: "보고서 메타데이터" })).toHaveTextContent(
      "형식XLSX범위현장요청 시각"
    );
    expect(within(completed).getByRole("group", { name: "보고서 작업" })).toContainElement(
      within(completed).getByRole("button", { name: "대상 completed 보고서 다운로드" })
    );
  });

  it("keeps the report list available when a signed download request fails", async () => {
    reportsApi.download.mockRejectedValueOnce(new Error("download failed"));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "대상 completed 보고서 다운로드" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("보고서 다운로드를 완료하지 못했습니다.");
    expect(screen.getByRole("region", { name: "요청한 보고서" })).toBeInTheDocument();
  });

  it("keeps the report list available and reports a retry failure", async () => {
    reportsApi.create.mockRejectedValueOnce(new Error("retry failed"));
    renderPage();
    fireEvent.click(screen.getByRole("button", { name: "대상 failed 보고서 다시 생성" }));

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
      fireEvent.click(screen.getByRole("button", {
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

function renderPage() {
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/statistics/reports"]}>
        <Routes>
          <Route path="/statistics" element={<Outlet context={{ siteId }} />}>
            <Route path="reports" element={<StatisticsReportsPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  );
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
