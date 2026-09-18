import type { FloorLightSlotDto } from "@led-control/shared";
import { useMemo } from "react";
import { Circle, Group, Layer, Line } from "react-konva";
import { themeColor } from "../../components/ui";

export const CAD_SLOT_HIT_RADIUS = 18;

interface CadPlacementSlotLayerProps {
  slots: FloorLightSlotDto[];
  transform: { x: number; y: number; scaleX: number; scaleY: number };
  zoom: number;
  highlightedSlotId?: string | null;
}

export function findAvailableCadSlotAtPoint(
  slots: FloorLightSlotDto[],
  point: { x: number; y: number },
  radius = CAD_SLOT_HIT_RADIUS
) {
  let nearest: FloorLightSlotDto | null = null;
  let nearestDistanceSquared = radius * radius;
  for (const slot of slots) {
    if (slot.assignedFixtureId !== null) continue;
    const distanceSquared = (slot.x - point.x) ** 2 + (slot.y - point.y) ** 2;
    if (distanceSquared <= nearestDistanceSquared) {
      nearest = slot;
      nearestDistanceSquared = distanceSquared;
    }
  }
  return nearest;
}

export function CadPlacementSlotLayer({ slots, transform, zoom, highlightedSlotId }: CadPlacementSlotLayerProps) {
  const availableSlots = useMemo(() => slots.filter((slot) => slot.assignedFixtureId === null), [slots]);
  const colors = useMemo(() => ({
    normal: themeColor("fixture-editor-border"),
    highlighted: themeColor("fixture-editor-selected")
  }), []);

  if (availableSlots.length === 0) return null;
  return <Layer {...transform} name="cad-placement-slot-layer" listening={false}>
    {availableSlots.map((slot) => {
      const highlighted = slot.id === highlightedSlotId;
      const radius = (highlighted ? 16 : 10) / zoom;
      const color = highlighted ? colors.highlighted : colors.normal;
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
          strokeWidth={(highlighted ? 3 : 2) / zoom}
          dash={highlighted ? undefined : [4 / zoom, 3 / zoom]}
          listening={false}
        />
        <Line
          points={[0, 0, 0, -radius]}
          stroke={color}
          strokeWidth={(highlighted ? 3 : 2) / zoom}
          lineCap="round"
          listening={false}
        />
      </Group>;
    })}
  </Layer>;
}
