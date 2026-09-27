import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

  it("shows only search, status, and request dates until the advanced filters are expanded", () => {
    render(<FilterHarness initial={{ limit: 20 }} />);

    expect(screen.getByRole("searchbox", { name: "보고서 검색" })).toBeVisible();
    expect(screen.getByRole("button", { name: "상태" })).toBeVisible();
    expect(screen.getByRole("group", { name: "요청 기간" })).toBeVisible();
    const disclosure = screen.getByRole("button", { name: "상세 필터" });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("button", { name: "파일 형식" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "범위" })).not.toBeInTheDocument();

    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.queryByRole("button", { name: "파일 형식" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "범위" })).toBeVisible();
    fireEvent.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(readState()).toEqual({ limit: 20 });
  });

  it("emits the responsive CSS used by the report filter layout at the tablet breakpoint", async () => {
    render(<FilterHarness initial={{ limit: 20 }} />);
    const filters = screen.getByRole("search", { name: "보고서 이력 필터" });
    const classes = Array.from(filters.querySelectorAll<HTMLElement>("[class]"))
      .flatMap((element) => Array.from(element.classList));
    const candidates = [
      { candidate: classes.find((name) => name.includes(":grid-cols-[minmax(0,2fr)_")), declaration: "grid-template-columns: minmax(0,2fr) minmax(0,1fr) minmax(0,2fr) auto" },
      { candidate: classes.find((name) => name.endsWith(":col-span-1")), declaration: "grid-column: span 1 / span 1" },
      { candidate: classes.find((name) => name.endsWith(":w-auto")), declaration: "width: auto" }
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

  it("keeps active advanced conditions visible and unchanged when the panel is collapsed", () => {
    render(<FilterHarness initial={{ limit: 50, cursor: "older-page", scope: "floor" }} />);

    const disclosure = screen.getByRole("button", { name: /상세 필터/ });
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(disclosure).toHaveTextContent("1개 적용");
    expect(screen.getByRole("button", { name: "범위: 층 조건 제거" })).toBeVisible();

    fireEvent.click(disclosure);
    expect(screen.getByRole("button", { name: "범위" })).toHaveTextContent("층");
    fireEvent.click(disclosure);
    expect(readState()).toEqual({ limit: 50, cursor: "older-page", scope: "floor" });
  });

  it("explains that request dates are not the report document period", () => {
    render(<FilterHarness initial={{ limit: 20 }} />);

    expect(screen.getByRole("group", { name: "요청 기간" })).toHaveAttribute("aria-describedby");
    expect(screen.getByText("보고서를 요청한 날짜로 검색합니다. 보고서 본문 대상 기간과 다릅니다.")).toBeVisible();
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
    expect(screen.getByRole("button", { name: "상태" })).toHaveTextContent("완료");
    fireEvent.click(screen.getByRole("button", { name: /상세 필터/ }));
    expect(screen.getByRole("button", { name: "범위" })).toHaveTextContent("층");
    expect(screen.getByRole("button", { name: "요청 기간: 2026-09-01 ~ 2026-09-15 조건 제거" })).toHaveClass("min-h-11");

    fireEvent.click(screen.getByRole("button", { name: "상태: 완료 조건 제거" }));
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
    fireEvent.click(screen.getByRole("button", { name: /상세 필터/ }));
    fireEvent.click(screen.getByRole("button", { name: "전체 초기화" }));

    expect(screen.getByRole("searchbox", { name: "보고서 검색" })).toHaveValue("");
    expect(screen.getByRole("button", { name: "상태" })).toHaveTextContent("전체 상태");
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
