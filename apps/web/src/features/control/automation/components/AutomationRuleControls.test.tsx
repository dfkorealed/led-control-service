import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationRuleControls, type AutomationListFilter } from "./AutomationRuleControls";

const filter: AutomationListFilter = { query: "", status: "all", syncStatus: "all", limit: 10 };

describe("AutomationRuleControls", () => {
  afterEach(cleanup);

  it("shows server-wide filtered count without inventing a total page count", () => {
    render(<AutomationRuleControls label="스케줄" filter={filter} filteredTotal={35} pageIndex={1}
      currentPageCount={10} hasNextPage onFilterChange={vi.fn()} onPrevious={vi.fn()} onNext={vi.fn()} />);

    expect(screen.getByRole("status")).toHaveTextContent("조건에 맞는 규칙 35건");
    expect(screen.getByRole("status")).toHaveTextContent("2번째 묶음 · 현재 10건");
    expect(screen.queryByText(/2\s*\/\s*4/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "이전" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "다음" })).toBeEnabled();
  });

  it("changes the literal search and disables cursor movement on an empty result", () => {
    const onFilterChange = vi.fn();
    const onNext = vi.fn();
    render(<AutomationRuleControls label="이벤트" filter={filter} filteredTotal={0} pageIndex={0}
      currentPageCount={0} hasNextPage={false} onFilterChange={onFilterChange} onPrevious={vi.fn()} onNext={onNext} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "이벤트 검색" }), { target: { value: "입구_%" } });
    expect(onFilterChange).toHaveBeenCalledWith({ ...filter, query: "입구_%" });
    expect(screen.getByRole("status")).toHaveTextContent("조건에 맞는 규칙 0건");
    expect(screen.getByRole("button", { name: "이전" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "다음" })).toBeDisabled();
    expect(onNext).not.toHaveBeenCalled();
  });
});
