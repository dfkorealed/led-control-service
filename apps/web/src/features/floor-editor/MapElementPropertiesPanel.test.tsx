import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { type MapElement, type MapOp } from "@led-control/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MapElementPropertiesPanel } from "./MapElementPropertiesPanel";
import { createMapElementFromDrag } from "./map-element-tools";

afterEach(cleanup);

const make = (type: MapElement["type"], id = type): MapElement => createMapElementFromDrag(
  type, { x: 100, y: 100 }, { x: 180, y: 140 }, id
)!;
function setup(selection: MapElement[], options = {}) {
  const onChange = vi.fn<(ops: MapOp[]) => void>();
  const onDelete = vi.fn();
  const onError = vi.fn();
  const props = { selection, onChange, onDelete, onError, mapBounds: { width: 1000, height: 1000 }, ...options };
  return { ...render(<MapElementPropertiesPanel {...props} />), ...props };
}
function number(label: string, value: string) {
  const input = screen.getByRole("textbox", { name: label });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.blur(input);
}
function lastElement(onChange: ReturnType<typeof setup>["onChange"]): MapElement {
  const op = onChange.mock.calls.at(-1)?.[0][0];
  if (op?.kind !== "update") throw new Error("Expected update");
  return op.element;
}

describe("MapElementPropertiesPanel", () => {
  it.each([null, { importJobId: "job", sourceId: "source" }])("uses the same generic panel for provenance %s", provenance => {
    const { onChange, onDelete } = setup([{ ...make("rectangle"), provenance }]);
    expect(screen.getByRole("complementary", { name: "도형 속성" })).toBeInTheDocument();
    expect(screen.queryByText(/CAD/)).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("선 색상"), { target: { value: "#123456" } });
    expect(lastElement(onChange).style.strokeColor).toBe("#123456");
    expect(lastElement(onChange).provenance).toEqual(provenance);
    fireEvent.click(screen.getByRole("button", { name: "도형 삭제" }));
    expect(onDelete).toHaveBeenCalledWith(["rectangle"]);
  });

  it.each(["line", "rectangle", "triangle", "ellipse", "arc", "polyline", "polygon", "text"] as const)("shows kind-appropriate %s fields", type => {
    setup([make(type)]);
    expect(screen.getByLabelText("X 위치")).toBeInTheDocument();
    expect(screen.getByLabelText("너비")).toBeInTheDocument();
    expect(screen.getByLabelText("회전")).toBeInTheDocument();
    expect(Boolean(screen.queryByLabelText("채우기 색상"))).toBe(["rectangle", "triangle", "ellipse", "polygon"].includes(type));
    expect(Boolean(screen.queryByLabelText("텍스트"))).toBe(type === "text");
    expect(Boolean(screen.queryByLabelText("시작 X"))).toBe(type === "line");
    expect(Boolean(screen.queryByLabelText("시작 각도"))).toBe(type === "arc");
    expect(Boolean(screen.queryByLabelText("가로 반지름"))).toBe(type === "ellipse");
  });

  it("uses blank mixed values and emits a single deduplicated batch with unrelated properties intact", () => {
    const a = { ...make("rectangle"), groupId: "upstream-group" };
    const b = { ...make("line"), style: { ...make("line").style, strokeWidth: 5 } };
    const { onChange } = setup([a, b, a]);
    expect(screen.getByLabelText("선 두께")).toHaveValue("");
    expect(screen.queryByLabelText("시작 X")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("채우기 색상")).not.toBeInTheDocument();
    number("선 두께", "7");
    expect(onChange).toHaveBeenCalledTimes(1);
    const ops = onChange.mock.calls[0][0];
    expect(ops).toHaveLength(2);
    expect(ops[0]).toEqual({ kind: "update", element: { ...a, style: { ...a.style, strokeWidth: 7 } } });
    expect(ops[1]).toEqual({ kind: "update", element: { ...b, style: { ...b.style, strokeWidth: 7 } } });
  });

  it("edits position, size, local line endpoints, ellipse radius and arc angles", () => {
    const { onChange, rerender, ...props } = setup([make("line")]);
    number("X 위치", "150");
    expect(lastElement(onChange).transform.x).toBe(50);
    number("너비", "160");
    expect(lastElement(onChange).transform.scaleX).toBe(2);
    number("시작 X", "90");
    expect(lastElement(onChange).geometry).toMatchObject({ start: { x: 90, y: 100 } });
    rerender(<MapElementPropertiesPanel {...props} onChange={onChange} selection={[make("ellipse")]} />);
    number("가로 반지름", "50");
    expect(lastElement(onChange).geometry).toMatchObject({ radiusX: 50 });
    rerender(<MapElementPropertiesPanel {...props} onChange={onChange} selection={[make("arc")]} />);
    number("시작 각도", "270");
    expect(lastElement(onChange).geometry).toMatchObject({ startAngle: 270 });
  });

  it.each([{ readOnly: true }, { locked: true }, { elementLocked: true }])("prevents every mutation for %s", option => {
    const { onChange, onDelete } = setup([{ ...make("rectangle"), locked: !!option.elementLocked }], option);
    expect(screen.getByLabelText("X 위치")).toBeDisabled();
    expect(screen.getByLabelText("선 색상")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "도형 삭제" }));
    expect(onChange).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("does not partially edit or delete a mixed locked selection", () => {
    const { onDelete } = setup([make("line"), { ...make("rectangle"), locked: true }]);
    expect(screen.getByLabelText("선 두께")).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "도형 삭제" }));
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("preserves null/alpha colors until an explicit edit and supports clearing fill", () => {
    const element = make("polygon");
    const { onChange } = setup([{ ...element, style: { ...element.style, strokeColor: "#12345678", fillColor: null } }]);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByLabelText("선 색상")).toHaveValue("#123456");
    expect(screen.getByRole("button", { name: "채우기 없음" })).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "선 없음" }));
    expect(lastElement(onChange).style.strokeColor).toBeNull();
  });

  it("reports invalid geometry without enqueuing any operations", () => {
    const { onChange, onError } = setup([make("rectangle")]);
    number("X 위치", "999");
    expect(onChange).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert")).toHaveTextContent(/범위/);
  });

  it("keeps Backspace/Delete in text inputs away from parent deletion handlers", () => {
    const parentDelete = vi.fn();
    const onChange = vi.fn();
    const onDelete = vi.fn();
    render(<div onKeyDown={parentDelete}><MapElementPropertiesPanel selection={[make("text")]}
      onChange={onChange} onDelete={onDelete} /></div>);
    const input = screen.getByLabelText("텍스트");
    fireEvent.focus(input);
    expect(fireEvent.keyDown(input, { key: "Backspace" })).toBe(true);
    fireEvent.change(input, { target: { value: "텍스" } });
    expect(fireEvent.keyDown(input, { key: "Delete" })).toBe(true);
    expect(parentDelete).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith([expect.objectContaining({ kind: "update", element: expect.objectContaining({
      geometry: expect.objectContaining({ text: "텍스" })
    }) })]);
  });

  it("renders no shape actions for an empty selection; the host owns map settings", () => {
    setup([]);
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "도형 삭제" })).not.toBeInTheDocument();
  });
});
