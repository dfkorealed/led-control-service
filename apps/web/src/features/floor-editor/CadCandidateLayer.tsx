import type { FloorImportCandidate } from "@led-control/shared";
import Konva from "konva";
import { useMemo, useRef, useState } from "react";
import { Label, Layer, Shape, Tag, Text } from "react-konva";
import { themeColor } from "../../components/ui";

interface CadCandidateLayerProps {
  candidates: FloorImportCandidate[];
  acceptedCandidateIds: Set<string>;
  transform: { x: number; y: number; scaleX: number; scaleY: number };
  zoom: number;
  disabled?: boolean;
  onToggle: (candidateId: string) => void;
}

export function CadCandidateLayer({
  candidates,
  acceptedCandidateIds,
  transform,
  zoom,
  disabled = false,
  onToggle
}: CadCandidateLayerProps) {
  const shape = useRef<Konva.Shape>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
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

  function candidateAtPointer() {
    const point = shape.current?.getRelativePointerPosition();
    if (!point) return null;
    let nearest: FloorImportCandidate | null = null;
    let nearestDistance = 12 / zoom;
    for (const candidate of candidates) {
      const distance = Math.hypot(candidate.x - point.x, candidate.y - point.y);
      if (distance <= nearestDistance) {
        nearest = candidate;
        nearestDistance = distance;
      }
    }
    return nearest;
  }

  if (candidates.length === 0) return null;
  return (
    <Layer {...transform} name="cad-candidate-layer" listening={!disabled}>
      <Shape
        ref={shape}
        name="cad-candidate-batch"
        listening={!disabled}
        sceneFunc={(context) => {
          context.setAttr("lineWidth", 2 / zoom);
          for (const candidate of candidates) {
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
          for (const candidate of candidates) {
            context.moveTo(candidate.x + 12 / zoom, candidate.y);
            context.arc(candidate.x, candidate.y, 12 / zoom, 0, Math.PI * 2);
          }
          context.fillShape(node);
        }}
        onMouseMove={() => setFocusedId(candidateAtPointer()?.id ?? null)}
        onMouseLeave={() => setFocusedId(null)}
        onClick={() => {
          const candidate = candidateAtPointer();
          if (!candidate) return;
          setFocusedId(candidate.id);
          onToggle(candidate.id);
        }}
        onTap={() => {
          const candidate = candidateAtPointer();
          if (!candidate) return;
          setFocusedId(candidate.id);
          onToggle(candidate.id);
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
