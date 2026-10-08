import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportHistoryFilters } from "./ReportHistoryFilters";
import type { ReportHistoryFilterState } from "./report-history-filters";

describe("ReportHistoryFilters", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("keeps search outside and resets only detailed filters including page size", () => {
    render(<FilterHarness initial={{ limit: 50, query: "서울", status: "failed", scope: "floor", cursor: "old" }} />);
    expect(screen.getByRole("searchbox", { name: "보고서 검색" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "상태" })).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: /보고서 조건 상세 필터, 활성 조건 3개/ });
    act(() => trigger.focus());
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "보고서 조건" })).not.toContainElement(screen.getByRole("searchbox", { hidden: true }));
    fireEvent.click(screen.getByRole("button", { name: "필터 초기화" }));
    expect(readState()).toEqual({ limit: 20, query: "서울" });
    fireEvent.click(screen.getByRole("button", { name: "필터 닫기" }));
    expect(screen.getByRole("searchbox")).toHaveValue("서울");
  });

  it.each([
    { name: "partial", start: "2026-09-01", end: null, segments: ["2026", "9", "1", "연도", "월", "일"] },
    { name: "impossible", start: "2026-02-31", end: "2026-09-01", segments: ["2026", "2", "31", "2026", "9", "1"] }
  ])("retains cold $name requested date segments before physical blur and reopen", async ({ start, end, segments }) => {
    const change = vi.fn();
    render(<ReportHistoryFilters value={{ limit: 20 }} onChange={change} invalidRequestedRange={{ start, end }} />);
    openReportFilters();
    const fields = within(screen.getByRole("group", { name: "요청 기간" })).getAllByRole("spinbutton");
    await waitFor(() => expect(fields.map(field => field.textContent)).toEqual(segments));
    act(() => fields[0].focus());
    act(() => screen.getByRole("button", { name: "필터 닫기" }).focus());
    expect(change).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "필터 닫기" }));
    openReportFilters();
    expect(within(screen.getByRole("group", { name: "요청 기간" })).getAllByRole("spinbutton").map(field => field.textContent)).toEqual(segments);
    expect(change).not.toHaveBeenCalled();
  });


  it("preserves partial range dates across popover close without publishing a stale filter", () => {
    render(<FilterHarness initial={{ limit: 20, requestedFrom: "2026-09-01", requestedTo: "2026-09-15" }} />);
    fireEvent.click(screen.getByRole("button", { name: /보고서 조건 상세 필터/ }));
    const year = within(screen.getByRole("group", { name: "요청 기간" })).getAllByRole("spinbutton")[0];
    fireEvent.keyDown(year, { key: "Backspace" });
    fireEvent.click(screen.getByRole("button", { name: "필터 닫기" }));
    fireEvent.click(screen.getByRole("button", { name: /보고서 조건 상세 필터/ }));
    expect(within(screen.getByRole("group", { name: "요청 기간" })).getAllByRole("spinbutton")[0]).not.toHaveTextContent("2026");
    expect(readState()).toEqual({ limit: 20, requestedFrom: "2026-09-01", requestedTo: "2026-09-15" });
  });

  it("does not replay a pending search or partial range across A→B→A scope visits", () => {
    vi.useFakeTimers();
    const onChange = vi.fn();
    const value = { limit: 20 as const, requestedFrom: "2026-09-01", requestedTo: "2026-09-15" };
    const view = render(<ReportHistoryFilters value={value} onChange={onChange} scopeKey="A" />);
    fireEvent.change(screen.getByRole("searchbox"), { target: { value: "A의 이전 초안" } });
    openReportFilters();
    fireEvent.keyDown(screen.getByRole("group", { name: "요청 기간" }).querySelector('[role="spinbutton"]')!, { key: "Backspace" });
    fireEvent.click(screen.getByRole("button", { name: "필터 닫기" }));
    view.rerender(<ReportHistoryFilters value={value} onChange={onChange} scopeKey="B" />);
    view.rerender(<ReportHistoryFilters value={value} onChange={onChange} scopeKey="A" />);
    act(() => vi.advanceTimersByTime(300));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("searchbox")).toHaveValue("");
    openReportFilters();
    expect(within(screen.getByRole("group", { name: "요청 기간" })).getAllByRole("spinbutton")[0]).toHaveTextContent("2026");
  });

  it("opens every non-search PDF report condition inside the shared popover", () => {
    render(<FilterHarness initial={{ limit: 20 }} />);

    expect(screen.getByRole("searchbox", { name: "보고서 검색" })).toBeVisible();
    openReportFilters();
    expect(screen.getByRole("button", { name: "상태" })).toBeVisible();
    expect(screen.getByRole("group", { name: "요청 기간" })).toBeVisible();
    expect(screen.getByRole("button", { name: "페이지 크기" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "파일 형식" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "범위" })).toBeVisible();
    expect(readState()).toEqual({ limit: 20 });
  });

  it("shares wrapping field, condition and action slots while retaining the search landmark", () => {
    render(<FilterHarness initial={{ limit: 20 }} />);
    const filters = screen.getByRole("search", { name: "보고서 이력 필터" });
    const panel = screen.getByRole("region", { name: "보고서 조건" });
    expect(filters).toContainElement(panel);
    expect(panel.firstElementChild).toHaveClass("flex-wrap", "items-end");
    expect(screen.queryByRole("button", { name: "전체 초기화" })).not.toBeInTheDocument();
  });

  it("keeps active scope conditions visible without changing query state", () => {
    render(<FilterHarness initial={{ limit: 50, cursor: "older-page", scope: "floor" }} />);

    expect(screen.getByRole("button", { name: "범위: 층 조건 제거" })).toBeVisible();
    openReportFilters();
    expect(screen.getByRole("button", { name: "범위" })).toHaveTextContent("층");
    expect(readState()).toEqual({ limit: 50, cursor: "older-page", scope: "floor" });
  });

  it("explains that request dates are not the report document period", () => {
    render(<FilterHarness initial={{ limit: 20 }} />);

    openReportFilters();
    expect(screen.getByRole("group", { name: "요청 기간" })).toHaveAttribute("aria-describedby");
    expect(screen.getByText("보고서를 요청한 날짜로 검색합니다. 보고서 본문 대상 기간과 다릅니다.")).toBeVisible();
  });

  it("opens the compact request-date control and restores focus when closed", async () => {
    const change = vi.fn();
    render(<ReportHistoryFilters value={{ limit: 20, requestedFrom: "2026-09-01", requestedTo: "2026-09-15" }} onChange={change} />);
    const trigger = screen.getByRole("button", { name: /보고서 조건 상세 필터/ });

    act(() => trigger.focus());
    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "보고서 조건" })).toBeVisible();
    expect(screen.getByRole("group", { name: "요청 기간" }).querySelectorAll('[role="spinbutton"]')).toHaveLength(6);
    await waitFor(() => expect(screen.getByRole("dialog", { name: "보고서 조건" })).toContainElement(document.activeElement as HTMLElement));
    fireEvent.click(screen.getByRole("button", { name: "필터 닫기" }));
    expect(screen.queryByRole("dialog", { name: "보고서 조건" })).not.toBeInTheDocument();
    expect(change).not.toHaveBeenCalled();
    await waitFor(() => expect(trigger).toHaveFocus());
  });

  it("commits trimmed search after 300ms, removes the cursor and ignores intermediate input", () => {
    vi.useFakeTimers();
    render(<FilterHarness initial={{ limit: 20, cursor: "older-page" }} />);

    const search = screen.getByRole("searchbox", { name: "보고서 검색" });
    fireEvent.change(search, { target: { value: " 서" } });
    fireEvent.change(search, { target: { value: " 서울 " } });
    act(() => vi.advanceTimersByTime(299));
    expect(readState()).toEqual({ limit: 20, cursor: "older-page" });

    act(() => vi.advanceTimersByTime(1));
    expect(readState()).toEqual({ limit: 20, query: "서울" });
  });

  it("cleans a pending search update when its active-condition chip is removed", () => {
    vi.useFakeTimers();
    render(<FilterHarness initial={{ limit: 20, cursor: "older-page", query: "기존 검색" }} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "보고서 검색" }), { target: { value: "뒤늦은 검색" } });
    fireEvent.click(screen.getByRole("button", { name: "검색: 기존 검색 조건 제거" }));
    expect(screen.getByRole("searchbox", { name: "보고서 검색" })).toHaveValue("");
    expect(readState()).toEqual({ limit: 20 });

    act(() => vi.advanceTimersByTime(300));
    expect(readState()).toEqual({ limit: 20 });
  });

  it("removes a status chip from both the controlled field and URL state while preserving calendar dates", () => {
    render(<FilterHarness initial={{
      limit: 50,
      cursor: "older-page",
      status: "completed",
      scope: "floor",
      requestedFrom: "2026-09-01",
      requestedTo: "2026-09-15"
    }} />);

    const filters = screen.getByRole("search", { name: "보고서 이력 필터" });
    expect(filters).toHaveClass("custom-filters", "min-w-0");
    openReportFilters();
    expect(screen.getByRole("button", { name: "상태" })).toHaveTextContent("완료");
    expect(screen.getByRole("button", { name: "범위" })).toHaveTextContent("층");
    expect(screen.getByRole("button", { name: "요청 기간: 2026-09-01 ~ 2026-09-15 조건 제거", hidden: true })).toHaveClass("min-h-11");

    fireEvent.click(screen.getByRole("button", { name: "필터 닫기" }));
    fireEvent.click(screen.getByRole("button", { name: "상태: 완료 조건 제거" }));
    openReportFilters();
    expect(screen.getByRole("button", { name: "상태" })).toHaveTextContent("전체 상태");
    expect(readState()).toEqual({
      limit: 50,
      scope: "floor",
      requestedFrom: "2026-09-01",
      requestedTo: "2026-09-15"
    });
  });

  it("clears every active condition and cursor with one action while preserving the page size", () => {
    vi.useFakeTimers();
    render(<FilterHarness initial={{
      limit: 50,
      cursor: "older-page",
      query: "서울",
      status: "completed",
      scope: "site",
      requestedFrom: "2026-09-08",
      requestedTo: "2026-09-10"
    }} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "보고서 검색" }), { target: { value: "뒤늦은 검색" } });
    fireEvent.click(screen.getByRole("button", { name: "전체 초기화" }));

    expect(screen.getByRole("searchbox", { name: "보고서 검색" })).toHaveValue("");
    openReportFilters();
    expect(screen.getByRole("button", { name: "상태" })).toHaveTextContent("전체 상태");
    expect(screen.getByRole("button", { name: "범위" })).toHaveTextContent("전체 범위");
    expect(screen.queryByLabelText("활성 조건")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "필터 닫기" }));
    expect(readState()).toEqual({ limit: 50 });

    act(() => vi.advanceTimersByTime(300));
    expect(readState()).toEqual({ limit: 50 });
  });

  it("keeps an over-90-day date draft editable without committing it, then clears the error for a valid range", () => {
    const onChange = vi.fn();
    render(<ReportHistoryFilters
      value={{
        limit: 20,
        cursor: "older-page",
        requestedFrom: "2026-01-01",
        requestedTo: "2026-02-01"
      }}
      onChange={onChange}
    />);

    openReportFilters();
    const endYear = screen.getAllByRole("spinbutton")[3];
    expect(() => fireEvent.keyDown(endYear, { key: "ArrowUp" })).not.toThrow();
    expect(endYear).toHaveTextContent("2027");
    expect(screen.getByRole("alert")).toHaveTextContent("요청 기간은 최대 90일까지 선택할 수 있습니다.");
    expect(onChange).not.toHaveBeenCalled();

    fireEvent.keyDown(endYear, { key: "ArrowDown" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith({
      limit: 20,
      requestedFrom: "2026-01-01",
      requestedTo: "2026-02-01"
    });
  });
});

function FilterHarness({ initial }: { initial: ReportHistoryFilterState }) {
  const [value, setValue] = useState(initial);
  return <>
    <ReportHistoryFilters value={value} onChange={setValue} className="custom-filters" />
    <output data-testid="filter-state">{JSON.stringify(value)}</output>
  </>;
}

function readState() {
  return JSON.parse(screen.getByTestId("filter-state").textContent ?? "null");
}

function openReportFilters() {
  if (!screen.queryByRole("dialog", { name: "보고서 조건" })) fireEvent.click(screen.getByRole("button", { name: /보고서 조건 상세 필터/ }));
}
