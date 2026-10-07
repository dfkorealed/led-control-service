import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { InlineStatusSummary } from "../index";

afterEach(cleanup);
it("keeps unknown counts distinct from collected zero in one inline summary", () => {
  render(<InlineStatusSummary label="도면 상태" items={[
    { id: "unknown", label: "오프라인", value: null, tone: "neutral" },
    { id: "zero", label: "장애", value: 0, tone: "danger" }
  ]} />);
  const group = screen.getByRole("group", { name: "도면 상태" });
  expect(within(group).getByText("—")).toBeInTheDocument();
  expect(within(group).getByText("0")).toBeInTheDocument();
  expect(within(group).getByText("장애")).toHaveClass("text-body-sm");
  expect(within(group).getByText("0")).toHaveClass("text-body");
});
