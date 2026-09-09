import { Search, GripVertical } from "lucide-react";
import { useMemo, useRef, useState, useEffect } from "react";
import { Button } from "../../components/ui";
import { useFloorEditorStore } from "./editor-store";
import type { EditorFixture } from "./editor-types";

export const FIXTURE_DRAG_TYPE = "application/x-floor-editor-fixture";
export function placementLabel(fixture: EditorFixture) {
  return fixture.placementStatus === "unplaced" ? "미배치" : fixture.positionVerifiedAt || fixture.positionVerified ? "배치됨 · 위치 확인" : "배치됨 · 위치 미확인";
}

export function FixturePlacementList({ readOnly }: { readOnly: boolean }) {
  const fixtures = useFloorEditorStore((s) => s.state?.fixtures);
  const floorId = useFloorEditorStore((s) => s.state?.floor.id);
  const selectedIds = useFloorEditorStore((s) => s.selectedFixtureIds);
  const locked = useFloorEditorStore((s) => s.layers.fixtures.locked);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("unplaced");
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
  return <aside className="fixture-placement-list" aria-label="조명 목록">
    <div className="editor-list-heading"><strong>조명</strong><span>{fixtures?.length ?? 0}개</span></div>
    <label className="editor-search"><Search size={16} /><input aria-label="조명 검색" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="이름 / 시리얼 / Mesh" /></label>
    <div className="segmented-control" role="tablist" aria-label="배치 상태">
      {[["all", "전체"], ["placed", "배치"], ["unplaced", "미배치"]].map(([value, label]) => <button key={value} role="tab" aria-selected={filter === value} className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>{label}</button>)}
    </div>
    <div className="editor-list-heading"><span>{filtered.length}개 · 선택 {selectedIds.length}개</span><Button variant="ghost" onClick={() => useFloorEditorStore.getState().selectFixtures(filtered.map((f) => f.id))} disabled={!filtered.length}>전체 선택</Button></div>
    <div className="editor-virtual-list" ref={list} onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)} data-testid="placement-list">
      <div style={{ height: filtered.length * rowHeight, position: "relative" }}>
        {visible.map((fixture, offset) => <button key={fixture.id} type="button" data-testid={`placement-fixture-${fixture.id}`}
          className={`editor-fixture-row ${selectedIds.includes(fixture.id) ? "selected" : ""}`}
          style={{ position: "absolute", top: (start + offset) * rowHeight, height: rowHeight }}
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
          <GripVertical size={14} aria-hidden="true" /><span><strong>{fixture.name}</strong><small>{placementLabel(fixture)}</small></span>
        </button>)}
      </div>
      {!filtered.length && <p className="muted-text">해당 조명 없음</p>}
    </div>
    <div className="editor-list-heading" data-floor-id={floorId}><span>배치 {(fixtures ?? []).filter((f) => f.placementStatus !== "unplaced").length}</span><span>미배치 {(fixtures ?? []).filter((f) => f.placementStatus === "unplaced").length}</span></div>
  </aside>;
}
