import type { FloorImportCandidate } from "@led-control/shared";
import Konva from "konva";
import { useEffect, useMemo, useRef, useState } from "react";
import { Label, Layer, Shape, Tag, Text } from "react-konva";
import { themeColor } from "../../components/ui";

interface CadCandidateLayerProps {
  candidates: FloorImportCandidate[];
  acceptedCandidateIds: Set<string>;
  transform: { x: number; y: number; scaleX: number; scaleY: number };
  zoom: number;
  viewportBounds: CadCandidateBounds;
  disabled?: boolean;
  focusedCandidateId?: string | null;
  onFocusedCandidateChange?: (candidateId: string | null) => void;
  onToggle?: (candidateId: string) => void;
}

export interface CadCandidateBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CadCandidateSpatialIndex {
  cellSize: number;
  buckets: Map<string, FloorImportCandidate[]>;
}

const SPATIAL_CELL_SIZE = 64;

export function screenPointToCadWorld(
  point: { x: number; y: number },
  transform: { x: number; y: number; scaleX: number; scaleY: number }
) {
  return {
    x: (point.x - transform.x) / transform.scaleX,
    y: (point.y - transform.y) / transform.scaleY
  };
}

export function buildCadCandidateSpatialIndex(
  candidates: FloorImportCandidate[],
  cellSize = SPATIAL_CELL_SIZE
): CadCandidateSpatialIndex {
  const buckets = new Map<string, FloorImportCandidate[]>();
  for (const candidate of candidates) {
    const key = cellKey(Math.floor(candidate.x / cellSize), Math.floor(candidate.y / cellSize));
    const bucket = buckets.get(key);
    if (bucket) bucket.push(candidate);
    else buckets.set(key, [candidate]);
  }
  return { cellSize, buckets };
}

export function queryCadCandidates(index: CadCandidateSpatialIndex, bounds: CadCandidateBounds) {
  const candidates: FloorImportCandidate[] = [];
  visitBuckets(index, bounds, (bucket) => { candidates.push(...bucket); });
  return candidates.filter((candidate) => (
    candidate.x >= bounds.x && candidate.x <= bounds.x + bounds.width &&
    candidate.y >= bounds.y && candidate.y <= bounds.y + bounds.height
  ));
}

export function findCadCandidateAtPoint(
  index: CadCandidateSpatialIndex,
  point: { x: number; y: number },
  radius: number
) {
  const result: { candidate: FloorImportCandidate | null } = { candidate: null };
  let nearestDistanceSquared = radius * radius;
  let inspectedCount = 0;
  visitBuckets(index, {
    x: point.x - radius,
    y: point.y - radius,
    width: radius * 2,
    height: radius * 2
  }, (bucket) => {
    for (const item of bucket) {
      inspectedCount += 1;
      const deltaX = item.x - point.x;
      const deltaY = item.y - point.y;
      const distanceSquared = deltaX * deltaX + deltaY * deltaY;
      if (distanceSquared <= nearestDistanceSquared) {
        result.candidate = item;
        nearestDistanceSquared = distanceSquared;
      }
    }
  });
  return { candidate: result.candidate, inspectedCount };
}

export function CadCandidateLayer({
  candidates,
  acceptedCandidateIds,
  transform,
  zoom,
  viewportBounds,
  disabled = false,
  focusedCandidateId,
  onFocusedCandidateChange,
  onToggle
}: CadCandidateLayerProps) {
  const shape = useRef<Konva.Shape>(null);
  const pointerFrame = useRef<number | null>(null);
  const latestPointer = useRef<{ x: number; y: number } | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const focusedId = focusedCandidateId ?? hoveredId;
  const spatialIndex = useMemo(() => buildCadCandidateSpatialIndex(candidates), [candidates]);
  const visibleCandidates = useMemo(() => {
    const margin = 16 / zoom;
    return queryCadCandidates(spatialIndex, {
      x: viewportBounds.x - margin,
      y: viewportBounds.y - margin,
      width: viewportBounds.width + margin * 2,
      height: viewportBounds.height + margin * 2
    });
  }, [spatialIndex, viewportBounds.x, viewportBounds.y, viewportBounds.width, viewportBounds.height, zoom]);
  const focused = useMemo(
    () => candidates.find((candidate) => candidate.id === focusedId) ?? null,
    [candidates, focusedId]
  );
  const colors = useMemo(() => ({
    accepted: themeColor("fixture-editor-selected"),
    rejected: themeColor("fixture-editor-offline"),
    panel: themeColor("surface-panel"),
    border: themeColor("fixture-editor-border"),
    text: themeColor("fixture-editor-label")
  }), []);
  const radius = 7 / zoom;
  const listening = Boolean(onFocusedCandidateChange || onToggle);

  useEffect(() => () => {
    if (pointerFrame.current !== null) window.cancelAnimationFrame(pointerFrame.current);
  }, []);

  function candidateAtPointer(point = shape.current?.getStage()?.getPointerPosition()): FloorImportCandidate | null {
    if (!point) return null;
    const worldPoint = screenPointToCadWorld(point, transform);
    return findCadCandidateAtPoint(spatialIndex, worldPoint, 12 / zoom).candidate;
  }

  function focus(candidateId: string | null) {
    setHoveredId((current) => current === candidateId ? current : candidateId);
    onFocusedCandidateChange?.(candidateId);
  }

  function schedulePointerFocus() {
    latestPointer.current = shape.current?.getStage()?.getPointerPosition() ?? null;
    if (pointerFrame.current !== null) return;
    pointerFrame.current = window.requestAnimationFrame(() => {
      pointerFrame.current = null;
      focus(candidateAtPointer(latestPointer.current)?.id ?? null);
    });
  }

  if (candidates.length === 0) return null;
  return (
    <Layer {...transform} name="cad-candidate-layer" listening={!disabled && listening}>
      <Shape
        ref={shape}
        name="cad-candidate-batch"
        listening={!disabled && listening}
        sceneFunc={(context) => {
          context.setAttr("lineWidth", 2 / zoom);
          for (const candidate of visibleCandidates) {
            context.save();
            context.translate(candidate.x, candidate.y);
            context.rotate(candidate.rotation * Math.PI / 180);
            context.setAttr("strokeStyle", acceptedCandidateIds.has(candidate.id) ? colors.accepted : colors.rejected);
            context.beginPath();
            context.arc(0, 0, radius, 0, Math.PI * 2);
            context.moveTo(-radius, 0);
            context.lineTo(radius, 0);
            context.moveTo(0, -radius);
            context.lineTo(0, radius);
            context.stroke();
            context.restore();
          }
        }}
        hitFunc={(context, node) => {
          context.beginPath();
          for (const candidate of visibleCandidates) {
            context.moveTo(candidate.x + 12 / zoom, candidate.y);
            context.arc(candidate.x, candidate.y, 12 / zoom, 0, Math.PI * 2);
          }
          context.fillShape(node);
        }}
        onMouseMove={schedulePointerFocus}
        onMouseLeave={() => {
          if (pointerFrame.current !== null) window.cancelAnimationFrame(pointerFrame.current);
          pointerFrame.current = null;
          latestPointer.current = null;
          focus(null);
        }}
        onClick={() => {
          const candidate = candidateAtPointer();
          if (!candidate) return;
          focus(candidate.id);
          onToggle?.(candidate.id);
        }}
        onTap={() => {
          const candidate = candidateAtPointer();
          if (!candidate) return;
          focus(candidate.id);
          onToggle?.(candidate.id);
        }}
      />
      {focused ? <Label
        name="cad-candidate-detail"
        x={focused.x + 10 / zoom}
        y={focused.y - 10 / zoom}
        scaleX={1 / zoom}
        scaleY={1 / zoom}
        listening={false}
      >
        <Tag fill={colors.panel} stroke={colors.border} strokeWidth={1} cornerRadius={4} />
        <Text
          text={`${focused.layerName} · 신뢰도 ${Math.round(focused.confidence * 100)}% · ${acceptedCandidateIds.has(focused.id) ? "적용" : "제외"}`}
          padding={6}
          fontSize={12}
          fill={colors.text}
        />
      </Label> : null}
    </Layer>
  );
}

function visitBuckets(
  index: CadCandidateSpatialIndex,
  bounds: CadCandidateBounds,
  visit: (bucket: FloorImportCandidate[]) => boolean | void
) {
  const minCellX = Math.floor(bounds.x / index.cellSize);
  const minCellY = Math.floor(bounds.y / index.cellSize);
  const maxCellX = Math.floor((bounds.x + bounds.width) / index.cellSize);
  const maxCellY = Math.floor((bounds.y + bounds.height) / index.cellSize);
  for (let cellY = minCellY; cellY <= maxCellY; cellY += 1) {
    for (let cellX = minCellX; cellX <= maxCellX; cellX += 1) {
      const bucket = index.buckets.get(cellKey(cellX, cellY));
      if (bucket && visit(bucket) === false) return;
    }
  }
}

function cellKey(x: number, y: number) {
  return `${x}:${y}`;
}
