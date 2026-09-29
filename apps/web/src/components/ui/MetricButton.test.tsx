import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MetricButton } from "./MetricButton";
afterEach(cleanup);
it("preserves metric content and native button semantics", () => {
  const click = vi.fn();
  const { rerender } = render(<MetricButton label="정상" value={0} selected onClick={click} />);
  const button = screen.getByRole("button", { name: "정상" });
  expect(button).toHaveTextContent("0");
  expect(button).toHaveAttribute("aria-pressed", "true");
  fireEvent.click(button); expect(click).toHaveBeenCalledOnce();
  rerender(<MetricButton label="정상" value="집계 준비 중" disabled onClick={click} />);
  fireEvent.click(button); expect(click).toHaveBeenCalledOnce();
});
