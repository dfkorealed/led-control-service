import Konva from "konva";
import { useMemo, type CSSProperties } from "react";
import { Group, Line, Rect, Stage, Text, Layer } from "react-konva";
import type { FloorMapSnapshot } from "@led-control/shared";
import { Button, cn, themeColor } from "../../components/ui";

const fixtureStatusLabels = {
  online: "정상",
  offline: "오프라인",
  fault: "장애"
} as const;

const fixtureBrightnessClasses = {
  1: "bg-fixture-brightness-1 shadow-fixture-brightness-1",
  2: "bg-fixture-brightness-2 shadow-fixture-brightness-2",
  3: "bg-fixture-brightness-3 shadow-fixture-brightness-3",
  4: "bg-fixture-brightness-4 shadow-fixture-brightness-4",
  5: "bg-fixture-brightness-5 shadow-fixture-brightness-5",
  6: "bg-fixture-brightness-6 shadow-fixture-brightness-6",
  7: "bg-fixture-brightness-7 shadow-fixture-brightness-7",
  8: "bg-fixture-brightness-8 shadow-fixture-brightness-8",
  9: "bg-fixture-brightness-9 shadow-fixture-brightness-9",
  10: "bg-fixture-brightness-10 shadow-fixture-brightness-10"
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
  statusPresentation?: { label: string; state: string };
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

export type FixtureSceneSelection =
  | { kind: "none" }
  | { kind: "single"; selectedFixtureIds: ReadonlySet<string> }
  | {
      kind: "multiple";
      selectedFixtureIds: ReadonlySet<string>;
      disabledFixtureIds: ReadonlySet<string>;
      disabledReasons?: ReadonlyMap<string, string>;
    };

export interface FloorSceneProps {
  snapshot: FloorMapSnapshot;
  fixtures: SceneFixture[];
  interactive: boolean;
  floorName?: string;
  selection?: FixtureSceneSelection;
  coarsePointer?: boolean;
  onFixturePress?: (fixtureId: string) => void;
}

interface FixtureMarkerStyle extends CSSProperties {
  "--fixture-left": string;
  "--fixture-top": string;
}

const noFixtureSceneSelection: FixtureSceneSelection = { kind: "none" };

export function FloorScene({
  snapshot,
  fixtures,
  interactive,
  floorName,
  selection = noFixtureSceneSelection,
  coarsePointer = false,
  onFixturePress
}: FloorSceneProps) {
  const backgroundUrl = snapshot.floorPlan?.renderedImageUrl ?? snapshot.floorPlan?.imageUrl;
  const objects = snapshot.objects.filter((object) => object.visible);
  const renderedFixtures = useMemo<SceneFixture[]>(() => {
    if (snapshot.fixtures === undefined) {
      return fixtures.filter((fixture) => fixture.placementStatus !== "unplaced");
    }
    const runtimeById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
    const snapshotFixtureIds = new Set(snapshot.fixtures.map((fixture) => fixture.id));
    const snapshotFixtures = snapshot.fixtures.flatMap((layout) => {
      const runtime: SceneFixture = runtimeById.get(layout.id) ?? {
        id: layout.id,
        name: layout.name,
        x: layout.x,
        y: layout.y,
        brightness: 0,
        status: "offline" as const,
        placementStatus: "placed" as const
      };
      if (runtime.placementStatus === "unplaced") return [];
      return [{ ...runtime, x: layout.x, y: layout.y }];
    });
    const runtimeOnlyFixtures = fixtures.filter((fixture) =>
      !snapshotFixtureIds.has(fixture.id) && fixture.placementStatus !== "unplaced"
    );
    return [...snapshotFixtures, ...runtimeOnlyFixtures];
  }, [fixtures, snapshot.fixtures]);

  return (
    <div className="relative h-full w-full" data-floor-scene="" data-map-objects-interactive={interactive ? "true" : "false"}>
      {backgroundUrl ? <img className="pointer-events-none absolute inset-0 z-0 h-full w-full object-contain" src={backgroundUrl} alt={`${floorName ?? "층"} 도면`} draggable={false} /> : null}
      {/* Konva owns generated child canvas dimensions; the stable hook is the documented library geometry exception. */}
      <div className="floor-scene-canvas pointer-events-none absolute inset-0 z-1 h-full w-full overflow-hidden" aria-hidden="true">
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
      {renderedFixtures.map((fixture) => {
        // FloorMap injects the monitoring presenter result. Editor callers omit it and retain
        // their compact legacy status label without owning monitoring cause precedence.
        const awaitingState = fixture.statusPresentation?.state === "provisioning_waiting_state" || fixture.statusReason === "provisioning_waiting_state";
        const statusLabel = fixture.statusPresentation?.label ?? (awaitingState ? "상태 확인 대기" : fixtureStatusLabels[fixture.status]);
        const brightnessLevel = fixtureBrightnessLevel(fixture.brightness);
        // Marker position is stored in map coordinates and must scale with the live snapshot.
        const markerStyle = {
          "--fixture-left": `${(fixture.x / snapshot.width) * 100}%`,
          "--fixture-top": `${(fixture.y / snapshot.height) * 100}%`,
          // The center must leave room for the entire 48px coarse hit target, including at saved map edges.
          left: coarsePointer ? "clamp(1.5rem, var(--fixture-left), calc(100% - 1.5rem))" : "clamp(1rem, var(--fixture-left), calc(100% - 1rem))",
          top: coarsePointer ? "clamp(1.5rem, var(--fixture-top), calc(100% - 1.5rem))" : "clamp(1rem, var(--fixture-top), calc(100% - 1rem))"
        } satisfies FixtureMarkerStyle;
        const markerStateClass = awaitingState
          ? "border-2! border-dotted! border-fixture-inspection-border! bg-fixture-inspection-background shadow-none"
          : fixture.status === "offline"
            ? "border-2! border-dashed! border-fixture-offline-border! bg-fixture-offline-background shadow-none"
            : fixtureBrightnessClasses[brightnessLevel];
        const badgeClass = awaitingState
          ? "bg-fixture-inspection"
          : fixture.status === "offline"
            ? "bg-fixture-offline"
            : fixture.status === "fault" ? "bg-fixture-fault" : "bg-fixture-connected";
        const selected = selection.kind !== "none" && selection.selectedFixtureIds.has(fixture.id);
        const disabled = selection.kind === "multiple" && selection.disabledFixtureIds.has(fixture.id);
        const disabledReason = selection.kind === "multiple" ? selection.disabledReasons?.get(fixture.id) : undefined;
        const accessibleState = selection.kind === "multiple"
          ? [
              selected ? "선택됨" : null,
              disabled ? `선택 불가${disabledReason ? `: ${disabledReason}` : ""}` : null
            ].filter((value): value is string => value !== null).join(" ")
          : "";

        return (
          <Button
            key={fixture.id}
            type="button"
            variant="ghost"
            size="sm"
            data-spatial-map-marker="true"
            data-brightness-level={brightnessLevel}
            className={cn(
              "absolute z-2 block! -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-fixture-marker! border-0! bg-transparent! p-0! transition-[background-color,box-shadow] duration-150 motion-reduce:duration-[0.01ms] hover:z-4 focus-visible:z-4 focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-fixture-selected",
              // Leave a pixel-rounding buffer beyond the 44px coarse-pointer minimum so every edge remains reachable in browser layout.
              coarsePointer ? "size-12! min-h-12!" : "size-5! min-h-5!",
              selected && "z-3"
            )}
            style={markerStyle}
            title={`${fixture.name} ${statusLabel} ${fixture.brightness}%`}
            aria-label={`${fixture.name} ${statusLabel} ${fixture.brightness}%${accessibleState ? ` ${accessibleState}` : ""}`}
            aria-current={selection.kind === "single" && selected ? "true" : undefined}
            aria-pressed={selection.kind === "multiple" ? selected : undefined}
            disabled={disabled}
            data-selected={selected ? "true" : "false"}
            data-disabled={disabled ? "true" : "false"}
            data-disabled-reason={disabledReason}
            onClick={() => onFixturePress?.(fixture.id)}
          >
            {/* The marker dot stays 20px; only its transparent button target expands for coarse pointers. */}
            <span data-spatial-map-marker-dot="true" className={cn("pointer-events-none absolute left-1/2 top-1/2 block size-5 -translate-x-1/2 -translate-y-1/2 rounded-fixture-marker! border! border-fixture-offline! transition-[background-color,box-shadow] duration-150 motion-reduce:duration-[0.01ms]", markerStateClass, selected && "outline-3 outline-offset-4 outline-fixture-selected")}>
              <span aria-hidden="true" className={cn("pointer-events-none absolute -top-1.5 -right-1.5 size-2 rounded-pill border-2 border-surface-panel shadow-panel", badgeClass)} />
            </span>
          </Button>
        );
      })}
    </div>
  );
}

function fixtureBrightnessLevel(brightness: number): keyof typeof fixtureBrightnessClasses {
  const finiteBrightness = Number.isFinite(brightness) ? brightness : 0;
  const clampedBrightness = Math.min(100, Math.max(0, finiteBrightness));
  return Math.min(10, Math.floor(clampedBrightness / 10) + 1) as keyof typeof fixtureBrightnessClasses;
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
  const selectedStroke = selected ? themeColor("fixture-editor-selected") || object.strokeColor : object.strokeColor;
  // Konva needs a transparent fill to keep the complete object interior hit-testable in the editor.
  const hitTestableFill = object.fillColor ?? "transparent";

  if (object.type === "line") {
    return <Line {...common} points={[0, 0, object.width, 0]} stroke={object.strokeColor} strokeWidth={Math.max(object.strokeWidth, 6)} hitStrokeWidth={18} lineCap="round" />;
  }

  if (object.type === "triangle") {
    const points = (object.points ?? trianglePoints(object.width, object.height)).flatMap((point) => [point.x, point.y]);
    return <Line {...common} points={points} closed fill={hitTestableFill} stroke={selectedStroke} strokeWidth={object.strokeWidth} />;
  }

  if (object.type === "text") {
    return (
      <Group {...common}>
        <Rect width={object.width} height={object.height} fill={hitTestableFill} stroke={selectedStroke} strokeWidth={object.strokeWidth} />
        <Text x={8} y={8} width={Math.max(object.width - 16, 1)} height={Math.max(object.height - 16, 1)} text={object.text || "텍스트"} fontSize={object.fontSize ?? 16} fill={object.strokeColor} />
      </Group>
    );
  }

  return <Rect {...common} width={object.width} height={object.height} fill={hitTestableFill} stroke={selectedStroke} strokeWidth={object.strokeWidth} />;
}

export function trianglePoints(width: number, height: number) {
  return [
    { x: width / 2, y: 0 },
    { x: width, y: height },
    { x: 0, y: height }
  ];
}
