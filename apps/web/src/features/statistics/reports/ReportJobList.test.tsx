import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { EnergyReportJob } from "@led-control/shared/energy-p2-contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportJobList } from "./ReportJobList";

describe("ReportJobList", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("adapts to the actual container and retains failed and expired actions and all fields", () => {
    let resize: ResizeObserverCallback = () => {};
    let target: Element;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: ResizeObserverCallback) { resize = callback; }
      observe(element: Element) { target = element; }
      disconnect() {}
    });
    const regenerate = vi.fn();
    const reports = (["failed", "expired"] as const).map((status, index): EnergyReportJob => ({
      reportId: `30000000-0000-4000-8000-00000000004${index}`,
      siteId: "30000000-0000-4000-8000-000000000001",
      request: { from: "2026-09-01", to: "2026-09-10", scope: "floor", identityId: "30000000-0000-4000-8000-000000000002", format: "pdf" },
      status, progressPercent: 0, createdAt: "2026-09-10T00:00:00Z", requestedAt: "2026-09-10T00:00:00Z",
      startedAt: null, completedAt: null, expiresAt: null,
      target: { scope: "floor", identityId: "30000000-0000-4000-8000-000000000002", label: `${status} 긴 대상명` },
      ...(status === "failed" ? { failureCode: "REPORT_GENERATION_FAILED", failure: { code: "generation_failed" as const, message: "보고서를 생성하지 못했습니다.", action: "잠시 후 다시 생성해 주세요." } } : { failureCode: null, failure: null })
    }));
    render(<ReportJobList reports={reports} timeZone="Asia/Seoul" isLoading={false} isError={false}
      onRetry={vi.fn()} onRegenerate={regenerate} onDownload={vi.fn()} />);
    const measure = (width: number) => act(() => resize([{ target, contentRect: { width } } as ResizeObserverEntry], {} as ResizeObserver));
    measure(400);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    const cards = screen.getByRole("list", { name: "보고서 생성 이력" });
    expect(within(cards).getAllByRole("term").slice(0, 4).map(node => node.textContent)).toEqual(["대상", "상태", "기간", "작업"]);
    expect(within(cards).queryByText("범위")).not.toBeInTheDocument();
    fireEvent.click(within(cards).getByRole("button", { name: "failed 긴 대상명 보고서 상세보기" }));
    expect(within(cards).getByRole("region", { name: "failed 긴 대상명 실패 안내" })).toHaveTextContent("잠시 후 다시 생성해 주세요.");
    measure(1440);
    expect(screen.queryByRole("list", { name: "보고서 생성 이력" })).not.toBeInTheDocument();
    const table = screen.getByRole("table", { name: "보고서 생성 이력" });
    fireEvent.click(within(table).getByRole("button", { name: "대상 오름차순 정렬" }));
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("expired 긴 대상명");
    fireEvent.click(within(table).getByRole("button", { name: "대상 내림차순 정렬" }));
    expect(within(table).getAllByRole("row")[1]).toHaveTextContent("failed 긴 대상명");
    expect(within(table).getAllByRole("columnheader").every(header => header.classList.contains("text-center"))).toBe(true);
    expect(table).toHaveTextContent("층");
    fireEvent.click(within(table).getByRole("button", { name: "expired 긴 대상명 보고서 다시 생성" }));
    expect(regenerate).toHaveBeenCalledWith(reports[1]);
    measure(400);
    expect(screen.getByRole("region", { name: "failed 긴 대상명 실패 안내" })).toBeInTheDocument();
  });

  it("keeps an empty retained page and its refresh recovery in one feedback surface", async () => {
    const retry = vi.fn();
    render(<ReportJobList reports={[]} isLoading={false} isError={false} hasRefreshError
      onRetry={retry} onRegenerate={vi.fn()} onDownload={vi.fn()} />);

    const emptyState = screen.getByRole("status", { name: "보고서 빈 목록" });
    const notice = within(emptyState).getByRole("button", { name: "목록 갱신 실패 안내" });
    expect(screen.queryByText(/시각:.*시간대/)).not.toBeInTheDocument();
    fireEvent.click(notice);
    const details = await screen.findByRole("dialog", { name: "목록 갱신 실패 안내" });
    expect(details).toHaveTextContent("기존 결과를 표시합니다.");
    fireEvent.click(within(details).getByRole("button", { name: "다시 시도" }));
    expect(retry).toHaveBeenCalledOnce();
  });

  it("keeps initial list failures as blocking feedback with direct retry", () => {
    const retry = vi.fn();
    render(<ReportJobList isLoading={false} isError onRetry={retry}
      onRegenerate={vi.fn()} onDownload={vi.fn()} />);

    const failure = screen.getByRole("alert");
    expect(failure).toHaveTextContent("보고서 목록을 불러오지 못했습니다.");
    fireEvent.click(within(failure).getByRole("button", { name: "다시 시도" }));
    expect(retry).toHaveBeenCalledOnce();
    expect(screen.queryByRole("button", { name: "목록 갱신 실패 안내" })).not.toBeInTheDocument();
  });

  it("retains the warning trigger but prevents a second retry while fetching", async () => {
    const retry = vi.fn();
    render(<ReportJobList reports={[]} isLoading={false} isError={false} hasRefreshError isBusy
      onRetry={retry} onRegenerate={vi.fn()} onDownload={vi.fn()} />);

    const warning = screen.getByRole("button", { name: "목록 갱신 실패 안내" });
    fireEvent.click(warning);
    const details = await screen.findByRole("dialog", { name: "목록 갱신 실패 안내" });
    expect(within(details).getByRole("status")).toHaveTextContent("확인 중");
    expect(within(details).queryByRole("button", { name: "다시 시도" })).not.toBeInTheDocument();
    expect(retry).not.toHaveBeenCalled();
  });
});
