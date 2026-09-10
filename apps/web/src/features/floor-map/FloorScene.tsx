import Konva from "konva";
import type { CSSProperties } from "react";
import { Group, Line, Rect, Stage, Text, Layer } from "react-konva";
import type { FloorMapSnapshot } from "@led-control/shared";

const fixtureStatusLabels = {
  online: "정상",
  offline: "오프라인",
  fault: "장애"
} as const;

export interface SceneFixture {
  id: string;
  name: string;
  x: number;
  y: number;
  brightness: number;
  status: "online" | "offline" | "fault";
  statusReason?: string | null;
  placementStatus?: "unplaced" | "placed";
}

export interface SceneMapObject {
  id: string;
  type: "rectangle" | "triangle" | "line" | "text";
  x: number;
  y: number;
  width: number;
  height: number;
  points?: Array<{ x: number; y: number }> | null;
  rotation: number;
  strokeColor: string;
  fillColor?: string | null;
  strokeWidth: number;
  text?: string | null;
  fontSize?: number | null;
  zIndex: number;
  locked: boolean;
  visible: boolean;
}

interface FloorSceneProps {
  snapshot: FloorMapSnapshot;
  fixtures: SceneFixture[];
  interactive: boolean;
  floorName?: string;
  selectedFixtureId?: string | null;
  onSelectFixture?: (fixtureId: string) => void;
}

export function FloorScene({
  snapshot,
  fixtures,
  interactive,
  floorName,
  selectedFixtureId,
  onSelectFixture
}: FloorSceneProps) {
  const backgroundUrl = snapshot.floorPlan?.renderedImageUrl ?? snapshot.floorPlan?.imageUrl;
  const objects = snapshot.objects.filter((object) => object.visible);

  return (
    <div className="floor-scene" data-interactive={interactive ? "true" : "false"}>
      {backgroundUrl ? <img className="floor-map-image" src={backgroundUrl} alt={`${floorName ?? "층"} 도면`} /> : null}
      <div className="floor-scene-canvas" aria-hidden="true">
        <Stage width={snapshot.width} height={snapshot.height} listening={interactive}>
          <Layer listening={interactive}>
            {objects.map((object) => (
              <FloorMapObjectNode key={object.id} object={object} interactive={interactive} />
            ))}
          </Layer>
        </Stage>
      </div>
      <div className="sr-only" aria-hidden="true">
        {objects.map((object) => (
          <span key={object.id} data-testid={`map-object-${object.id}`}>{object.type}</span>
        ))}
      </div>
      {fixtures.filter((fixture) => fixture.placementStatus !== "unplaced").map((fixture) => {
        const awaitingState = fixture.statusReason === "provisioning_waiting_state";
        const statusLabel = awaitingState ? "상태 확인 대기" : fixtureStatusLabels[fixture.status];
        const markerStyle = {
          "--fixture-left": `${(fixture.x / snapshot.width) * 100}%`,
          "--fixture-top": `${(fixture.y / snapshot.height) * 100}%`,
          "--brightness": `${fixture.brightness}%`
        } as CSSProperties;

        return (
          <button
            key={fixture.id}
            type="button"
            data-spatial-map-marker="true"
            className={`fixture-dot ${fixture.status}${awaitingState ? " awaiting-state" : ""}${fixture.id === selectedFixtureId ? " active" : ""}`}
            style={markerStyle}
            title={`${fixture.name} ${statusLabel} ${fixture.brightness}%`}
            aria-label={`${fixture.name} ${statusLabel} ${fixture.brightness}%`}
            aria-current={fixture.id === selectedFixtureId ? "true" : undefined}
            onClick={() => onSelectFixture?.(fixture.id)}
          >
            <span className="fixture-name">{fixture.name}</span>
            <strong>{fixture.brightness}%</strong>
            <span className="fixture-bar" />
          </button>
        );
      })}
    </div>
  );
}

export function FloorMapObjectNode({
  object,
  interactive,
  selected = false,
  preview = false,
  setNodeRef,
  onSelect,
  onDragStart,
  onDragMove,
  onChange,
  onTransformEnd
}: {
  object: SceneMapObject;
  interactive: boolean;
  selected?: boolean;
  preview?: boolean;
  setNodeRef?: (node: Konva.Node | null) => void;
  onSelect?: () => void;
  onDragStart?: () => void;
  onDragMove?: (node: Konva.Node) => void;
  onChange?: (patch: { x?: number; y?: number }) => void;
  onTransformEnd?: (node: Konva.Node) => void;
}) {
  const interactiveProps = interactive && !preview && !object.locked
    ? {
        draggable: true,
        onClick: onSelect,
        onTap: onSelect,
        onDragStart: () => {
          onSelect?.();
          onDragStart?.();
        },
        onDragMove: (event: Konva.KonvaEventObject<globalThis.DragEvent>) => onDragMove?.(event.target),
        onDragEnd: (event: Konva.KonvaEventObject<globalThis.DragEvent>) => onChange?.({
          x: event.target.x(),
          y: event.target.y()
        }),
        onTransformEnd: (event: Konva.KonvaEventObject<Event>) => onTransformEnd?.(event.target)
      }
    : { draggable: false, listening: false };
  const common = {
    ...interactiveProps,
    ref: setNodeRef,
    name: `map-object-${object.id}`,
    x: object.x,
    y: object.y,
    rotation: object.rotation,
    opacity: preview ? 0.6 : 1
  };

  if (object.type === "line") {
    return <Line {...common} points={[0, 0, object.width, 0]} stroke={object.strokeColor} strokeWidth={Math.max(object.strokeWidth, 6)} hitStrokeWidth={18} lineCap="round" />;
  }

  if (object.type === "triangle") {
    const points = (object.points ?? trianglePoints(object.width, object.height)).flatMap((point) => [point.x, point.y]);
    return <Line {...common} points={points} closed fill={object.fillColor ?? "transparent"} stroke={selected ? "#2563eb" : object.strokeColor} strokeWidth={object.strokeWidth} />;
  }

  if (object.type === "text") {
    return (
      <Group {...common}>
        <Rect width={object.width} height={object.height} fill={object.fillColor ?? "transparent"} stroke={selected ? "#2563eb" : object.strokeColor} strokeWidth={object.strokeWidth} />
        <Text x={8} y={8} width={Math.max(object.width - 16, 1)} height={Math.max(object.height - 16, 1)} text={object.text || "텍스트"} fontSize={object.fontSize ?? 16} fill={object.strokeColor} />
      </Group>
    );
  }

  return <Rect {...common} width={object.width} height={object.height} fill={object.fillColor ?? "transparent"} stroke={selected ? "#2563eb" : object.strokeColor} strokeWidth={object.strokeWidth} />;
}

export function trianglePoints(width: number, height: number) {
  return [
    { x: width / 2, y: 0 },
    { x: width, y: height },
    { x: 0, y: height }
  ];
}
