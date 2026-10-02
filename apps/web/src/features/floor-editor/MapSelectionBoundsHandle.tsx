import { useEffect, useRef } from "react";
import type Konva from "konva";
import { Rect, Transformer } from "react-konva";
import type { Bounds, MapElement, Point } from "@led-control/shared/map-document-contracts";
import { themeColor } from "../../components/ui";
import { boundsGestureTransform, finishSelectionResize } from "./map-selection-transform";

/** A whole-selection handle, never a prefix of per-element overlay nodes. */
export function MapSelectionBoundsHandle({ selectionKey, bounds, mapBounds, zoom, gridSize, locked, translateOnly = false, onMove, onTransform, onError, onPick }: {
  selectionKey: string; bounds: Bounds; zoom: number;
  mapBounds: { width: number; height: number };
  gridSize?: number; locked: boolean; translateOnly?: boolean;
  onMove: (delta: Point) => void; onError: (error: Error) => void;
  onTransform: (delta: MapElement["transform"]) => void;
  onPick?: (point: Point, child: boolean, additive: boolean) => void;
}) {
  const node = useRef<Konva.Rect>(null);
  const transformer = useRef<Konva.Transformer>(null);
  const started = useRef<string | null>(null);
  const anchor = useRef<string | null>(null);
  const reset = () => { node.current?.position({ x: bounds.minX, y: bounds.minY }); node.current?.scale({ x: 1, y: 1 }); node.current?.rotation(0); };
  useEffect(() => {
    started.current = null; node.current?.stopDrag(); transformer.current?.stopTransform(); reset();
    transformer.current?.nodes(!locked && !translateOnly && node.current ? [node.current] : []);
  }, [selectionKey, bounds, locked, translateOnly]);
  return <><Rect ref={node} name="map-selection-bounds" x={bounds.minX} y={bounds.minY}
    width={Math.max(4 / zoom, bounds.maxX - bounds.minX)} height={Math.max(4 / zoom, bounds.maxY - bounds.minY)}
    fill="transparent" stroke={themeColor("fixture-editor-selected")} strokeWidth={1 / zoom} dash={[6 / zoom, 4 / zoom]}
    draggable={!locked} onDragStart={() => { started.current = selectionKey; }}
    onClick={event => { event.cancelBubble = true; const point = event.target.getStage()?.getPointerPosition(); if (point) onPick?.(point, event.evt.detail >= 2, event.evt.shiftKey); }}
    onDragEnd={event => {
      const point = event.target.position();
      const delta = { x: point.x - bounds.minX, y: point.y - bounds.minY };
      reset();
      if (locked || started.current !== selectionKey) return;
      started.current = null;
      try { onMove(delta); }
      catch (error) { onError(error instanceof Error ? error : new Error("선택을 이동하지 못했습니다.")); }
    }}
    onTransformStart={() => { started.current = selectionKey; anchor.current = transformer.current?.getActiveAnchor() ?? null; }}
    onTransformEnd={() => {
      const target = node.current;
      if (!target) return;
      const transform = { x: target.x(), y: target.y(), scaleX: target.scaleX(), scaleY: target.scaleY(), rotation: target.rotation() };
      if (anchor.current && anchor.current !== "rotater") {
        // The four-screen-pixel interaction extent is not canonical line geometry.
        // Resizing its collapsed axis must keep the original world-space endpoint.
        if (bounds.minX === bounds.maxX) { transform.x = bounds.minX; transform.scaleX = 1; }
        if (bounds.minY === bounds.maxY) { transform.y = bounds.minY; transform.scaleY = 1; }
      }
      reset();
      if (locked || translateOnly || started.current !== selectionKey) return;
      started.current = null;
      try { onTransform(boundsGestureTransform(bounds, finishSelectionResize({ minX: 0, minY: 0,
        maxX: bounds.maxX - bounds.minX, maxY: bounds.maxY - bounds.minY }, transform, anchor.current, mapBounds, gridSize, true))); }
      catch (error) { onError(error instanceof Error ? error : new Error("선택을 변환하지 못했습니다.")); }
    }} />
    <Transformer ref={transformer} name="map-selection-transformer" flipEnabled={false} keepRatio rotateEnabled={!translateOnly}
      enabledAnchors={["top-left", "top-right", "bottom-left", "bottom-right"]} ignoreStroke
      boundBoxFunc={(old, next) => next.width > 0 && next.height > 0 ? next : old} />
  </>;
}
