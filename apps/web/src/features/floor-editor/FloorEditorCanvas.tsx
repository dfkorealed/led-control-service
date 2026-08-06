import Konva from "konva";
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from "react";
import { useEffect, useRef, useState } from "react";
import { Circle, Group, Image as KonvaImage, Layer, Line, Rect, Stage, Text, Transformer } from "react-konva";
import { clampPoint, createDefaultObject, createObjectFromDrag, screenToWorld, type Point } from "./geometry";
import { useFloorEditorStore } from "./editor-store";
import type { EditorFixture, EditorTool, FloorMapObject, FloorMapObjectDraft } from "./editor-types";

const TOOL_DRAG_DATA_TYPE = "application/x-floor-editor-tool";
const drawingTools = new Set<EditorTool>(["rectangle", "triangle", "line", "text"]);
const fixtureColors: Record<EditorFixture["status"], string> = {
  online: "#20c997",
  offline: "#94a3b8",
  fault: "#ef4444"
};

export function FloorEditorCanvas({ readOnly = false }: { readOnly?: boolean }) {
  const stageRef = useRef<Konva.Stage | null>(null);
  const transformerRef = useRef<Konva.Transformer | null>(null);
  const objectRefs = useRef(new Map<string, Konva.Node>());
  const fixtureRefs = useRef(new Map<string, Konva.Node>());
  const [backgroundImage, setBackgroundImage] = useState<HTMLImageElement | null>(null);
  const [creationStart, setCreationStart] = useState<Point | null>(null);
  const [creationPreview, setCreationPreview] = useState<FloorMapObjectDraft | null>(null);
  const [hasCreationDragMoved, setHasCreationDragMoved] = useState(false);
  const [lastPanPoint, setLastPanPoint] = useState<Point | null>(null);
  const { state, activeTool, zoom, pan, selection, setPan, selectFixture, selectObject, addObject, updateFixture, updateObject } = useFloorEditorStore();

  const floorPlan = state?.floor.floorPlan;
  const backgroundImageUrl =
    floorPlan && floorPlan.sourceType !== "none" ? floorPlan.renderedImageUrl ?? floorPlan.imageUrl : "";
  const bounds = { width: floorPlan?.width ?? 1200, height: floorPlan?.height ?? 800 };
  const selectedObjectId = selection?.kind === "object" ? selection.id : null;
  const selectedFixtureId = selection?.kind === "fixture" ? selection.id : null;

  useEffect(() => {
    if (!backgroundImageUrl) {
      setBackgroundImage(null);
      return;
    }
    const image = new window.Image();
    image.src = backgroundImageUrl;
    image.onload = () => setBackgroundImage(image);
  }, [backgroundImageUrl]);

  useEffect(() => {
    const transformer = transformerRef.current;
    if (!transformer) return;
    const selectedNode = selectedObjectId
      ? objectRefs.current.get(selectedObjectId)
      : selectedFixtureId
        ? fixtureRefs.current.get(selectedFixtureId)
        : undefined;
    transformer.nodes(selectedNode ? [selectedNode] : []);
    transformer.getLayer()?.batchDraw();
  }, [selectedFixtureId, selectedObjectId, state]);

  if (!state) return null;
  const editorState = state;

  function getStageWorldPoint() {
    const pointer = stageRef.current?.getPointerPosition();
    return pointer ? clampPoint(screenToWorld(pointer, pan, zoom), bounds) : { x: 0, y: 0 };
  }

  function getDropWorldPoint(event: ReactDragEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const screenPoint = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    return clampPoint(screenToWorld(screenPoint, pan, zoom), bounds);
  }

  function getDomWorldPoint(event: ReactMouseEvent<HTMLDivElement>) {
    const rect = event.currentTarget.getBoundingClientRect();
    const screenPoint = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    return clampPoint(screenToWorld(screenPoint, pan, zoom), bounds);
  }

  function handleStageMouseDown(event: Konva.KonvaEventObject<MouseEvent>) {
    if (readOnly) return;
    if (activeTool !== "select" && activeTool !== "pan") {
      const start = getStageWorldPoint();
      setCreationStart(start);
      setCreationPreview(createObjectFromDrag(activeTool, start, start));
      setHasCreationDragMoved(false);
      return;
    }
    if (activeTool === "pan") {
      setLastPanPoint({ x: event.evt.clientX, y: event.evt.clientY });
    }
  }

  function handleStageMouseMove(event: Konva.KonvaEventObject<MouseEvent>) {
    if (readOnly) return;
    if (creationStart && activeTool !== "select" && activeTool !== "pan") {
      setCreationPreview(createObjectFromDrag(activeTool, creationStart, getStageWorldPoint()));
      setHasCreationDragMoved(true);
      return;
    }
    if (lastPanPoint && activeTool === "pan") {
      setPan({ x: pan.x + event.evt.clientX - lastPanPoint.x, y: pan.y + event.evt.clientY - lastPanPoint.y });
      setLastPanPoint({ x: event.evt.clientX, y: event.evt.clientY });
    }
  }

  function handleStageMouseUp() {
    if (readOnly) return;
    if (creationPreview && hasCreationDragMoved) addObject(editorState.floor.id, creationPreview);
    setCreationStart(null);
    setCreationPreview(null);
    setHasCreationDragMoved(false);
    setLastPanPoint(null);
  }

  function handleContainerMouseDown(event: ReactMouseEvent<HTMLDivElement>) {
    if (readOnly) return;
    if (activeTool !== "select" && activeTool !== "pan") {
      const start = getDomWorldPoint(event);
      setCreationStart(start);
      setCreationPreview(createObjectFromDrag(activeTool, start, start));
      setHasCreationDragMoved(false);
      return;
    }
    if (activeTool === "pan") {
      setLastPanPoint({ x: event.clientX, y: event.clientY });
    }
  }

  function handleContainerMouseMove(event: ReactMouseEvent<HTMLDivElement>) {
    if (readOnly) return;
    if (creationStart && activeTool !== "select" && activeTool !== "pan") {
      setCreationPreview(createObjectFromDrag(activeTool, creationStart, getDomWorldPoint(event)));
      setHasCreationDragMoved(true);
      return;
    }
    if (lastPanPoint && activeTool === "pan") {
      setPan({ x: pan.x + event.clientX - lastPanPoint.x, y: pan.y + event.clientY - lastPanPoint.y });
      setLastPanPoint({ x: event.clientX, y: event.clientY });
    }
  }

  function handleDragOver(event: ReactDragEvent<HTMLDivElement>) {
    if (readOnly) return;
    if (readDraggedTool(event.dataTransfer)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  }

  function handleDrop(event: ReactDragEvent<HTMLDivElement>) {
    if (readOnly) return;
    const tool = readDraggedTool(event.dataTransfer);
    if (!tool) return;
    event.preventDefault();
    addObject(editorState.floor.id, createDefaultObject(tool, getDropWorldPoint(event)));
  }

  function handleObjectTransformEnd(object: FloorMapObject, node: Konva.Node) {
    const scaleX = node.scaleX();
    const scaleY = node.scaleY();
    const width = Math.max(24, object.width * scaleX);
    const height = object.type === "line" ? 0 : Math.max(24, object.height * scaleY);
    node.scale({ x: 1, y: 1 });
    updateObject(object.id, {
      x: clampPoint({ x: node.x(), y: node.y() }, bounds).x,
      y: clampPoint({ x: node.x(), y: node.y() }, bounds).y,
      width,
      height,
      points: object.type === "triangle" ? trianglePoints(width, height) : object.points
    });
  }

  function handleFixtureTransformEnd(fixture: EditorFixture, node: Konva.Node) {
    const scale = Math.max(node.scaleX(), node.scaleY());
    node.scale({ x: 1, y: 1 });
    updateFixture(fixture.id, {
      x: node.x(),
      y: node.y(),
      size: Math.max(12, (fixture.size ?? 20) * scale)
    });
  }

  return (
    <div
      className={`floor-editor-canvas konva-editor-canvas ${backgroundImageUrl ? "has-plan" : "grid-only"}`}
      aria-label={`${editorState.floor.name} 편집 캔버스`}
      aria-disabled={readOnly}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
      onMouseDown={handleContainerMouseDown}
      onMouseMove={handleContainerMouseMove}
      onMouseUp={handleStageMouseUp}
      onMouseLeave={handleStageMouseUp}
    >
      <Stage
        ref={stageRef}
        width={bounds.width}
        height={bounds.height}
        className="floor-editor-konva-stage"
        listening={!readOnly}
        onMouseDown={handleStageMouseDown}
        onMouseMove={handleStageMouseMove}
        onMouseUp={handleStageMouseUp}
      >
        <Layer x={pan.x} y={pan.y} scaleX={zoom} scaleY={zoom}>
          <Rect width={bounds.width} height={bounds.height} fill={backgroundImage ? "transparent" : "#f8fbff"} listening />
          {backgroundImage ? (
            <KonvaImage image={backgroundImage} width={bounds.width} height={bounds.height} listening={false} />
          ) : null}
          {editorState.objects.filter((object) => object.visible).map((object) => (
            <MapObjectNode
              key={object.id}
              object={object}
              selected={object.id === selectedObjectId}
              setNodeRef={(node) => setNodeRef(objectRefs.current, object.id, node)}
              onSelect={() => selectObject(object.id)}
              onChange={(patch) => updateObject(object.id, patch)}
              onTransformEnd={(node) => handleObjectTransformEnd(object, node)}
            />
          ))}
          {creationPreview ? (
            <MapObjectNode
              object={{ ...creationPreview, id: "creation-preview", floorId: editorState.floor.id, zIndex: 999 }}
              preview
            />
          ) : null}
          {editorState.fixtures.map((fixture) => (
            <Group
              key={fixture.id}
              ref={(node) => setNodeRef(fixtureRefs.current, fixture.id, node)}
              x={fixture.x}
              y={fixture.y}
              draggable
              onClick={() => selectFixture(fixture.id)}
              onTap={() => selectFixture(fixture.id)}
              onDragStart={() => selectFixture(fixture.id)}
              onDragEnd={(event) => updateFixture(fixture.id, { x: event.target.x(), y: event.target.y() })}
              onTransformEnd={(event) => handleFixtureTransformEnd(fixture, event.target)}
            >
              <Circle
                radius={(fixture.size ?? 20) / 2}
                fill={fixtureColors[fixture.status]}
                stroke="#ffffff"
                strokeWidth={2}
                perfectDrawEnabled={false}
                shadowEnabled={false}
              />
              <Text x={14} y={-8} text={fixture.name} fontSize={12} fontStyle="bold" fill="#172033" />
            </Group>
          ))}
          <Transformer
            ref={transformerRef}
            rotateEnabled={false}
            enabledAnchors={["top-left", "top-center", "top-right", "middle-left", "middle-right", "bottom-left", "bottom-center", "bottom-right"]}
            boundBoxFunc={(_, newBox) => ({
              ...newBox,
              width: Math.max(12, newBox.width),
              height: Math.max(12, newBox.height)
            })}
          />
        </Layer>
      </Stage>
    </div>
  );
}

function readDraggedTool(dataTransfer: DataTransfer): EditorTool | null {
  const tool = dataTransfer.getData(TOOL_DRAG_DATA_TYPE) as EditorTool;
  return drawingTools.has(tool) ? tool : null;
}

function setNodeRef(map: Map<string, Konva.Node>, id: string, node: Konva.Node | null) {
  if (node) {
    map.set(id, node);
  } else {
    map.delete(id);
  }
}

function trianglePoints(width: number, height: number) {
  return [
    { x: width / 2, y: 0 },
    { x: width, y: height },
    { x: 0, y: height }
  ];
}

function MapObjectNode({
  object,
  selected = false,
  preview = false,
  setNodeRef,
  onSelect,
  onChange,
  onTransformEnd
}: {
  object: FloorMapObject;
  selected?: boolean;
  preview?: boolean;
  setNodeRef?: (node: Konva.Node | null) => void;
  onSelect?: () => void;
  onChange?: (patch: Partial<FloorMapObject>) => void;
  onTransformEnd?: (node: Konva.Node) => void;
}) {
  const common = {
    ref: setNodeRef,
    x: object.x,
    y: object.y,
    rotation: object.rotation,
    opacity: preview ? 0.6 : 1,
    draggable: !preview,
    onClick: onSelect,
    onTap: onSelect,
    onDragStart: onSelect,
    onDragEnd: (event: Konva.KonvaEventObject<globalThis.DragEvent>) => onChange?.({ x: event.target.x(), y: event.target.y() }),
    onTransformEnd: (event: Konva.KonvaEventObject<Event>) => onTransformEnd?.(event.target)
  };

  if (object.type === "line") {
    return (
      <Line
        {...common}
        points={[0, 0, object.width, 0]}
        stroke={object.strokeColor}
        strokeWidth={Math.max(object.strokeWidth, 6)}
        hitStrokeWidth={18}
        lineCap="round"
      />
    );
  }

  if (object.type === "triangle") {
    const points = (object.points ?? trianglePoints(object.width, object.height)).flatMap((point) => [point.x, point.y]);
    return (
      <Line
        {...common}
        points={points}
        closed
        fill={object.fillColor ?? "transparent"}
        stroke={selected ? "#2563eb" : object.strokeColor}
        strokeWidth={object.strokeWidth}
      />
    );
  }

  if (object.type === "text") {
    return (
      <Group {...common}>
        <Rect width={object.width} height={object.height} fill={object.fillColor ?? "transparent"} stroke={selected ? "#2563eb" : object.strokeColor} strokeWidth={object.strokeWidth} />
        <Text
          x={8}
          y={8}
          width={Math.max(object.width - 16, 1)}
          height={Math.max(object.height - 16, 1)}
          text={object.text || "텍스트"}
          fontSize={object.fontSize ?? 16}
          fill={object.strokeColor}
        />
      </Group>
    );
  }

  return (
    <Rect
      {...common}
      width={object.width}
      height={object.height}
      fill={object.fillColor ?? "transparent"}
      stroke={selected ? "#2563eb" : object.strokeColor}
      strokeWidth={object.strokeWidth}
    />
  );
}
