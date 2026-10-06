import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import * as UI from "./index";
afterEach(cleanup);
it("centers semantic column headers by default and permits an explicit alignment", () => {
  expect(UI.DataTableHeaderCell).toBeTypeOf("function");
  render(<table><thead><tr><UI.DataTableHeaderCell>기본</UI.DataTableHeaderCell><UI.DataTableHeaderCell align="right" className="consumer-cell">수치</UI.DataTableHeaderCell></tr></thead></table>);
  expect(screen.getByRole("columnheader", { name: "기본" })).toHaveClass("text-center");
  expect(screen.getByRole("columnheader", { name: "기본" })).toHaveAttribute("scope", "col");
  expect(screen.getByRole("columnheader", { name: "수치" })).toHaveClass("text-right", "consumer-cell");
});
