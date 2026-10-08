import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as controls from "./MapCameraControls";
afterEach(cleanup);

function callbacks() {
  return { onZoomIn: vi.fn(), onZoomOut: vi.fn(), onResetZoom: vi.fn(), onFit: vi.fn(), onFitSelection: vi.fn() };
}

describe("MapCameraControls", () => {
  it("reset zoom is distinct from fit", () => {
    expect(controls.MapCameraControls).toBeTypeOf("function");
    const actions = callbacks();
    render(<controls.MapCameraControls zoomPercent={25} {...actions} fitLabel="맵 맞춤" />);
    fireEvent.click(screen.getByRole("button", { name: "100%" }));
    expect(actions.onResetZoom).toHaveBeenCalledOnce();
    expect(actions.onFit).not.toHaveBeenCalled();
    expect(actions.onFitSelection).not.toHaveBeenCalled();
    expect(actions.onZoomIn).not.toHaveBeenCalled();
    expect(actions.onZoomOut).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "맵 맞춤" }));
    fireEvent.click(screen.getByRole("button", { name: "선택 맞춤" }));
    fireEvent.click(screen.getByRole("button", { name: "확대" }));
    fireEvent.click(screen.getByRole("button", { name: "축소" }));
    for (const action of Object.values(actions)) expect(action).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "100%" })).toHaveTextContent("25%");
  });

  it("honors busy and zoom boundary locks without emitting actions", () => {
    expect(controls.MapCameraControls).toBeTypeOf("function");
    const actions = callbacks();
    const view = render(<controls.MapCameraControls zoomPercent={400} {...actions} canZoomIn={false} />);
    expect(screen.getByRole("button", { name: "확대" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "확대" }));
    expect(actions.onZoomIn).not.toHaveBeenCalled();
    view.rerender(<controls.MapCameraControls zoomPercent={0.1} {...actions} canZoomOut={false} />);
    expect(screen.getByRole("button", { name: "축소" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "축소" }));
    expect(actions.onZoomOut).not.toHaveBeenCalled();
    view.rerender(<controls.MapCameraControls zoomPercent={100} {...actions} isDisabled />);
    for (const button of screen.getAllByRole("button")) {
      expect(button).toBeDisabled(); fireEvent.click(button);
    }
    for (const action of Object.values(actions)) expect(action).not.toHaveBeenCalled();
  });

  it("omits unsupported selection fit and preserves the connected focus target on updates", () => {
    expect(controls.MapCameraControls).toBeTypeOf("function");
    const { onZoomIn, onZoomOut, onResetZoom, onFit } = callbacks();
    const actions = { onZoomIn, onZoomOut, onResetZoom, onFit };
    const view = render(<controls.MapCameraControls zoomPercent={100} {...actions} />);
    expect(screen.queryByRole("button", { name: "선택 맞춤" })).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: "확대" });
    button.focus();
    view.rerender(<controls.MapCameraControls zoomPercent={110} {...actions} />);
    expect(document.activeElement).toBe(button);
    fireEvent.click(button, { detail: 0 });
    expect(actions.onZoomIn).toHaveBeenCalledOnce();
  });
});
