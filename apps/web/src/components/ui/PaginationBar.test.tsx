import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PaginationBar } from "./PaginationBar";

describe("PaginationBar", () => {
  afterEach(cleanup);

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

  it("shows an empty total, disables both directions and keeps compact controls touch-sized", () => {
    render(
      <PaginationBar
        page={1}
        pageSize={10}
        totalCount={0}
        hasPrevious
        hasNext
        onPrevious={vi.fn()}
        onNext={vi.fn()}
        onPageSizeChange={vi.fn()}
        className="report-pagination"
      />
    );

    const navigation = screen.getByRole("navigation", { name: "페이지 이동" });
    expect(navigation).toHaveClass("report-pagination", "grid", "min-w-0");
    expect(screen.getByText("0건")).toBeInTheDocument();
    for (const name of ["이전 페이지", "다음 페이지"]) {
      expect(screen.getByRole("button", { name })).toBeDisabled();
      expect(screen.getByRole("button", { name })).toHaveClass("min-h-11", "min-w-11");
    }
  });
});
