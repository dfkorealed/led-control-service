import { Trash2 } from "lucide-react";
import { useState } from "react";
import { ConfirmDialog, IconButton, Text } from "../../components/ui";
import type { FixturePlacementRowRegistry } from "./FixturePlacementList";
import { useFloorEditorStore } from "./editor-store";

export function FixturePlacementAction({ readOnly, rowRegistry }: { readOnly: boolean; rowRegistry: FixturePlacementRowRegistry }) {
  const state = useFloorEditorStore((s) => s.state);
  const selection = useFloorEditorStore((s) => s.selection);
  const pan = useFloorEditorStore((s) => s.pan);
  const zoom = useFloorEditorStore((s) => s.zoom);
  const viewport = useFloorEditorStore((s) => s.viewport);
  const layers = useFloorEditorStore((s) => s.layers);
  const lockedIds = useFloorEditorStore((s) => s.lockedFixtureIds);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const fixture = selection?.kind === "fixture" ? state?.fixtures.find((f) => f.id === selection.id) : null;
  const canUnplace = !readOnly && fixture && fixture.placementStatus !== "unplaced" && layers.fixtures.visible && !layers.fixtures.locked && !lockedIds.includes(fixture.id);
  if (!fixture || !canUnplace) return null;
  const x = pan.x + fixture.x * zoom + (fixture.size ?? 20) * zoom / 2 + 12;
  const y = pan.y + fixture.y * zoom - (fixture.size ?? 20) * zoom / 2 - 52;
  return <>
    {/* Selected-fixture screen coordinates are runtime Konva geometry. */}
    <IconButton variant="secondary" className="absolute z-5 h-14 min-h-14 w-14 min-w-14 bg-surface-panel p-0 shadow-popover" aria-label="배치 해제" title="배치 해제"
      style={{ left: Math.max(4, Math.min(viewport.width - 60, x)), top: Math.max(4, Math.min(viewport.height - 60, y)) }}
      onMouseDown={(e) => e.stopPropagation()} onClick={(e) => { e.stopPropagation(); setConfirmId(fixture.id); }}><Trash2 size={17} aria-hidden="true" /></IconButton>
    {confirmId === fixture.id && <ConfirmDialog title="이 조명을 맵에서 제거할까요?" confirmLabel="배치 해제" onCancel={() => setConfirmId(null)} onConfirm={() => {
      if (readOnly || useFloorEditorStore.getState().state?.floor.id !== state?.floor.id) return;
      useFloorEditorStore.getState().unplaceFixture(fixture.id); setConfirmId(null);
      requestAnimationFrame(() => rowRegistry.focus(fixture.id));
    }}><Text>{fixture.name}이 미배치 목록으로 이동합니다. 장비 등록, 제어와 사용 기록은 유지됩니다.</Text></ConfirmDialog>}
  </>;
}
