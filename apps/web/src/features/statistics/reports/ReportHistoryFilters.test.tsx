import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { readFile } from "node:fs/promises";
import { useState } from "react";
import { compile } from "tailwindcss";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReportHistoryFilters } from "./ReportHistoryFilters";
import type { ReportHistoryFilterState } from "./report-history-filters";

describe("ReportHistoryFilters", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows all five report filters without an advanced disclosure", () => {
    render(<FilterHarness initial={{ limit: 20 }} />);

    expect(screen.getByRole("searchbox", { name: "보고서 검색" })).toBeVisible();
    expect(screen.getByRole("button", { name: "상태" })).toBeVisible();
    expect(screen.getByRole("button", { name: /요청 기간 선택, 현재 전체 기간/ })).toBeVisible();
    expect(screen.queryByRole("group", { name: "요청 기간" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /상세 필터/ })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "파일 형식" })).toBeVisible();
    expect(screen.getByRole("button", { name: "범위" })).toBeVisible();
    expect(readState()).toEqual({ limit: 20 });
  });

  it("emits the responsive CSS used by the report filter layout at the tablet breakpoint", async () => {
    render(<FilterHarness initial={{ limit: 20 }} />);
    const filters = screen.getByRole("search", { name: "보고서 이력 필터" });
    const classes = Array.from(filters.querySelectorAll<HTMLElement>("[class]"))
      .flatMap((element) => Array.from(element.classList));
    const candidates = [
      { candidate: classes.find((name) => name.includes(":grid-cols-[minmax(0,1.4fr)_")), declaration: "grid-template-columns: minmax(0,1.4fr) minmax(0,0.9fr) minmax(0,1.5fr) minmax(0,0.9fr) minmax(0,0.9fr)" },
      { candidate: classes.find((name) => name.endsWith(":col-span-1")), declaration: "grid-column: span 1 / span 1" }
    ];
    const theme = await readFile("src/styles/theme.css", "utf8");

    for (const { candidate, declaration } of candidates) {
      expect(candidate).toBeDefined();
      const compiler = await compile(`@tailwind utilities;\n${theme}`);
      const css = compiler.build([candidate!]);
      expect(css).toContain("@media (width >= 64rem)");
      expect(css).toContain(declaration);
    }
  });

  it("keeps active format and scope conditions visible without changing query state", () => {
    render(<FilterHarness initial={{ limit: 50, cursor: "older-page", format: "pdf", scope: "floor" }} />);

    expect(screen.getByRole("button", { name: "형식: PDF 조건 제거" })).toBeVisible();
    expect(screen.getByRole("button", { name: "범위: 층 조건 제거" })).toBeVisible();
    expect(screen.getByRole("button", { name: "파일 형식" })).toHaveTextContent("PDF");
    expect(screen.getByRole("button", { name: "범위" })).toHaveTextContent("층");
    expect(readState()).toEqual({ limit: 50, cursor: "older-page", format: "pdf", scope: "floor" });
  });

  it("explains that request dates are not the report document period", () => {
    render(<FilterHarness initial={{ limit: 20 }} />);

    fireEvent.click(screen.getByRole("button", { name: /요청 기간 선택/ }));
    expect(screen.getByRole("group", { name: "요청 기간" })).toHaveAttribute("aria-describedby");
    expect(screen.getByText("보고서를 요청한 날짜로 검색합니다. 보고서 본문 대상 기간과 다릅니다.")).toBeVisible();
  });

  it("opens the compact request-date control and restores focus when closed", async () => {
    render(<FilterHarness initial={{ limit: 20, requestedFrom: "2026-09-01", requestedTo: "2026-09-15" }} />);
    const trigger = screen.getByRole("button", { name: /요청 기간 선택, 현재 2026-09-01 ~ 2026-09-15/ });

    fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "요청 기간 선택" })).toBeVisible();
    expect(screen.getByRole("group", { name: "요청 기간" }).querySelectorAll('[role="spinbutton"]')).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "요청 기간 선택 닫기" }));
    expect(screen.queryByRole("dialog", { name: "요청 기간 선택" })).not.toBeInTheDocument();
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
      format: "pdf",
      scope: "floor",
      requestedFrom: "2026-09-01",
      requestedTo: "2026-09-15"
    }} />);

    const filters = screen.getByRole("search", { name: "보고서 이력 필터" });
    expect(filters).toHaveClass("custom-filters", "min-w-0");
    expect(screen.getByRole("button", { name: "상태" })).toHaveTextContent("완료");
    expect(screen.getByRole("button", { name: "파일 형식" })).toHaveTextContent("PDF");
    expect(screen.getByRole("button", { name: "범위" })).toHaveTextContent("층");
    expect(screen.getByRole("button", { name: "요청 기간: 2026-09-01 ~ 2026-09-15 조건 제거" })).toHaveClass("min-h-11");

    fireEvent.click(screen.getByRole("button", { name: "상태: 완료 조건 제거" }));
    expect(screen.getByRole("button", { name: "상태" })).toHaveTextContent("전체 상태");
    expect(readState()).toEqual({
      limit: 50,
      format: "pdf",
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
      format: "pdf",
      scope: "site",
      requestedFrom: "2026-09-08",
      requestedTo: "2026-09-10"
    }} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "보고서 검색" }), { target: { value: "뒤늦은 검색" } });
    fireEvent.click(screen.getByRole("button", { name: "전체 초기화" }));

    expect(screen.getByRole("searchbox", { name: "보고서 검색" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "상태" })).toHaveTextContent("전체 상태");
    expect(screen.getByRole("button", { name: "파일 형식" })).toHaveTextContent("전체 형식");
    expect(screen.getByRole("button", { name: "범위" })).toHaveTextContent("전체 범위");
    expect(screen.queryByLabelText("활성 조건")).not.toBeInTheDocument();
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

    fireEvent.click(screen.getByRole("button", { name: /요청 기간 선택/ }));
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
