import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OperationMapPanel as Panel } from "../index";

afterEach(cleanup);
it("groups title and tools before the right summary with approved chrome inset", () => {
  render(<Panel title={<h2>도면</h2>} tools={<button>이동</button>} status={<span>실제 0</span>}><canvas /></Panel>);
  const heading = screen.getByRole("heading", { name: "도면" });
  const tools = screen.getByRole("button", { name: "이동" });
  const status = screen.getByText("실제 0");
  expect(heading.parentElement).toBe(tools.parentElement);
  expect(heading.parentElement).not.toBe(status.parentElement);
  expect(heading.parentElement!.compareDocumentPosition(status) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(heading.closest("[data-operation-map-chrome]")).toHaveClass("px-4", "py-3", "max-compact:px-3");
});
it("keeps status and always-visible tools in chrome above the same map child", () => {
  const clicked = vi.fn();
  const content = <><canvas data-testid="map-canvas" /><button onClick={clicked}>pin</button></>;
  const view = render(<Panel status="도면 0" tools={<button>영역 선택</button>}>{content}</Panel>);
  const canvas = screen.getByTestId("map-canvas");
  expect(screen.getByRole("button", { name: "영역 선택" })).toBeInTheDocument();
  expect(screen.getByText("도면 0")).toBeInTheDocument();
  view.rerender(<Panel status="도면 1" tools={<button>이동</button>}>{content}</Panel>);
  expect(screen.getByTestId("map-canvas")).toBe(canvas);
});
it("renders a numeric zero supplied as the status chrome", () => {
  render(<Panel status={0}><canvas /></Panel>);
  expect(screen.getByText("0")).toBeInTheDocument();
});
