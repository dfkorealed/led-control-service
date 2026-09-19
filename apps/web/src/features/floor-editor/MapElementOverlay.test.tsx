import Konva from "konva";
import { act, cleanup, render } from "@testing-library/react";
import { Layer, Stage } from "react-konva";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMapElementBounds, transformMapPoint, type MapElement, type MapOp } from "@led-control/shared";
import { getMapElementOverlaySelection, MapElementOverlay, MapElementOverlayLimitError, MapElementOverlayTextError,
  MAX_MAP_ELEMENT_OVERLAY_ELEMENTS, MAX_MAP_ELEMENT_OVERLAY_POINTS } from "./MapElementOverlay";
import { createMapElementFromDrag } from "./map-element-tools";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const types: MapElement["type"][] = ["line", "rectangle", "triangle", "ellipse", "arc", "polyline", "polygon", "text"];
const make = (type: MapElement["type"], id: string = type) => createMapElementFromDrag(
  type, { x: 103, y: 107 }, { x: 183, y: 147 }, id
)!;
function setup(selection: MapElement[], options = {}) {
  const onChange = vi.fn<(ops: MapOp[]) => void>();
  const onError = vi.fn();
  const onGuidesChange = vi.fn();
  const props = { selection, onChange, onError, onGuidesChange, zoom: 1,
    mapBounds: { width: 2000, height: 2000 }, ...options };
  const view = render(<Stage width={800} height={600}><Layer><MapElementOverlay {...props} /></Layer></Stage>);
  const stage = Konva.stages.at(-1)!;
  return { ...view, props, stage, node: stage.findOne<Konva.Group>(".map-element-overlay")!, onChange, onError, onGuidesChange };
}
function lastElements(onChange: ReturnType<typeof setup>["onChange"]) {
  return onChange.mock.calls.at(-1)![0].map(op => {
    if (op.kind !== "update") throw new Error("Expected update");
    return op.element;
  });
}

describe("MapElementOverlay", () => {
  it.each(types)("renders selected %s from canonical geometry only", type => {
    const element = { ...make(type), transform: { x: 200, y: 100, scaleX: 1.2, scaleY: 0.7, rotation: 31 } };
    const { stage } = setup([element]);
    expect(stage.find(".map-element-shape")).toHaveLength(1);
    const shape = stage.findOne<Konva.Shape>(".map-element-shape")!;
    const actual = shape.getAbsoluteTransform().point({ x: 0, y: 0 });
    const expected = transformMapPoint(shape.position(), element.transform);
    expect(actual.x).toBeCloseTo(expected.x, 8);
    expect(actual.y).toBeCloseTo(expected.y, 8);
    const transformer = stage.findOne<Konva.Transformer>(".map-element-transformer")!;
    expect(transformer.enabledAnchors()).toHaveLength(8);
    expect(transformer.flipEnabled()).toBe(false);
    expect(transformer.rotateEnabled()).toBe(true);
  });

  it("keeps the canonical top-left text baseline with no CAD offset or second rotation", () => {
    const element = make("text");
    const { stage } = setup([element]);
    const text = stage.findOne<Konva.Shape>(".map-element-shape")!;
    expect(text.position()).toEqual({ x: 103, y: 107 });
    expect(text.offsetY()).toBe(0);
    expect(text.rotation()).toBe(0);
    expect(text.width()).toBe(80);
    expect(text.height()).toBe(40);
  });

  it.each([
    ["ABC", 80, 40, 20], ["ABCDEFGHIJKLMN", 80, 40, 20], ["W", 1, 40, 20], ["ABC", 80, 40, 200]
  ] as const)("draws the complete run %s in the canonical %sx%s quad at font size %s", (text, width, height, fontSize) => {
    // The global canvas mock measures every string as zero. Give both the old Konva
    // layout and the custom scene context realistic widths so clipping cannot hide.
    const textPrototype = Konva.Text.prototype as Konva.Text & { _getTextWidth(value: string): number };
    vi.spyOn(textPrototype, "_getTextWidth").mockImplementation(function (this: Konva.Text, value) {
      return value.length * this.fontSize() * 0.7;
    });
    vi.spyOn(Konva.Context.prototype, "measureText").mockImplementation(value => ({ width: value.length * 14 }) as TextMetrics);
    const draw = vi.spyOn(Konva.Context.prototype, "fillText");
    const clip = vi.spyOn(Konva.Context.prototype, "clip");
    const element: MapElement = { ...make("text"), type: "text", geometry: { position: { x: 40, y: 40 }, text, width, height, fontSize } };
    const { stage, onError } = setup([element]);
    draw.mockClear(); clip.mockClear();
    act(() => stage.draw());
    expect(draw.mock.calls.map(call => call[0])).toEqual([text]);
    expect(clip).toHaveBeenCalled();
    expect(getMapElementOverlaySelection([element]).map(item => item.id)).toEqual(["text"]);
    expect(onError).not.toHaveBeenCalled();
    expect(stage.findOne<Konva.Shape>(".map-element-shape")!.getClientRect()).toEqual({ x: 40, y: 40, width, height });
  });

  it.each([{ width: 0, height: 40 }, { width: 80, height: 0 }])("refuses nonempty zero-area text before promotion: %s", size => {
    const element = make("text");
    if (element.type !== "text") throw new Error("Expected text");
    element.geometry = { ...element.geometry, ...size, text: "ABC" };
    expect(() => getMapElementOverlaySelection([make("rectangle"), element])).toThrow(MapElementOverlayTextError);
    const { stage, onError, onChange } = setup([make("rectangle"), element]);
    expect(stage.find(".map-element-shape")).toHaveLength(0);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toMatchObject({ code: "MAP_ELEMENT_OVERLAY_TEXT_UNSUPPORTED", elementId: "text" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("renders polygon holes using evenodd and arcs without a closing chord", () => {
    const polygon = make("polygon");
    if (polygon.type !== "polygon") throw new Error("Expected polygon");
    polygon.geometry.holes = [[{ x: 120, y: 115 }, { x: 140, y: 115 }, { x: 140, y: 130 }, { x: 120, y: 130 }]];
    const { stage } = setup([polygon, make("arc")]);
    const shapes = stage.find<Konva.Path>(".map-element-shape");
    expect(shapes[0].fillRule()).toBe("evenodd");
    expect(shapes[0].data().match(/Z/g)).toHaveLength(2);
    expect(shapes[1].data()).not.toContain("Z");
    expect(shapes[1].fillEnabled()).toBe(false);
  });

  it("preserves drag offset, does not snap or commit in motion, and snaps once at release", () => {
    const { node, onChange, onGuidesChange } = setup([make("rectangle")], { gridSize: 10 });
    act(() => {
      node.fire("dragstart");
      node.position({ x: 14, y: 9 });
      node.fire("dragmove");
    });
    expect(node.position()).toEqual({ x: 14, y: 9 });
    expect(onChange).not.toHaveBeenCalled();
    act(() => node.fire("dragend"));
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(getMapElementBounds(lastElements(onChange)[0])).toEqual({ minX: 120, minY: 120, maxX: 200, maxY: 160 });
    expect(node.position()).toEqual({ x: 0, y: 0 });
    expect(onGuidesChange).toHaveBeenLastCalledWith([]);
  });

  it("aligns a preview with the shared guide helper, preserving the original click offset", () => {
    const { node, onChange, onGuidesChange } = setup([make("rectangle")], {
      guideTargets: [{ x: 200, y: 300, width: 80, height: 40 }], guideThreshold: 4
    });
    act(() => { node.fire("dragstart"); node.position({ x: 94, y: 11 }); node.fire("dragmove"); });
    expect(node.position()).toEqual({ x: 97, y: 11 });
    expect(onChange).not.toHaveBeenCalled();
    expect(onGuidesChange).toHaveBeenLastCalledWith([{ orientation: "vertical", position: 200 }]);
  });

  it.each(types)("resizes and rotates a previously rotated %s with positive scales once", type => {
    const element = { ...make(type), transform: { x: 400, y: 300, scaleX: 1.2, scaleY: 0.7, rotation: -37 } };
    const { node, onChange } = setup([element]);
    act(() => {
      node.fire("transformstart");
      node.position({ x: 420, y: 310 }); node.scale({ x: 2.4, y: 2.1 }); node.rotation(-15);
      node.fire("transformend");
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    const next = lastElements(onChange)[0];
    expect(next.transform).toEqual({ x: 420, y: 310, scaleX: 2.4, scaleY: 2.1, rotation: -15 });
    expect(next.geometry).toEqual(element.geometry);
    expect(node.scale()).toEqual({ x: 1.2, y: 0.7 });
  });

  it("applies a mixed group gesture once to every original, never by accumulating previews", () => {
    const a = make("rectangle"), b = make("text");
    const { node, onChange } = setup([a, b, a]);
    act(() => {
      node.fire("transformstart");
      node.scale({ x: 1.1, y: 1.1 }); node.fire("transform");
      node.scale({ x: 1.5, y: 1.5 }); node.rotation(20); node.position({ x: 200, y: 100 });
      node.fire("transformend");
    });
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(lastElements(onChange)).toHaveLength(2);
    for (const element of lastElements(onChange)) expect(element.transform).toMatchObject({ x: 200, y: 100, scaleX: 1.5, scaleY: 1.5 });
  });

  it.each([0, -1, NaN, Infinity])("reverts invalid scale %s and reports an error without commands", scale => {
    const { node, onChange, onError } = setup([make("rectangle")]);
    act(() => { node.fire("transformstart"); node.scaleX(scale); node.fire("transformend"); });
    expect(onChange).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(node.scale()).toEqual({ x: 1, y: 1 });
  });

  it("reverts a whole out-of-bounds group and leaves no dirty node transform", () => {
    const { node, onChange, onError } = setup([make("line"), make("ellipse")]);
    act(() => { node.fire("dragstart"); node.x(5000); node.fire("dragend"); });
    expect(onChange).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(node.position()).toEqual({ x: 0, y: 0 });
  });

  it.each([{ readOnly: true }, { locked: true }, { elementLocked: true }])("does not allow synthetic mutations while %s", option => {
    const { node, stage, onChange } = setup([{ ...make("line"), locked: !!option.elementLocked }], option);
    expect(node.draggable()).toBe(false);
    expect(stage.find(".map-element-transformer")).toHaveLength(0);
    act(() => { node.fire("dragstart"); node.x(10); node.fire("dragend"); });
    expect(onChange).not.toHaveBeenCalled();
    expect(node.x()).toBe(0);
  });

  it("does not promote hidden elements or an unbounded number of selected nodes", () => {
    const hidden = setup([{ ...make("line"), visible: false }]);
    expect(hidden.stage.find(".map-element-shape")).toHaveLength(0);
    hidden.unmount();
    const large = setup(Array.from({ length: MAX_MAP_ELEMENT_OVERLAY_ELEMENTS + 1 }, (_, i) => make("line", String(i))));
    expect(large.stage.find(".map-element-shape")).toHaveLength(0);
    expect(large.onError).toHaveBeenCalledTimes(1);
    expect(large.onError.mock.calls[0][0]).toBeInstanceOf(MapElementOverlayLimitError);
    expect(large.onError.mock.calls[0][0]).toMatchObject({ code: "MAP_ELEMENT_OVERLAY_LIMIT", reason: "elements" });
  });

  it("exposes the exact promotion set for host masks and fails atomically at the point budget", () => {
    const line = make("line");
    expect(getMapElementOverlaySelection([line, line, { ...make("text"), visible: false }])).toEqual([line]);
    const polyline = make("polyline");
    if (polyline.type !== "polyline") throw new Error("Expected polyline");
    const points = Array.from({ length: Math.floor(MAX_MAP_ELEMENT_OVERLAY_POINTS / 3) + 1 }, (_, i) => ({ x: i, y: 1 }));
    expect(() => getMapElementOverlaySelection([0, 1, 2].map(i => ({ ...polyline, id: String(i), geometry: { points } }))))
      .toThrow(MapElementOverlayLimitError);
  });

  it("cancels stale gestures when canonical selection changes during a drag", () => {
    const { node, props, rerender, onChange } = setup([make("rectangle")]);
    act(() => { node.fire("dragstart"); node.x(10); });
    rerender(<Stage width={800} height={600}><Layer><MapElementOverlay {...props} selection={[make("ellipse")]} /></Layer></Stage>);
    act(() => node.fire("dragend"));
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not cancel a drag when its parent recreates an equivalent selection array", () => {
    const element = make("rectangle");
    const { node, props, rerender, onChange } = setup([element]);
    act(() => { node.fire("dragstart"); node.x(10); });
    rerender(<Stage width={800} height={600}><Layer><MapElementOverlay {...props} selection={[element]} /></Layer></Stage>);
    expect(node.x()).toBe(10);
    act(() => node.fire("dragend"));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("rejects shear in rotated mixed groups instead of distorting the saved geometry", () => {
    const a = { ...make("rectangle"), transform: { x: 300, y: 100, scaleX: 1, scaleY: 1, rotation: 30 } };
    const { node, onChange, onError } = setup([a, make("text")]);
    act(() => { node.fire("transformstart"); node.scaleX(2); node.fire("transformend"); });
    expect(onChange).not.toHaveBeenCalled();
    expect(onError.mock.calls[0][0].message).toMatch(/기울임/);
    expect(node.scaleX()).toBe(1);
  });

  it("moves hidden group children too without promoting or masking their geometry", () => {
    const visible = make("rectangle"), hidden = { ...make("line"), visible: false };
    const { node, stage, onChange } = setup([visible, hidden]);
    expect(stage.find(".map-element-shape")).toHaveLength(1);
    act(() => { node.fire("dragstart"); node.x(20); node.fire("dragend"); });
    expect(lastElements(onChange).map(element => element.id)).toEqual(["rectangle", "line"]);
    expect(lastElements(onChange)[1]).toMatchObject({ visible: false, transform: { x: 20 } });
  });

  it.each(["horizontal", "vertical"])("gives a %s line a nondegenerate interaction frame without altering geometry", direction => {
    const element = createMapElementFromDrag("line", { x: 100, y: 100 },
      direction === "horizontal" ? { x: 180, y: 100 } : { x: 100, y: 180 }, direction)!;
    const { node, onChange } = setup([element]);
    const frame = node.getClientRect({ skipTransform: true, skipStroke: true });
    expect(frame.width).toBeGreaterThan(0);
    expect(frame.height).toBeGreaterThan(0);
    act(() => { node.fire("transformstart"); node.scale({ x: 2, y: 2 }); node.rotation(15); node.fire("transformend"); });
    expect(lastElements(onChange)[0].geometry).toEqual(element.geometry);
  });
});
