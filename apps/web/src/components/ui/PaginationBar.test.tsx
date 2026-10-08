import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaginationBar, type PaginationBarProps, type DefaultPaginationPageSize } from "./PaginationBar";

// These fixtures are typechecked but never mounted.
function paginationTypeContract() {
  const common = { page: 1, hasPrevious: false, hasNext: false, onPrevious() {}, onNext() {} };
  const legacy = <PaginationBar {...common} totalCount={0} pageSize={20} onPageSizeChange={(size: DefaultPaginationPageSize) => void size} />;
  const custom = <PaginationBar {...common} mode="cursor" itemCount={0} pageSizeOptions={[50, 100, 500, 1000] as const} pageSize={1000} onPageSizeChange={(size: 50 | 100 | 500 | 1000) => void size} />;
  const unknown = <PaginationBar {...common} mode="cursor" itemCount={null} pageSize={50} onPageSizeChange={(size: DefaultPaginationPageSize) => void size} />;
  // @ts-expect-error Cursor mode must not invent a total.
  const fakeTotal: PaginationBarProps = { ...common, mode: "cursor", totalCount: 10, itemCount: 10, pageSize: 50, onPageSizeChange() {} };
  // @ts-expect-error Extended sizes require explicit matching options.
  const missingOptions = <PaginationBar {...common} totalCount={0} pageSize={500} onPageSizeChange={() => {}} />;
  // @ts-expect-error Do not infer an unsupported selected size into the options domain.
  const wrongSelection = <PaginationBar {...common} totalCount={0} pageSizeOptions={[50, 100] as const} pageSize={1000} onPageSizeChange={() => {}} />;
  // @ts-expect-error A four-size handler cannot consume 500/1000 from explicit options.
  const narrowHandler = <PaginationBar {...common} mode="cursor" itemCount={0} pageSizeOptions={[50, 100, 500, 1000] as const} pageSize={50} onPageSizeChange={(size: 10 | 20 | 50 | 100) => void size} />;
  return [legacy, custom, unknown, fakeTotal, missingOptions, wrongSelection, narrowHandler];
}
void paginationTypeContract;

describe("PaginationBar", () => {
  it("moves only page size selection out when opted in and retains page navigation", () => {
    render(<PaginationBar mode="cursor" page={2} pageSize={50} pageSizeOptions={[50, 100, 500, 1000] as const} itemCount={17}
      showPageSizeSelector={false} hasPrevious hasNext onPrevious={() => {}} onNext={() => {}} onPageSizeChange={() => {}} />);
    expect(screen.queryByRole("button", { name: "페이지당 항목 수" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "이전 페이지" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "다음 페이지" })).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("2페이지현재 17건");
  });
  it("validates duplicate options even while the page size selector is hidden", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() => render(<PaginationBar mode="cursor" page={1} pageSize={50} pageSizeOptions={[50, 50] as const} itemCount={0}
        showPageSizeSelector={false} hasPrevious={false} hasNext={false} onPrevious={() => {}} onNext={() => {}} onPageSizeChange={() => {}} />)).toThrow(RangeError);
    } finally { error.mockRestore(); }
  });
  afterEach(cleanup);

  const cursorProps = {
    mode: "cursor" as const, page: 2, pageSize: 50 as const, itemCount: 17,
    pageSizeOptions: [50, 100, 500, 1000] as const,
    hasPrevious: true, hasNext: true,
    onPrevious: vi.fn(), onNext: vi.fn(), onPageSizeChange: vi.fn()
  };

  it("keeps an explicit subset's runtime options aligned with its numeric callback", async () => {
    const change = vi.fn<(size: 50 | 100) => void>();
    render(<PaginationBar mode="cursor" page={1} pageSize={50} pageSizeOptions={[50, 100] as const} itemCount={50} hasPrevious={false} hasNext onPrevious={vi.fn()} onNext={vi.fn()} onPageSizeChange={change} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "페이지당 항목 수" }), { key: "ArrowDown" });
    expect((await screen.findAllByRole("option")).map(option => option.textContent)).toEqual(["50개", "100개"]);
    fireEvent.keyDown(screen.getByRole("option", { name: "100개" }), { key: "Enter" });
    fireEvent.keyUp(document.activeElement!, { key: "Enter" });
    expect(change).toHaveBeenCalledOnce(); expect(change).toHaveBeenCalledWith(100);
  });

  it("rejects a controlled size outside its options at runtime as well as in types", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // @ts-expect-error Exercise a malformed JavaScript caller, without coercing the controlled value.
      expect(() => render(<PaginationBar mode="cursor" page={1} pageSize={1000} pageSizeOptions={[50, 100] as const} itemCount={0} hasPrevious={false} hasNext={false} onPrevious={vi.fn()} onNext={vi.fn()} onPageSizeChange={vi.fn()} />)).toThrow(/pageSize must belong to pageSizeOptions/);
    } finally { error.mockRestore(); }
  });

  it("announces only the current cursor page and its actual rows", () => {
    render(<PaginationBar {...cursorProps} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("2페이지");
    expect(status).toHaveTextContent("현재 17건");
    expect(status.textContent).not.toMatch(/NaN|undefined|~|\/|마지막|전체/);
    expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument();
  });

  it("presents an unknown cursor count neutrally across known and genuine empty pages", () => {
    const view = render(<PaginationBar {...cursorProps} itemCount={null} />);
    const status = screen.getByRole("status");
    expect(status).toHaveTextContent("2페이지");
    expect(status.textContent).not.toMatch(/현재|건|null|undefined|NaN|전체|총/);
    view.rerender(<PaginationBar {...cursorProps} />);
    expect(status).toHaveTextContent("현재 17건");
    view.rerender(<PaginationBar {...cursorProps} itemCount={null} isPending />);
    expect(status.textContent).not.toMatch(/현재|건|null|undefined|NaN/);
    view.rerender(<PaginationBar {...cursorProps} itemCount={0} hasNext={false} />);
    expect(status).toHaveTextContent("현재 0건");
  });

  it.each(["이전 페이지", "다음 페이지", "페이지당 항목 수"])("keeps the focused %s identity through unknown pending and recovery", (name) => {
    const view = render(<PaginationBar {...cursorProps} />);
    const control = screen.getByRole("button", { name });
    control.focus();
    view.rerender(<PaginationBar {...cursorProps} itemCount={null} isPending />);
    expect(screen.getByRole("button", { name })).toBe(control);
    expect(control).toBeDisabled();
    expect(control).toHaveFocus();
    expect(screen.getByRole("status").textContent).not.toMatch(/현재|건|null|undefined/);
    view.rerender(<PaginationBar {...cursorProps} itemCount={null} />);
    expect(control).toBeEnabled();
    expect(control).toHaveFocus();
    view.rerender(<PaginationBar {...cursorProps} />);
    expect(control).toHaveFocus();
  });

  it.each([500, 1000] as const)("offers log page sizes and emits numeric %s once", async (size) => {
    const change = vi.fn();
    render(<PaginationBar {...cursorProps} onPageSizeChange={change} />);
    fireEvent.keyDown(screen.getByRole("button", { name: "페이지당 항목 수" }), { key: "ArrowDown" });
    expect((await screen.findAllByRole("option")).map(option => option.textContent)).toEqual(["50개", "100개", "500개", "1000개"]);
    fireEvent.keyDown(screen.getByRole("option", { name: `${size}개` }), { key: "Enter" });
    fireEvent.keyUp(document.activeElement!, { key: "Enter" });
    expect(change).toHaveBeenCalledOnce();
    expect(change).toHaveBeenCalledWith(size);
  });

  it("locks cursor controls while pending without remounting or resetting the selection", () => {
    const previous = vi.fn(); const next = vi.fn(); const change = vi.fn();
    const props = { ...cursorProps, onPrevious: previous, onNext: next, onPageSizeChange: change };
    const { rerender } = render(<PaginationBar {...props} />);
    const select = screen.getByRole("button", { name: "페이지당 항목 수" });
    select.focus();
    rerender(<PaginationBar {...props} isPending />);
    expect(screen.getByRole("button", { name: "페이지당 항목 수" })).toBe(select);
    expect(select).toHaveFocus();
    for (const name of ["페이지당 항목 수", "이전 페이지", "다음 페이지"]) {
      const button = screen.getByRole("button", { name });
      expect(button).toBeDisabled();
      fireEvent.click(button); fireEvent.keyDown(button, { key: "Enter" }); fireEvent.keyUp(button, { key: "Enter" });
    }
    fireEvent.keyDown(select, { key: "ArrowDown" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(previous).not.toHaveBeenCalled(); expect(next).not.toHaveBeenCalled(); expect(change).not.toHaveBeenCalled();
    expect(screen.getByRole("status")).toHaveTextContent("현재 17건");
    rerender(<PaginationBar {...props} />);
    expect(select).toBeEnabled(); expect(select).toHaveTextContent("50개");
  });

  it("preserves previous access on an empty cursor page", () => {
    const previous = vi.fn();
    render(<PaginationBar {...cursorProps} itemCount={0} hasNext={false} onPrevious={previous} />);
    expect(screen.getByRole("status")).toHaveTextContent("현재 0건");
    fireEvent.click(screen.getByRole("button", { name: "이전 페이지" }));
    expect(previous).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "다음 페이지" })).toBeDisabled();
  });

  it("also locks the legacy total mode while pending", () => {
    render(<PaginationBar page={2} pageSize={20} totalCount={137} hasPrevious hasNext isPending onPrevious={vi.fn()} onNext={vi.fn()} onPageSizeChange={vi.fn()} />);
    expect(screen.getByText("21~40 / 137건")).toBeInTheDocument();
    for (const name of ["페이지당 항목 수", "이전 페이지", "다음 페이지"]) expect(screen.getByRole("button", { name })).toBeDisabled();
  });

  it("announces the current range and sends previous and next navigation events", () => {
    const onPrevious = vi.fn();
    const onNext = vi.fn();

    render(
      <PaginationBar
        page={2}
        pageSize={20}
        totalCount={137}
        hasPrevious
        hasNext
        onPrevious={onPrevious}
        onNext={onNext}
        onPageSizeChange={vi.fn()}
      />
    );

    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveTextContent("2페이지");
    expect(screen.getByText("21~40 / 137건")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "이전 페이지" }));
    fireEvent.click(screen.getByRole("button", { name: "다음 페이지" }));
    expect(onPrevious).toHaveBeenCalledOnce();
    expect(onNext).toHaveBeenCalledOnce();
  });

  it("offers only 10, 20, 50 and 100 rows and reports a numeric page-size change", async () => {
    const onPageSizeChange = vi.fn();
    render(
      <PaginationBar
        page={1}
        pageSize={20}
        totalCount={137}
        hasPrevious={false}
        hasNext
        onPrevious={vi.fn()}
        onNext={vi.fn()}
        onPageSizeChange={onPageSizeChange}
      />
    );

    const trigger = screen.getByRole("button", { name: "페이지당 항목 수" });
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect((await screen.findAllByRole("option")).map((option) => option.textContent)).toEqual(["10개", "20개", "50개", "100개"]);

    const option = screen.getByRole("option", { name: "50개" });
    fireEvent.keyDown(option, { key: "Enter" });
    fireEvent.keyUp(document.activeElement!, { key: "Enter" });
    expect(onPageSizeChange).toHaveBeenCalledOnce();
    expect(onPageSizeChange).toHaveBeenCalledWith(50);
  });

  it("disables only previous on a non-empty first page", () => {
    render(
      <PaginationBar
        page={1}
        pageSize={20}
        totalCount={137}
        hasPrevious={false}
        hasNext
        onPrevious={vi.fn()}
        onNext={vi.fn()}
        onPageSizeChange={vi.fn()}
      />
    );

    expect(screen.getByRole("button", { name: "이전 페이지" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "다음 페이지" })).toBeEnabled();
  });

  it("shows the last partial range and disables only next", () => {
    render(
      <PaginationBar
        page={7}
        pageSize={20}
        totalCount={137}
        hasPrevious
        hasNext={false}
        onPrevious={vi.fn()}
        onNext={vi.fn()}
        onPageSizeChange={vi.fn()}
      />
    );

    expect(screen.getByText("121~137 / 137건")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "이전 페이지" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "다음 페이지" })).toBeDisabled();
  });

  it("keeps previous independently available when the current total is unavailable", () => {
    const onPrevious = vi.fn();
    render(
      <PaginationBar
        page={2}
        pageSize={10}
        totalCount={0}
        hasPrevious
        hasNext
        onPrevious={onPrevious}
        onNext={vi.fn()}
        onPageSizeChange={vi.fn()}
        className="report-pagination"
      />
    );

    const navigation = screen.getByRole("navigation", { name: "페이지 이동" });
    expect(navigation).toHaveClass("report-pagination", "flex", "min-w-0", "flex-col", "tablet:flex-row");
    expect(screen.getByText("0건")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "이전 페이지" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "다음 페이지" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "이전 페이지" }));
    expect(onPrevious).toHaveBeenCalledOnce();
    for (const name of ["이전 페이지", "다음 페이지"]) expect(screen.getByRole("button", { name })).toHaveClass("min-h-11", "min-w-11");
  });
});
