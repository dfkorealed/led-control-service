import type { FloorLightSlotDto } from "@led-control/shared";
import { useMemo } from "react";
import { Circle, Group, Line } from "react-konva";
import { themeColor } from "../../components/ui";
import {
  buildEditorSpatialIndex,
  queryEditorSpatialIndex,
  type EditorSpatialBounds,
  type EditorSpatialIndex
} from "./editor-spatial-index";

export const CAD_SLOT_HIT_RADIUS = 18;

interface CadPlacementSlotLayerProps {
  slotIndex: AvailableCadSlotIndex;
  zoom: number;
  viewportBounds: EditorSpatialBounds;
  highlightedSlotId?: string | null;
}

export interface AvailableCadSlotIndex {
  slots: FloorLightSlotDto[];
  slotById: Map<string, FloorLightSlotDto>;
  spatialIndex: EditorSpatialIndex<FloorLightSlotDto>;
}

export function buildAvailableCadSlotIndex(slots: readonly FloorLightSlotDto[]): AvailableCadSlotIndex {
  const availableSlots = slots.filter((slot) => slot.assignedFixtureId === null);
  return {
    slots: availableSlots,
    slotById: new Map(availableSlots.map((slot) => [slot.id, slot])),
    spatialIndex: buildEditorSpatialIndex(availableSlots, 128)
  };
}

export function findAvailableCadSlotAtPoint(
  slotIndex: AvailableCadSlotIndex,
  point: { x: number; y: number },
  radius = CAD_SLOT_HIT_RADIUS
) {
  let nearest: FloorLightSlotDto | null = null;
  let nearestDistanceSquared = radius * radius;
  const candidates = queryEditorSpatialIndex(slotIndex.spatialIndex, {
    x: point.x - radius,
    y: point.y - radius,
    width: radius * 2,
    height: radius * 2
  }, 0);
  for (const slot of candidates) {
    const distanceSquared = (slot.x - point.x) ** 2 + (slot.y - point.y) ** 2;
    if (distanceSquared <= nearestDistanceSquared) {
      nearest = slot;
      nearestDistanceSquared = distanceSquared;
    }
  }
  return nearest;
}

export function CadPlacementSlotLayer({ slotIndex, zoom, viewportBounds, highlightedSlotId }: CadPlacementSlotLayerProps) {
  const visibleSlots = useMemo(() => {
    const visible = queryEditorSpatialIndex(slotIndex.spatialIndex, viewportBounds, 80 / zoom);
    if (!highlightedSlotId || visible.some((slot) => slot.id === highlightedSlotId)) return visible;
    const highlighted = slotIndex.slotById.get(highlightedSlotId);
    return highlighted ? [...visible, highlighted] : visible;
  }, [highlightedSlotId, slotIndex, viewportBounds, zoom]);
  const colors = useMemo(() => ({
    normal: themeColor("fixture-editor-border"),
    highlighted: themeColor("fixture-editor-selected")
  }), []);

  if (visibleSlots.length === 0) return null;
  return <Group name="cad-placement-slot-layer" listening={false}>
    {visibleSlots.map((slot) => {
      const highlighted = slot.id === highlightedSlotId;
      const radius = (highlighted ? 16 : 10) / zoom;
      const color = highlighted ? colors.highlighted : colors.normal;
      const detailed = zoom >= 0.5 || highlighted;
      return <Group
        key={slot.id}
        name="cad-placement-slot"
        x={slot.x}
        y={slot.y}
        rotation={slot.rotation}
        listening={false}
      >
        <Circle
          name="cad-placement-slot-marker"
          data-highlighted={highlighted}
          radius={radius}
          stroke={color}
          strokeWidth={(highlighted ? 3 : detailed ? 2 : 1) / zoom}
          dash={highlighted || !detailed ? undefined : [4 / zoom, 3 / zoom]}
          listening={false}
        />
        {detailed ? <Line
          points={[0, 0, 0, -radius]}
          stroke={color}
          strokeWidth={(highlighted ? 3 : 2) / zoom}
          lineCap="round"
          listening={false}
        /> : null}
      </Group>;
    })}
  </Group>;
}
