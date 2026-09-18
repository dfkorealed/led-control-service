import { render } from "@testing-library/react";
import type Konva from "konva";
import { createRef } from "react";
import { Stage } from "react-konva";
import { describe, expect, it } from "vitest";
import {
  CAD_SLOT_HIT_RADIUS,
  CadPlacementSlotLayer,
  findAvailableCadSlotAtPoint
} from "./CadPlacementSlotLayer";

const slots = [
  { id: "slot-free", x: 123.5, y: 247.25, rotation: 37, assignedFixtureId: null },
  { id: "slot-used", x: 140, y: 250, rotation: 90, assignedFixtureId: "fixture-1" }
];

describe("CadPlacementSlotLayer", () => {
  it("renders only unassigned slots as hollow markers with their CAD rotation", () => {
    const stageRef = createRef<Konva.Stage>();

    render(<Stage ref={stageRef} width={640} height={480}>
      <CadPlacementSlotLayer
        slots={slots}
        transform={{ x: 0, y: 0, scaleX: 1, scaleY: 1 }}
        zoom={1}
      />
    </Stage>);

    const markers = stageRef.current?.find(".cad-placement-slot") ?? [];
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ attrs: expect.objectContaining({ x: 123.5, y: 247.25, rotation: 37 }) });
    expect((markers[0] as Konva.Group).findOne<Konva.Circle>(".cad-placement-slot-marker")?.fill()).toBeUndefined();
  });

  it("highlights only the available slot under the drag pointer", () => {
    const stageRef = createRef<Konva.Stage>();

    render(<Stage ref={stageRef} width={640} height={480}>
      <CadPlacementSlotLayer
        slots={slots}
        transform={{ x: 0, y: 0, scaleX: 1, scaleY: 1 }}
        zoom={2}
        highlightedSlotId="slot-free"
      />
    </Stage>);

    const marker = stageRef.current?.findOne<Konva.Circle>(".cad-placement-slot-marker");
    expect(marker?.getAttr("data-highlighted")).toBe(true);
    expect(marker?.radius()).toBe(8);
  });

  it("finds the nearest free slot inside the hit radius and ignores assigned slots", () => {
    expect(findAvailableCadSlotAtPoint(slots, { x: 125, y: 248 }, CAD_SLOT_HIT_RADIUS)?.id).toBe("slot-free");
    expect(findAvailableCadSlotAtPoint(slots, { x: 140, y: 250 }, 2)).toBeNull();
    expect(findAvailableCadSlotAtPoint(slots, { x: 500, y: 500 }, CAD_SLOT_HIT_RADIUS)).toBeNull();
  });
});
