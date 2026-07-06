import type { MouseEvent, PointerEvent } from "react";
import { useRef, useState } from "react";
import { clampPoint, createDefaultObject, moveByDelta, screenToWorld } from "./geometry";
import { useFloorEditorStore } from "./editor-store";
import type { EditorFixture, FloorMapObject } from "./editor-types";

const statusLabels = {
  online: "정상",
  offline: "오프라인",
  fault: "장애"
} as const;

export function FloorEditorCanvas() {
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [draggingFixtureId, setDraggingFixtureId] = useState<string | null>(null);
  const [lastPanPoint, setLastPanPoint] = useState<{ x: number; y: number } | null>(null);
  const [lastDragPoint, setLastDragPoint] = useState<{ x: number; y: number } | null>(null);
  const { state, activeTool, zoom, pan, setPan, selectFixture, selectObject, addObject, updateFixture } = useFloorEditorStore();

  if (!state) return null;
  const editorState = state;

  const floorPlan = editorState.floor.floorPlan;
  const backgroundImageUrl =
    floorPlan && floorPlan.sourceType !== "none" ? floorPlan.renderedImageUrl ?? floorPlan.imageUrl : "";
  const bounds = { width: floorPlan?.width ?? 1200, height: floorPlan?.height ?? 800 };

  function getWorldPoint(event: PointerEvent<HTMLElement> | MouseEvent<HTMLElement>) {
    const rect = stageRef.current?.getBoundingClientRect();
    const screenPoint = rect
      ? { x: event.clientX - rect.left, y: event.clientY - rect.top }
      : { x: event.clientX, y: event.clientY };
    return clampPoint(screenToWorld(screenPoint, pan, zoom), bounds);
  }

  function handleCanvasClick(event: PointerEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>) {
    if (activeTool === "select" || activeTool === "pan") return;
    if (event.target !== event.currentTarget) return;
    addObject(editorState.floor.id, createDefaultObject(activeTool, getWorldPoint(event)));
  }

  function handlePointerMove(event: PointerEvent<HTMLDivElement>) {
    movePanOrFixture(event);
  }

  function handleMouseMove(event: MouseEvent<HTMLDivElement>) {
    movePanOrFixture(event);
  }

  function movePanOrFixture(event: PointerEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>) {
    if (lastPanPoint && activeTool === "pan") {
      setPan({ x: pan.x + event.clientX - lastPanPoint.x, y: pan.y + event.clientY - lastPanPoint.y });
      setLastPanPoint({ x: event.clientX, y: event.clientY });
      return;
    }
    if (!draggingFixtureId || !lastDragPoint) return;
    const nextPoint = getWorldPoint(event);
    const delta = { dx: nextPoint.x - lastDragPoint.x, dy: nextPoint.y - lastDragPoint.y };
    const fixture = editorState.fixtures.find((item) => item.id === draggingFixtureId);
    if (!fixture) return;
    const moved = moveByDelta({ x: fixture.x, y: fixture.y }, delta, bounds);
    updateFixture(draggingFixtureId, moved);
    setLastDragPoint(nextPoint);
  }

  function startPan(event: PointerEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>) {
    if (activeTool === "pan") {
      setLastPanPoint({ x: event.clientX, y: event.clientY });
    }
  }

  function stopDragging() {
    setDraggingFixtureId(null);
    setLastDragPoint(null);
    setLastPanPoint(null);
  }

  return (
    <div
      ref={stageRef}
      className={`floor-editor-canvas ${backgroundImageUrl ? "has-plan" : "grid-only"}`}
      style={{ aspectRatio: `${bounds.width} / ${bounds.height}` }}
      aria-label={`${editorState.floor.name} 편집 캔버스`}
      onClick={handleCanvasClick}
      onPointerDown={startPan}
      onPointerMove={handlePointerMove}
      onMouseDown={startPan}
      onMouseMove={handleMouseMove}
      onPointerUp={stopDragging}
      onMouseUp={stopDragging}
      onPointerLeave={stopDragging}
      onMouseLeave={stopDragging}
    >
      <div
        className="floor-editor-world"
        style={{
          width: bounds.width,
          height: bounds.height,
          transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`
        }}
      >
        {backgroundImageUrl ? (
          <img className="floor-editor-plan" src={backgroundImageUrl} alt={`${editorState.floor.name} 편집 도면`} draggable={false} />
        ) : null}
        {editorState.objects.filter((object) => object.visible).map((object) => (
          <EditorObject key={object.id} object={object} onSelect={() => selectObject(object.id)} />
        ))}
        {editorState.fixtures.map((fixture) => (
          <button
            key={fixture.id}
            className={`editor-fixture-dot ${fixture.status}`}
            style={{ left: fixture.x, top: fixture.y }}
            aria-label={`${fixture.name} ${statusLabels[fixture.status]} ${fixture.brightness}%`}
            onClick={() => selectFixture(fixture.id)}
            onPointerDown={(event) => {
              event.stopPropagation();
              selectFixture(fixture.id);
              setDraggingFixtureId(fixture.id);
              setLastDragPoint(getWorldPoint(event));
            }}
          >
            <span>{fixture.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function EditorObject({ object, onSelect }: { object: FloorMapObject; onSelect: () => void }) {
  const style = {
    left: object.x,
    top: object.y,
    width: object.width,
    height: object.height,
    borderColor: object.strokeColor,
    background: object.fillColor ?? "transparent",
    borderWidth: object.strokeWidth,
    transform: `rotate(${object.rotation}deg)`,
    zIndex: object.zIndex
  };

  if (object.type === "line") {
    return (
      <button className="editor-object editor-line-object" style={style} onClick={onSelect}>
        <span>{object.type}</span>
      </button>
    );
  }

  if (object.type === "triangle") {
    const points = object.points ?? [
      { x: object.width / 2, y: 0 },
      { x: object.width, y: object.height },
      { x: 0, y: object.height }
    ];
    const polygon = points.map((point) => `${point.x}px ${point.y}px`).join(", ");

    return (
      <button className="editor-object triangle" style={{ ...style, clipPath: `polygon(${polygon})` }} onClick={onSelect}>
        <span>{object.type}</span>
      </button>
    );
  }

  return (
    <button className={`editor-object ${object.type}`} style={style} onClick={onSelect}>
      {object.type === "text" ? <span style={{ fontSize: object.fontSize ?? 16 }}>{object.text}</span> : <span>{object.type}</span>}
    </button>
  );
}
