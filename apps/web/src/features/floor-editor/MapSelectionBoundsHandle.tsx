import { useEffect, useRef } from "react";
import type Konva from "konva";
import { Rect } from "react-konva";
import type { Bounds, MapElement, Point } from "@led-control/shared/map-document-contracts";
import { themeColor } from "../../components/ui";
import { moveMapSelection } from "./map-element-editing";

/** A whole-selection handle, never a prefix of per-element overlay nodes. */
export function MapSelectionBoundsHandle({ selectionKey, selection, bounds, zoom, mapBounds, gridSize, locked, onMove, onError }: {
  selectionKey: string; selection: MapElement[]; bounds: Bounds; zoom: number;
  mapBounds: { width: number; height: number }; gridSize?: number; locked: boolean;
  onMove: (delta: Point) => void; onError: (error: Error) => void;
}) {
  const node = useRef<Konva.Rect>(null);
  const started = useRef<string | null>(null);
  useEffect(() => { started.current = null; node.current?.stopDrag(); node.current?.position({ x: bounds.minX, y: bounds.minY }); }, [selectionKey, selection, bounds, locked]);
  return <Rect ref={node} name="map-selection-bounds" x={bounds.minX} y={bounds.minY}
    width={Math.max(4 / zoom, bounds.maxX - bounds.minX)} height={Math.max(4 / zoom, bounds.maxY - bounds.minY)}
    fill="rgba(0,0,0,0.001)" stroke={themeColor("fixture-editor-selected")} strokeWidth={1 / zoom} dash={[6 / zoom, 4 / zoom]}
    draggable={!locked} onDragStart={() => { started.current = selectionKey; }}
    onDragEnd={event => {
      const delta = { x: event.target.x() - bounds.minX, y: event.target.y() - bounds.minY };
      event.target.position({ x: bounds.minX, y: bounds.minY });
      if (locked || started.current !== selectionKey) return;
      started.current = null;
      try { onMove(moveMapSelection(selection, delta, { mapBounds, gridSize }, true).offset); }
      catch (error) { onError(error instanceof Error ? error : new Error("선택을 이동하지 못했습니다.")); }
    }} />;
}
