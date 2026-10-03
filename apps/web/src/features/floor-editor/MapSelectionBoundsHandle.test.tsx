import Konva from "konva";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { Layer, Stage } from "react-konva";
import { afterEach, expect, it, vi } from "vitest";
import { transformMapPoint } from "@led-control/shared/map-document-geometry";
import { MapSelectionBoundsHandle } from "./MapSelectionBoundsHandle";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
function setup(bounds = { minX: 103, minY: 107, maxX: 183, maxY: 147 }) {
  const onTransform = vi.fn(), onMove = vi.fn(), onError = vi.fn(), onPick = vi.fn();
  const props = { selectionKey: "all-query-members", bounds, mapBounds: { width: 1204, height: 800 }, zoom: 1, gridSize: 10, locked: false, onTransform, onMove, onError, onPick };
  const view = render(<Stage width={900} height={600}><Layer><MapSelectionBoundsHandle {...props} /></Layer></Stage>);
  const stage = Konva.stages.at(-1)!;
  return { ...view, props, stage, onPick, onTransform, onMove, onError, node: stage.findOne<Konva.Rect>(".map-selection-bounds")!, transformer: stage.findOne<Konva.Transformer>(".map-selection-transformer")! };
}
function installTouchHit(stage: Konva.Stage, node: Konva.Rect) {
  Object.defineProperty(stage.content, "clientWidth", { configurable: true, value: 900 });
  Object.defineProperty(stage.content, "clientHeight", { configurable: true, value: 600 });
  vi.spyOn(stage.content, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, left: 0, top: 0, right: 900, bottom: 600, width: 900, height: 600, toJSON: () => ({}) });
  // JSDOM has no raster hit buffer; only hit lookup is substituted, not Stage's tap dispatch.
  vi.spyOn(stage, "getIntersection").mockReturnValue(node);
}
it("picks a member through the bounds overlay on a real Stage touch tap", () => {
  const { stage, node, onPick, onMove } = setup();
  installTouchHit(stage, node);
  const touch = { identifier: 1, clientX: 140, clientY: 125 };
  fireEvent.touchStart(stage.content, { touches: [touch], changedTouches: [touch] });
  fireEvent.touchEnd(stage.content, { touches: [], changedTouches: [touch] });
  expect(onPick).toHaveBeenCalledTimes(1);
  expect(onPick).toHaveBeenCalledWith({ x: 140, y: 125 }, false, false);
  expect(onMove).not.toHaveBeenCalled();
});
it("moves the selection once on Stage touch drag without treating release as a tap", () => {
  const { stage, node, onPick, onMove } = setup();
  installTouchHit(stage, node);
  const start = { identifier: 2, clientX: 140, clientY: 125 };
  const end = { identifier: 2, clientX: 180, clientY: 145 };
  fireEvent.touchStart(stage.content, { touches: [start], changedTouches: [start] });
  fireEvent.touchMove(stage.content, { touches: [end], changedTouches: [end] });
  fireEvent.touchEnd(stage.content, { touches: [], changedTouches: [end] });
  expect(onMove).toHaveBeenCalledTimes(1);
  expect(onMove).toHaveBeenCalledWith({ x: 40, y: 20 });
  expect(onPick).not.toHaveBeenCalled();
});
it("snaps the whole proportional resize at release, preserving its world-space anchor", () => {
  const { node, transformer, onTransform, onError, props } = setup();
  vi.spyOn(transformer, "getActiveAnchor").mockReturnValue("bottom-right");
  act(() => { node.fire("transformstart"); node.scale({ x: 1.17, y: 1.17 }); });
  expect(onTransform).not.toHaveBeenCalled();
  act(() => node.fire("transformend"));
  expect(onError).not.toHaveBeenCalled();
  const delta = onTransform.mock.calls[0][0];
  const fixed = transformMapPoint({ x: props.bounds.minX, y: props.bounds.minY }, delta);
  const edge = transformMapPoint({ x: props.bounds.maxX, y: props.bounds.maxY }, delta);
  expect(fixed.x).toBeCloseTo(103); expect(fixed.y).toBeCloseTo(107);
  expect(edge.x).toBeCloseTo(200); expect(delta.scaleX).toBeCloseTo(delta.scaleY);
});
it("does not use a synthetic hit width to move the fixed endpoint of a vertical selection", () => {
  const { node, transformer, onTransform, onError } = setup({ minX: 103, minY: 107, maxX: 103, maxY: 147 });
  vi.spyOn(transformer, "getActiveAnchor").mockReturnValue("top-left");
  act(() => { node.fire("transformstart"); node.position({ x: 101, y: 87 }); node.scale({ x: 1.5, y: 1.5 }); node.fire("transformend"); });
  expect(onError).not.toHaveBeenCalled();
  const delta = onTransform.mock.calls[0][0];
  const fixed = transformMapPoint({ x: 103, y: 147 }, delta);
  expect(fixed.x).toBeCloseTo(103); expect(fixed.y).toBeCloseTo(147);
  expect(delta.scaleX).toBe(1);
});
it("delegates the unsnapped move once and cancels an active transform on lock", () => {
  const { node, transformer, onMove, onTransform, props, rerender } = setup();
  act(() => { node.fire("dragstart"); node.position({ x: 984, y: 107 }); node.fire("dragend"); });
  expect(onMove).toHaveBeenCalledTimes(1);
  expect(onMove).toHaveBeenCalledWith({ x: 881, y: 0 });
  vi.spyOn(transformer, "getActiveAnchor").mockReturnValue("bottom-right");
  act(() => { node.fire("transformstart"); node.scale({ x: 1.5, y: 1.5 }); });
  rerender(<Stage width={900} height={600}><Layer><MapSelectionBoundsHandle {...props} locked /></Layer></Stage>);
  act(() => node.fire("transformend"));
  expect(onTransform).not.toHaveBeenCalled();
});
