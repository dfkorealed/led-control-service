import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportJobList } from "./ReportJobList";

describe("ReportJobList", () => {
  afterEach(cleanup);

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
