import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { OperationMapPanel as Panel } from "../index";

afterEach(cleanup);
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
