import { useEffect, useRef } from "react";
import type Konva from "konva";
import { Rect, Transformer } from "react-konva";
import type { Bounds, MapElement, Point } from "@led-control/shared/map-document-contracts";
import { themeColor } from "../../components/ui";
import { snapPointToGrid } from "./geometry";
import { boundsGestureTransform } from "./map-selection-transform";

/** A whole-selection handle, never a prefix of per-element overlay nodes. */
export function MapSelectionBoundsHandle({ selectionKey, bounds, zoom, gridSize, locked, translateOnly = false, onMove, onTransform, onError }: {
  selectionKey: string; bounds: Bounds; zoom: number;
  gridSize?: number; locked: boolean; translateOnly?: boolean;
  onMove: (delta: Point) => void; onError: (error: Error) => void;
  onTransform: (delta: MapElement["transform"]) => void;
}) {
  const node = useRef<Konva.Rect>(null);
  const transformer = useRef<Konva.Transformer>(null);
  const started = useRef<string | null>(null);
  const reset = () => { node.current?.position({ x: bounds.minX, y: bounds.minY }); node.current?.scale({ x: 1, y: 1 }); node.current?.rotation(0); };
  useEffect(() => {
    started.current = null; node.current?.stopDrag(); transformer.current?.stopTransform(); reset();
    transformer.current?.nodes(!locked && !translateOnly && node.current ? [node.current] : []);
  }, [selectionKey, bounds, locked, translateOnly]);
  return <><Rect ref={node} name="map-selection-bounds" x={bounds.minX} y={bounds.minY}
    width={Math.max(4 / zoom, bounds.maxX - bounds.minX)} height={Math.max(4 / zoom, bounds.maxY - bounds.minY)}
    fill="transparent" stroke={themeColor("fixture-editor-selected")} strokeWidth={1 / zoom} dash={[6 / zoom, 4 / zoom]}
    draggable={!locked} onDragStart={() => { started.current = selectionKey; }}
    onDragEnd={event => {
      const point = gridSize ? snapPointToGrid(event.target.position(), gridSize) : event.target.position();
      const delta = { x: point.x - bounds.minX, y: point.y - bounds.minY };
      reset();
      if (locked || started.current !== selectionKey) return;
      started.current = null;
      try { onMove(delta); }
      catch (error) { onError(error instanceof Error ? error : new Error("선택을 이동하지 못했습니다.")); }
    }}
    onTransformStart={() => { started.current = selectionKey; }}
    onTransformEnd={() => {
      const target = node.current;
      if (!target) return;
      const transform = { x: target.x(), y: target.y(), scaleX: target.scaleX(), scaleY: target.scaleY(), rotation: target.rotation() };
      reset();
      if (locked || translateOnly || started.current !== selectionKey) return;
      started.current = null;
      try { onTransform(boundsGestureTransform(bounds, transform)); }
      catch (error) { onError(error instanceof Error ? error : new Error("선택을 변환하지 못했습니다.")); }
    }} />
    <Transformer ref={transformer} name="map-selection-transformer" flipEnabled={false} keepRatio rotateEnabled={!translateOnly}
      enabledAnchors={["top-left", "top-right", "bottom-left", "bottom-right"]} ignoreStroke
      boundBoxFunc={(old, next) => next.width > 0 && next.height > 0 ? next : old} />
  </>;
}
