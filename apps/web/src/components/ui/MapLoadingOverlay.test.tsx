import { act, cleanup, render, renderHook, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { MapLoadingOverlay, useMapPaintLoading } from "./MapLoadingOverlay";

afterEach(cleanup);

it("announces loading without taking layout space and removes the spinner when inactive", () => {
  const view = render(<MapLoadingOverlay loading />);
  expect(screen.getByRole("status")).toHaveTextContent("맵을 불러오는 중입니다.");
  expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
  expect(screen.getByRole("status")).toHaveClass("absolute", "inset-0");
  expect(screen.getByRole("status").querySelector("svg")).toHaveClass("text-content-secondary");
  view.rerender(<MapLoadingOverlay loading={false} />);
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});

it("waits for first viewport paint but never blocks subsequent camera paints", () => {
  const { result } = renderHook(() => useMapPaintLoading("floor:gen-a"));
  expect(result.current.loading).toBe(true);
  act(() => result.current.onPaintReady(false));
  expect(result.current.loading).toBe(true);
  act(() => result.current.onPaintReady(true));
  expect(result.current.loading).toBe(false);
  act(() => result.current.onPaintReady(false));
  expect(result.current.loading).toBe(false);
});

it("fences replaced document callbacks and stops on failure", () => {
  const { result, rerender } = renderHook(({ identity }) => useMapPaintLoading(identity),
    { initialProps: { identity: "floor:gen-a" } });
  const old = result.current;
  act(() => old.onPaintReady(true));
  rerender({ identity: "floor:gen-b" });
  act(() => { old.onPaintReady(true); old.onError(); });
  expect(result.current.loading).toBe(true);
  act(() => result.current.onError());
  expect(result.current.loading).toBe(false);
  rerender({ identity: "floor-2:gen-b" });
  expect(result.current.loading).toBe(true);
});
