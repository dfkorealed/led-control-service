import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DataTableShell } from "./DataTableShell";

describe("DataTableShell", () => {
  afterEach(cleanup);

  it("keeps table semantics, an accessible caption, busy state and horizontal overflow inside the card", () => {
    const { rerender } = render(
      <DataTableShell caption="보고서 생성 이력" isBusy className="report-table-shell">
        <thead><tr><th scope="col">대상</th></tr></thead>
        <tbody><tr><td>서울 물류센터</td></tr></tbody>
      </DataTableShell>
    );

    const table = screen.getByRole("table", { name: "보고서 생성 이력" });
    expect(table).toHaveClass("w-full", "min-w-5xl", "border-collapse", "text-body-sm");
    expect(screen.getByText("보고서 생성 이력", { selector: "caption" })).toHaveClass("sr-only");
    expect(table.parentElement).toHaveClass("min-w-0", "overflow-x-auto");
    expect(table.parentElement).toHaveAttribute("aria-busy", "true");
    expect(table.closest("section")).toHaveClass("report-table-shell", "min-w-0", "overflow-hidden");

    rerender(
      <DataTableShell caption="보고서 생성 이력" isBusy={false}>
        <tbody><tr><td>서울 물류센터</td></tr></tbody>
      </DataTableShell>
    );
    expect(screen.getByRole("table").parentElement).not.toHaveAttribute("aria-busy");
  });
});
