import Konva from "konva";
import { act, render } from "@testing-library/react";
import { Layer, Stage } from "react-konva";
import { describe, expect, it, vi } from "vitest";
import { CadElementOverlay } from "./CadElementOverlay";
import type { CadEditableElement } from "./cad-editor-runtime";

const element: CadEditableElement = {
  elementId: "cad-element-00000000000000000000000000000001",
  groupId: "group-1",
  layerName: "WALL",
  locator: { tileX: 0, tileY: 0, lod: 1, part: 0 },
  bounds: { minX: 100, minY: 200, maxX: 180, maxY: 240 },
  points: [{ x: 100, y: 200 }, { x: 180, y: 240 }],
  fragments: [{ points: [{ x: 100, y: 200 }, { x: 180, y: 240 }], closed: false }],
  closed: false,
  text: null,
  fontSize: null,
  textGeometry: null,
  strokeColor: "#111111",
  fillColor: null,
  strokeWidth: 2,
  zOrder: 1,
  override: {
    elementId: "cad-element-00000000000000000000000000000001",
    hidden: false,
    transform: { translateX: 10, translateY: 5, scaleX: 2, scaleY: 1.5, rotation: 15 },
    strokeColor: "#ff0000",
    fillColor: null,
    strokeWidth: 3,
    text: null
  }
};

describe("CadElementOverlay", () => {
  it("promotes one CAD element and commits its normalized transform", () => {
    const onCommit = vi.fn();
    render(
      <Stage width={800} height={600}>
        <Layer>
          <CadElementOverlay element={element} readOnly={false} zoom={2} onCommit={onCommit} />
        </Layer>
      </Stage>
    );
    const stage = (window as unknown as { Konva: { stages: Konva.Stage[] } }).Konva.stages.at(-1)!;
    const node = stage.findOne<Konva.Group>(".cad-element-overlay")!;

    expect(stage.find(".cad-element-overlay")).toHaveLength(1);
    expect(node.position()).toEqual({ x: 10, y: 5 });
    expect(node.scale()).toEqual({ x: 2, y: 1.5 });
    expect(node.rotation()).toBe(15);

    act(() => {
      node.position({ x: 130, y: 260 });
      node.scale({ x: 1.25, y: 0.75 });
      node.rotation(30);
      node.fire("transformend");
    });

    expect(onCommit).toHaveBeenCalledWith({
      transform: { translateX: 130, translateY: 260, scaleX: 1.25, scaleY: 0.75, rotation: 30 }
    });
  });

  it("does not make a hidden or read-only element interactive", () => {
    const onCommit = vi.fn();
    render(
      <Stage width={800} height={600}>
        <Layer>
          <CadElementOverlay
            element={{ ...element, override: { ...element.override!, hidden: true } }}
            readOnly
            zoom={1}
            onCommit={onCommit}
          />
        </Layer>
      </Stage>
    );
    const stage = (window as unknown as { Konva: { stages: Konva.Stage[] } }).Konva.stages.at(-1)!;
    expect(stage.find(".cad-element-overlay")).toHaveLength(0);
  });

  it("renders every tile fragment without connecting them", () => {
    render(
      <Stage width={800} height={600}>
        <Layer>
          <CadElementOverlay
            element={{
              ...element,
              fragments: [
                { points: [{ x: 100, y: 200 }, { x: 180, y: 240 }], closed: false },
                { points: [{ x: 512, y: 240 }, { x: 560, y: 240 }], closed: false }
              ]
            }}
            readOnly={false}
            zoom={1}
            onCommit={vi.fn()}
          />
        </Layer>
      </Stage>
    );
    const stage = (window as unknown as { Konva: { stages: Konva.Stage[] } }).Konva.stages.at(-1)!;
    expect(stage.find(".cad-element-fragment")).toHaveLength(2);
  });

  it("keeps CAD text on its baseline origin and original rotation", () => {
    render(
      <Stage width={800} height={600}>
        <Layer>
          <CadElementOverlay
            element={{
              ...element,
              text: "B2",
              fontSize: 16,
              fragments: [],
              textGeometry: {
                position: { x: 120, y: 210 },
                width: 80,
                height: 20,
                rotation: 30,
                bounds: { minX: 100, minY: 150, maxX: 180, maxY: 220 }
              }
            }}
            readOnly={false}
            zoom={1}
            onCommit={vi.fn()}
          />
        </Layer>
      </Stage>
    );
    const stage = (window as unknown as { Konva: { stages: Konva.Stage[] } }).Konva.stages.at(-1)!;
    const text = stage.findOne<Konva.Text>(".cad-element-text")!;
    expect(text.position()).toEqual({ x: 120, y: 210 });
    expect(text.offsetY()).toBe(20);
    expect(text.rotation()).toBe(30);
  });
});
