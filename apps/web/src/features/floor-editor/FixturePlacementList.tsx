import { Search, GripVertical } from "lucide-react";
import { useMemo, useRef, useState, useEffect } from "react";
import { Button, SearchField, Text } from "../../components/ui";
import { useFloorEditorStore } from "./editor-store";
import type { EditorFixture } from "./editor-types";

export const FIXTURE_DRAG_TYPE = "application/x-floor-editor-fixture";
export interface FixturePlacementRowRegistry {
  register: (fixtureId: string, node: HTMLButtonElement | null) => void;
  focus: (fixtureId: string) => void;
}

export function createFixturePlacementRowRegistry(): FixturePlacementRowRegistry {
  const rows = new Map<string, HTMLButtonElement>();
  return {
    register(fixtureId, node) {
      if (node) rows.set(fixtureId, node);
      else rows.delete(fixtureId);
    },
    focus(fixtureId) {
      rows.get(fixtureId)?.focus();
    }
  };
}

export function placementLabel(fixture: EditorFixture) {
  return fixture.placementStatus === "unplaced" ? "미배치" : fixture.positionVerifiedAt || fixture.positionVerified ? "배치됨 · 위치 확인" : "배치됨 · 위치 미확인";
}

export function FixturePlacementList({ readOnly, rowRegistry }: { readOnly: boolean; rowRegistry: FixturePlacementRowRegistry }) {
  const fixtures = useFloorEditorStore((s) => s.state?.fixtures);
  const floorId = useFloorEditorStore((s) => s.state?.floor.id);
  const selectedIds = useFloorEditorStore((s) => s.selectedFixtureIds);
  const locked = useFloorEditorStore((s) => s.layers.fixtures.locked);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<"all" | "placed" | "unplaced">("unplaced");
  const [scrollTop, setScrollTop] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const filtered = useMemo(() => (fixtures ?? []).filter((f) => {
    const placed = f.placementStatus !== "unplaced";
    return (filter === "all" || placed === (filter === "placed"))
      && [f.name, f.serialNumber, f.meshAddress, f.id].some((v) => String(v ?? "").toLocaleLowerCase().includes(query.toLocaleLowerCase()));
  }), [fixtures, query, filter]);
  useEffect(() => { setScrollTop(0); if (list.current) list.current.scrollTop = 0; }, [query, filter]);
  const rowHeight = 64;
  const start = Math.max(0, Math.floor(scrollTop / rowHeight) - 3);
  const visible = filtered.slice(start, start + 16);
  return <aside className="flex min-h-0 flex-1 flex-col gap-2 p-2.5" aria-label="조명 목록">
    <div className="flex items-center justify-between gap-2"><Text as="strong" variant="body-sm" weight="semibold">조명</Text><Text as="span" variant="caption" tone="secondary">{fixtures?.length ?? 0}개</Text></div>
    <div className="relative"><Search className="pointer-events-none absolute left-3 top-3 text-content-muted" size={16} aria-hidden="true" /><SearchField aria-label="조명 검색" className="[&_input]:pl-10" value={query} onChange={setQuery} placeholder="이름 / 시리얼 / Mesh" /></div>
    <div className="grid grid-cols-3 gap-1 rounded-control bg-surface-inset p-1" role="tablist" aria-label="배치 상태">
      {([["all", "전체"], ["placed", "배치"], ["unplaced", "미배치"]] as const).map(([value, label]) => <Button key={value} size="sm" variant={filter === value ? "primary" : "ghost"} role="tab" aria-selected={filter === value} onClick={() => setFilter(value)}>{label}</Button>)}
    </div>
    <div className="flex items-center justify-between gap-2"><Text as="span" variant="caption" tone="secondary">{filtered.length}개 · 선택 {selectedIds.length}개</Text><Button size="sm" variant="ghost" onClick={() => useFloorEditorStore.getState().selectFixtures(filtered.map((f) => f.id))} disabled={!filtered.length}>전체 선택</Button></div>
    <div className="h-48 min-h-40 flex-none overflow-y-auto overscroll-contain compact:h-100 compact:flex-1" ref={list} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} data-testid="placement-list">
      {/* Virtual-list height and row offsets are runtime geometry for up to 1,000 fixtures. */}
      <div className="relative" style={{ height: filtered.length * rowHeight }}>
        {visible.map((fixture, offset) => <Button key={fixture.id} type="button" variant="ghost" data-testid={`placement-fixture-${fixture.id}`}
          ref={(node) => rowRegistry.register(fixture.id, node)}
          className={`absolute h-16 w-full justify-start gap-1 rounded-none border-x-0 border-t-0 border-b-border-subtle px-1 py-2 text-left text-content-primary ${selectedIds.includes(fixture.id) ? "bg-action-primary-soft shadow-focus" : "bg-surface-panel"} ${!readOnly && !locked && fixture.placementStatus === "unplaced" ? "cursor-grab" : "cursor-pointer"}`}
          style={{ top: (start + offset) * rowHeight }}
          aria-pressed={selectedIds.includes(fixture.id)}
          draggable={!readOnly && !locked && fixture.placementStatus === "unplaced"}
          onDragStart={(event) => {
            if (readOnly || locked || fixture.placementStatus !== "unplaced") { event.preventDefault(); return; }
            event.dataTransfer.setData(FIXTURE_DRAG_TYPE, fixture.id);
            event.dataTransfer.effectAllowed = "move";
          }}
          onClick={(event) => {
            const store = useFloorEditorStore.getState();
            store.selectFixture(fixture.id, event.shiftKey);
            if (!event.shiftKey && fixture.placementStatus !== "unplaced") store.fit(true);
          }}>
          <GripVertical size={14} aria-hidden="true" /><span className="grid min-w-0 gap-1"><strong className="truncate text-label">{fixture.name}</strong><small className="text-overline text-content-muted">{placementLabel(fixture)}</small></span>
        </Button>)}
      </div>
      {!filtered.length && <Text variant="body-sm" tone="secondary">해당 조명 없음</Text>}
    </div>
    <div className="flex items-center justify-between gap-2" data-floor-id={floorId}><Text as="span" variant="caption" tone="secondary">배치 {(fixtures ?? []).filter((f) => f.placementStatus !== "unplaced").length}</Text><Text as="span" variant="caption" tone="secondary">미배치 {(fixtures ?? []).filter((f) => f.placementStatus === "unplaced").length}</Text></div>
  </aside>;
}
