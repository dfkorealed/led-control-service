import Konva from "konva";
import { useLayoutEffect, useMemo, useRef } from "react";
import { Ellipse, Group, Line, Path, Rect, Shape, Transformer } from "react-konva";
import type { MapElement, MapOp, Point } from "@led-control/shared/map-document-contracts";
import { themeColor } from "../../components/ui";
import type { AlignmentGuide } from "./geometry";
import {
  createMapElementUpdateOps, getMapSelectionBounds, MAP_ELEMENT_IDENTITY, moveMapSelection, transformMapSelection,
  uniqueMapSelection, type MapElementAlignmentOptions, type MapElementTransform
} from "./map-element-editing";

export const MAX_MAP_ELEMENT_OVERLAY_ELEMENTS = 64;
export const MAX_MAP_ELEMENT_OVERLAY_POINTS = 131_072;

export class MapElementOverlayLimitError extends RangeError {
  readonly code = "MAP_ELEMENT_OVERLAY_LIMIT";
  constructor(readonly reason: "elements" | "points", readonly count: number, readonly limit: number) {
    super(reason === "elements" ? "선택 도형의 편집 표시 한도를 초과했습니다." : "선택 도형의 좌표 및 문자 표시 한도를 초과했습니다.");
    this.name = "MapElementOverlayLimitError";
  }
}

export class MapElementOverlayTextError extends RangeError {
  readonly code = "MAP_ELEMENT_OVERLAY_TEXT_UNSUPPORTED";
  constructor(readonly elementId: string) {
    super("내용이 있는 텍스트의 편집 표시 영역은 너비와 높이가 0보다 커야 합니다.");
    this.name = "MapElementOverlayTextError";
  }
}

export interface MapElementOverlayProps extends MapElementAlignmentOptions {
  /** Canonical selected elements only, never the document or overview tiles. */
  selection: MapElement[];
  zoom: number;
  readOnly?: boolean;
  /** Effective upstream layer/group lock. A locked member disables the whole gesture. */
  locked?: boolean;
  onChange: (ops: MapOp[]) => void;
  onError?: (error: Error) => void;
  onGuidesChange?: (guides: AlignmentGuide[]) => void;
}

/** Host preflight: use these exact visible IDs for promotion masks; on failure mask nothing
 * and use the U10b whole-selection bbox handle. This is not a partial-selection API.
 */
export function getMapElementOverlaySelection(selection: MapElement[]): MapElement[] {
  // Refuse the whole promotion rather than silently editing only the first N members of a group.
  if (selection.length > MAX_MAP_ELEMENT_OVERLAY_ELEMENTS) {
    throw new MapElementOverlayLimitError("elements", selection.length, MAX_MAP_ELEMENT_OVERLAY_ELEMENTS);
  }
  const elements = uniqueMapSelection(selection).filter(element => element.visible);
  let points = 0;
  for (const element of elements) {
    // Reject the entire promotion before returning IDs; the host must retain renderer originals.
    if (element.type === "text" && element.geometry.text.length > 0 &&
      (element.geometry.width <= 0 || element.geometry.height <= 0)) throw new MapElementOverlayTextError(element.id);
    points += element.type === "polygon" ? element.geometry.outer.length + element.geometry.holes.reduce((sum, ring) => sum + ring.length, 0)
      : element.type === "polyline" || element.type === "triangle" ? element.geometry.points.length
      : element.type === "text" ? element.geometry.text.length : 4;
  }
  if (points > MAX_MAP_ELEMENT_OVERLAY_POINTS) throw new MapElementOverlayLimitError("points", points, MAX_MAP_ELEMENT_OVERLAY_POINTS);
  return elements;
}

/** Mount inside the existing world-space Konva Layer/Group; the host supplies the camera. */
export function MapElementOverlay({ selection, readOnly = false, locked = false, zoom, onChange,
  onError, onGuidesChange, mapBounds, gridSize, guideTargets, guideThreshold }: MapElementOverlayProps) {
  const nodeRef = useRef<Konva.Group>(null);
  const transformerRef = useRef<Konva.Transformer>(null);
  const gesture = useRef<"drag" | "transform" | null>(null);
  const callbacks = useRef({ onError, onGuidesChange });
  callbacks.current = { onError, onGuidesChange };
  // Hosts commonly map selected IDs into a fresh array when guides rerender. Only changed
  // canonical element references (immutable inputs), order or camera should cancel a gesture.
  const previousSelection = useRef(selection);
  if (selection.length !== previousSelection.current.length || selection.some((element, index) => element !== previousSelection.current[index])) {
    previousSelection.current = selection;
  }
  const stableSelection = previousSelection.current;
  const prepared = useMemo(() => {
    try {
      if (!Number.isFinite(zoom) || zoom <= 0) throw new RangeError("확대 비율이 올바르지 않습니다.");
      const elements = getMapElementOverlaySelection(stableSelection);
      return { elements, originals: uniqueMapSelection(stableSelection), error: null };
    } catch (cause) {
      return { elements: [], originals: [], error: cause instanceof Error ? cause : new Error("도형을 표시할 수 없습니다.") };
    }
  }, [stableSelection, zoom]);
  const elements = prepared.elements;
  const originals = prepared.originals;
  const single = originals.length === 1;
  const disabled = readOnly || locked || selection.some(element => element.locked);
  // One element uses its own rotated frame, permitting edge resizing without introducing shear.
  // Multiple elements share an identity world frame; their original transforms remain on children.
  const frame = single ? originals[0].transform : MAP_ELEMENT_IDENTITY;
  const restore = () => {
    nodeRef.current?.setAttrs({ ...frame, skewX: 0, skewY: 0 });
    transformerRef.current?.forceUpdate();
    nodeRef.current?.getLayer()?.batchDraw();
    callbacks.current.onGuidesChange?.([]);
  };

  useLayoutEffect(() => {
    gesture.current = null;
    const node = nodeRef.current;
    node?.stopDrag();
    transformerRef.current?.stopTransform();
    node?.setAttrs({ ...frame, skewX: 0, skewY: 0 });
    transformerRef.current?.nodes(!disabled && node ? [node] : []);
    transformerRef.current?.getLayer()?.batchDraw();
    callbacks.current.onGuidesChange?.([]);
    if (prepared.error) callbacks.current.onError?.(prepared.error);
    return () => { gesture.current = null; callbacks.current.onGuidesChange?.([]); };
  }, [prepared, disabled, mapBounds.width, mapBounds.height, gridSize]);

  if (!elements.length) return null;
  const localBounds = getMapSelectionBounds(single
    ? [{ ...originals[0], transform: MAP_ELEMENT_IDENTITY }] : originals)!;
  const zeroWidth = localBounds.maxX === localBounds.minX;
  const zeroHeight = localBounds.maxY === localBounds.minY;
  const hitWidth = zeroWidth ? 8 / (zoom * frame.scaleX) : localBounds.maxX - localBounds.minX;
  const hitHeight = zeroHeight ? 8 / (zoom * frame.scaleY) : localBounds.maxY - localBounds.minY;
  const alignment = { mapBounds, gridSize, guideTargets, guideThreshold: guideThreshold ?? 6 / zoom };
  const report = (cause: unknown) => callbacks.current.onError?.(
    cause instanceof Error ? cause : new Error("도형을 수정할 수 없습니다.")
  );
  const start = (kind: "drag" | "transform") => { gesture.current = disabled ? null : kind; };
  const commit = (kind: "drag" | "transform") => {
    const node = nodeRef.current;
    if (!node) return;
    if (disabled || gesture.current !== kind) { restore(); return; }
    gesture.current = null;
    try {
      let ops: MapOp[];
      if (kind === "drag") {
        // Konva's node position already preserves pointer-down offset; do not jump to pointer coordinates.
        const { offset } = moveMapSelection(originals, { x: node.x() - frame.x, y: node.y() - frame.y }, alignment, true);
        ops = transformMapSelection(originals, { ...MAP_ELEMENT_IDENTITY, ...offset }, mapBounds);
      } else {
        if (Math.abs(node.skewX()) > 1e-8 || Math.abs(node.skewY()) > 1e-8) throw new RangeError("기울임 변환은 지원하지 않습니다.");
        const transform: MapElementTransform = { x: node.x(), y: node.y(), scaleX: node.scaleX(), scaleY: node.scaleY(),
          rotation: ((node.rotation() + 180) % 360 + 360) % 360 - 180 };
        ops = single
          ? createMapElementUpdateOps(originals, element => ({ ...element, transform }), mapBounds)
          : transformMapSelection(originals, transform, mapBounds);
      }
      if (ops.length) onChange(ops);
    } catch (cause) { report(cause); }
    finally { restore(); }
  };
  const selectedColor = themeColor("fixture-editor-selected");
  return <>
    <Group ref={nodeRef} name="map-element-overlay" {...frame} draggable={!disabled}
      onMouseDown={event => { event.cancelBubble = true; }}
      onTouchStart={event => { event.cancelBubble = true; }}
      onDragStart={() => start("drag")} onTransformStart={() => start("transform")}
      onDragMove={() => {
        const node = nodeRef.current;
        if (!node || disabled || gesture.current !== "drag") return;
        try {
          const aligned = moveMapSelection(originals, { x: node.x() - frame.x, y: node.y() - frame.y }, alignment, false);
          node.position({ x: frame.x + aligned.offset.x, y: frame.y + aligned.offset.y });
          onGuidesChange?.(aligned.guides);
        } catch (cause) { gesture.current = null; restore(); report(cause); }
      }}
      onDragEnd={() => commit("drag")} onTransformEnd={() => commit("transform")}
    >
      {/* A horizontal/vertical line needs a nonsingular interaction frame. A group containing
          hidden children needs its whole bbox, but never their individual rendered geometry. */}
      {zeroWidth || zeroHeight || originals.length !== elements.length ? <Rect name="map-element-hit-frame" fill="rgba(0,0,0,0)"
        x={localBounds.minX - (zeroWidth ? hitWidth / 2 : 0)} y={localBounds.minY - (zeroHeight ? hitHeight / 2 : 0)}
        width={hitWidth} height={hitHeight} /> : null}
      {[...elements].sort((a, b) => a.zIndex - b.zIndex).map(element => <Group key={element.id}
        name="map-element-selected" {...(single ? MAP_ELEMENT_IDENTITY : element.transform)} opacity={element.style.opacity}>
        <ElementShape element={element} zoom={zoom} />
      </Group>)}
    </Group>
    {!disabled ? <Transformer ref={transformerRef} name="map-element-transformer" rotateEnabled flipEnabled={false}
      ignoreStroke keepRatio={false} borderStroke={selectedColor} anchorStroke={selectedColor}
      anchorFill={themeColor("surface-panel")}
      enabledAnchors={["top-left", "top-center", "top-right", "middle-left", "middle-right", "bottom-left", "bottom-center", "bottom-right"]}
      boundBoxFunc={(previous, next) => Number.isFinite(next.x) && Number.isFinite(next.y) &&
        Number.isFinite(next.rotation) && Number.isFinite(next.width) && Number.isFinite(next.height) &&
        next.width > 0 && next.height > 0 ? next : previous} /> : null}
  </>;
}

const flatPoints = (points: Point[]) => points.flatMap(point => [point.x, point.y]);
const ringPath = (points: Point[]) => points.map((point, index) => `${index ? "L" : "M"}${point.x} ${point.y}`).join(" ") + " Z";

function arcPath(element: Extract<MapElement, { type: "arc" }>): string {
  const { center, radius, startAngle, endAngle, counterClockwise } = element.geometry;
  const normalize = (angle: number) => ((angle % 360) + 360) % 360;
  const start = normalize(startAngle);
  // U2's counterClockwise advances the numeric angle in logical space, unlike canvas' named flag.
  const sweep = counterClockwise ? normalize(endAngle - start) || 360 : -(normalize(start - endAngle) || 360);
  const point = (angle: number) => ({ x: center.x + radius * Math.cos(angle * Math.PI / 180),
    y: center.y + radius * Math.sin(angle * Math.PI / 180) });
  const first = point(start);
  let path = `M${first.x} ${first.y}`;
  // SVG cannot encode a full circle with coincident endpoints in a single arc.
  const segments = Math.ceil(Math.abs(sweep) / 180);
  for (let i = 1; i <= segments; i++) {
    const end = point(start + sweep * i / segments);
    path += ` A${radius} ${radius} 0 0 ${sweep > 0 ? 1 : 0} ${end.x} ${end.y}`;
  }
  return path;
}

function ElementShape({ element, zoom }: { element: MapElement; zoom: number }) {
  const style = { name: "map-element-shape", stroke: element.style.strokeColor ?? undefined,
    strokeEnabled: element.style.strokeColor !== null && element.style.strokeWidth > 0,
    fill: element.style.fillColor ?? undefined, fillEnabled: element.style.fillColor !== null,
    // Canonical stroke width is in world units, not multiplied by element scale. The parent owns zoom.
    strokeWidth: element.style.strokeWidth * zoom, strokeScaleEnabled: false, hitStrokeWidth: Math.max(8, element.style.strokeWidth * zoom) };
  switch (element.type) {
    case "line": return <Line {...style} points={flatPoints([element.geometry.start, element.geometry.end])} fillEnabled={false} />;
    case "rectangle": return <Rect {...style} x={element.geometry.origin.x} y={element.geometry.origin.y}
      width={element.geometry.width} height={element.geometry.height} />;
    case "triangle": return <Line {...style} points={flatPoints(element.geometry.points)} closed />;
    case "polyline": return <Line {...style} points={flatPoints(element.geometry.points)} fillEnabled={false} />;
    case "polygon": return <Path {...style} data={[element.geometry.outer, ...element.geometry.holes].map(ringPath).join(" ")} fillRule="evenodd" />;
    case "ellipse": return <Ellipse {...style} x={element.geometry.center.x} y={element.geometry.center.y}
      radiusX={element.geometry.radiusX} radiusY={element.geometry.radiusY} />;
    case "arc": return <Path {...style} data={arcPath(element)} fillEnabled={false} />;
    case "text": return <MapTextShape element={element} />;
  }
}

function MapTextShape({ element }: { element: Extract<MapElement, { type: "text" }> }) {
  const { position, width, height, text } = element.geometry;
  const color = element.style.strokeColor ?? element.style.fillColor;
  return <Shape name="map-element-shape" x={position.x} y={position.y} width={width} height={height}
    fill={color ?? undefined} fillEnabled={color !== null} strokeEnabled={false}
    sceneFunc={context => {
      if (!text || color === null || width <= 0 || height <= 0) return;
      context.save();
      // Match the canonical MapScene draft atlas in CadSceneRenderer.createTextMeshes:
      // the complete 32px sans-serif run, 2px padding, 40px cell and 2048px width cap
      // map to the geometry quad. fontSize is canonical metadata, not a clipping limit.
      // Drawing directly avoids one bitmap allocation per selected text element.
      context.beginPath(); context.rect(0, 0, width, height); context.clip();
      context.font = "32px sans-serif";
      context.textBaseline = "top";
      context.textAlign = "left";
      context.letterSpacing = "0px";
      const measuredWidth = Math.max(1, context.measureText(text).width);
      const cellWidth = Math.min(2048, Math.max(8, Math.ceil(measuredWidth) + 4));
      context.scale(width / cellWidth, height / 40);
      context.translate(2, 2);
      context.scale(Math.min(1, (cellWidth - 4) / measuredWidth), 1);
      context.fillStyle = color;
      context.fillText(text, 0, 0);
      context.restore();
    }}
    hitFunc={(context, shape) => {
      context.beginPath(); context.rect(0, 0, width, height); context.closePath(); context.fillStrokeShape(shape);
    }} />;
}
