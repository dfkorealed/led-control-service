import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorToolPalette } from "./EditorToolPalette";

afterEach(cleanup);

const tools = [
  ["선택", "select"], ["이동", "pan"], ["사각형", "rectangle"], ["삼각형", "triangle"],
  ["선", "line"], ["텍스트", "text"], ["타원", "ellipse"], ["호", "arc"],
  ["연속선", "polyline"], ["다각형", "polygon"]
] as const;

function transfer() {
  const data = new Map<string, string>();
  return { effectAllowed: "none", setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) };
}

describe("EditorToolPalette", () => {
  it("exposes all general tools as controlled accessible icon buttons", () => {
    const onToolChange = vi.fn();
    const { rerender } = render(<EditorToolPalette activeTool="select" onToolChange={onToolChange} />);
    expect(screen.getAllByRole("button")).toHaveLength(10);
    for (const [label, type] of tools) {
      const button = screen.getByRole("button", { name: label });
      expect(button).toHaveAttribute("aria-pressed", String(type === "select"));
      expect(button.querySelector("svg")).not.toBeNull();
      fireEvent.click(button);
      expect(onToolChange).toHaveBeenLastCalledWith(type);
    }
    rerender(<EditorToolPalette activeTool="polygon" onToolChange={onToolChange} />);
    expect(screen.getByRole("button", { name: "다각형" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByText(/CAD/)).not.toBeInTheDocument();
  });

  it.each(tools.slice(2))("exports %s with the existing drag MIME and raw shape name", (label, type) => {
    const onToolChange = vi.fn();
    render(<EditorToolPalette activeTool="select" onToolChange={onToolChange} />);
    const dataTransfer = transfer();
    const button = screen.getByRole("button", { name: label });
    expect(button).toHaveAttribute("draggable", "true");
    fireEvent.dragStart(button, { dataTransfer });
    expect(dataTransfer.getData("application/x-floor-editor-tool")).toBe(type);
    expect(dataTransfer.effectAllowed).toBe("copy");
    expect(onToolChange).toHaveBeenCalledWith(type);
  });

  it("does not drag navigation tools, and read-only still permits navigation", () => {
    const onToolChange = vi.fn();
    render(<EditorToolPalette activeTool="pan" onToolChange={onToolChange} readOnly />);
    for (const [label, type] of tools) {
      const button = screen.getByRole("button", { name: label });
      const dataTransfer = transfer();
      expect(button).toHaveAttribute("draggable", "false");
      fireEvent.dragStart(button, { dataTransfer });
      expect(dataTransfer.getData("application/x-floor-editor-tool")).toBeUndefined();
      if (type !== "select" && type !== "pan") {
        expect(button).toBeDisabled();
        fireEvent.click(button);
      } else expect(button).toBeEnabled();
    }
    expect(onToolChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "선택" }));
    expect(onToolChange).toHaveBeenCalledWith("select");
  });

  it("disables all actions when busy and uses the shared hover/focus tooltip", () => {
    const onToolChange = vi.fn();
    const { rerender } = render(<EditorToolPalette activeTool="select" onToolChange={onToolChange} disabled />);
    for (const button of screen.getAllByRole("button")) expect(button).toBeDisabled();
    rerender(<EditorToolPalette activeTool="select" onToolChange={onToolChange} />);
    fireEvent.focus(screen.getByRole("button", { name: "타원" }));
    expect(screen.getByRole("tooltip")).toHaveTextContent("타원");
  });

  it("uses shared color fields and sends controlled style patches", () => {
    const onStyleChange = vi.fn();
    const style = { strokeColor: "#123456", fillColor: null, strokeWidth: 2, opacity: 1 };
    const { rerender } = render(<EditorToolPalette activeTool="rectangle" onToolChange={vi.fn()}
      style={style} onStyleChange={onStyleChange} />);
    const stroke = screen.getByLabelText("선 색상");
    expect(stroke).toHaveAttribute("type", "color");
    fireEvent.change(stroke, { target: { value: "#abcdef" } });
    expect(onStyleChange).toHaveBeenLastCalledWith({ strokeColor: "#abcdef" });
    fireEvent.change(screen.getByLabelText("채우기 색상"), { target: { value: "#fedcba" } });
    expect(onStyleChange).toHaveBeenLastCalledWith({ fillColor: "#fedcba" });
    expect(style.fillColor).toBeNull();
    rerender(<EditorToolPalette activeTool="rectangle" onToolChange={vi.fn()}
      style={style} onStyleChange={onStyleChange} readOnly />);
    expect(screen.getByLabelText("선 색상")).toBeDisabled();
    expect(screen.getByLabelText("채우기 색상")).toBeDisabled();
  });

  it("allows clearing stroke/fill and does not rewrite alpha colors just by rendering", () => {
    const onStyleChange = vi.fn();
    const style = { strokeColor: "#12345680", fillColor: "#abcdef", strokeWidth: 2, opacity: 1 };
    const { rerender } = render(<EditorToolPalette activeTool="polygon" onToolChange={vi.fn()}
      style={style} onStyleChange={onStyleChange} />);
    expect(screen.getByLabelText("선 색상")).toHaveValue("#123456");
    expect(onStyleChange).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "선 없음" }));
    expect(onStyleChange).toHaveBeenLastCalledWith({ strokeColor: null });
    fireEvent.click(screen.getByRole("button", { name: "채우기 없음" }));
    expect(onStyleChange).toHaveBeenLastCalledWith({ fillColor: null });
    rerender(<EditorToolPalette activeTool="polygon" onToolChange={vi.fn()}
      style={style} onStyleChange={onStyleChange} disabled />);
    expect(screen.getByRole("button", { name: "채우기 없음" })).toBeDisabled();
  });
});
