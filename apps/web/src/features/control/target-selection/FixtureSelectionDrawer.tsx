import { useEffect, useMemo, useRef, useState } from "react";
import type { Dashboard, DashboardFixture } from "../../../api/queries";
import { Button, Checkbox, ModalDialog, SearchField, SelectBox, Text } from "../../../components/ui";

const BATCH_SIZE = 100;
type StatusFilter = "all" | DashboardFixture["status"];

interface FixtureSelectionDrawerProps {
  open: boolean;
  dashboard: Dashboard;
  selectedFixtureIds: ReadonlySet<string>;
  disabledFixtureIds: ReadonlySet<string>;
  disabled: boolean;
  onClose: () => void;
  onToggleFixture: (fixtureId: string) => void;
}

export function FixtureSelectionDrawer({ open, dashboard, selectedFixtureIds, disabledFixtureIds, disabled, onClose, onToggleFixture }: FixtureSelectionDrawerProps) {
  const searchRef = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [floorId, setFloorId] = useState("all");
  const [limit, setLimit] = useState(BATCH_SIZE);
  const fixtures = useMemo(() => dashboard.floors.flatMap((floor) => floor.fixtures.map((fixture) => ({ fixture, floor }))), [dashboard.floors]);
  const filtered = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase();
    return fixtures.filter(({ fixture, floor }) => (!keyword || fixture.name.toLocaleLowerCase().includes(keyword))
      && (status === "all" || fixture.status === status) && (floorId === "all" || floor.id === floorId));
  }, [fixtures, floorId, search, status]);

  useEffect(() => { setLimit(BATCH_SIZE); }, [search, status, floorId]);
  useEffect(() => { if (open) queueMicrotask(() => searchRef.current?.focus()); }, [open]);

  return <ModalDialog isOpen={open} title="조명 목록" description="목록에서 조명을 선택합니다." closeLabel="조명 목록 닫기" onClose={onClose}
    className="max-compact:grid! max-compact:h-full! max-compact:max-h-full! max-compact:w-full! max-compact:grid-rows-[auto_minmax(0,1fr)_auto] max-compact:overflow-hidden!"
    bodyClassName="grid min-h-0 overflow-hidden"
    actions={<div className="pb-safe-area-bottom"><Button type="button" variant="primary" onClick={onClose}>선택 완료</Button></div>}>
    <div className="grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-3">
    <div className="grid min-w-0 gap-2 compact:grid-cols-[minmax(0,1fr)_auto_auto]">
      <SearchField ref={searchRef} size="lg" label={<span className="sr-only">조명 검색</span>} placeholder="조명 이름 검색" value={search} onChange={setSearch} />
      <SelectBox label={<span className="sr-only">상태 필터</span>} items={[{ id: "all", label: "모든 상태" }, { id: "online", label: "온라인" }, { id: "offline", label: "오프라인" }, { id: "fault", label: "장애" }]}
        selectedKey={status} onSelectionChange={(value) => setStatus(value ?? "all")} />
      <SelectBox label={<span className="sr-only">층 필터</span>} items={[{ id: "all", label: "모든 층" }, ...dashboard.floors.map((floor) => ({ id: floor.id, label: floor.name }))]}
        selectedKey={floorId} onSelectionChange={(value) => setFloorId(value ?? "all")} />
    </div>
    <div className="min-h-0 overflow-y-auto overscroll-contain rounded-panel border border-border-default" role="group" aria-label="조명 목록" data-fixture-selection-list="">
      {filtered.slice(0, limit).map(({ fixture, floor }) => {
        const selected = selectedFixtureIds.has(fixture.id);
        const unavailable = !selected && (disabled || disabledFixtureIds.has(fixture.id));
        return <div key={fixture.id} className="grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 border-b border-border-subtle px-3 py-2 last:border-b-0">
          <Checkbox size="lg" label={<span className="min-w-0"><strong>{fixture.name}</strong><span className="sr-only"> 선택</span></span>}
            isSelected={selected} isDisabled={unavailable} onChange={() => onToggleFixture(fixture.id)} />
          <Text as="span" variant="caption" tone="secondary">{fixture.placementStatus === "unplaced" ? "미배치" : floor.name}</Text>
        </div>;
      })}
      {filtered.length === 0 ? <Text className="p-4 text-center" tone="secondary">조건에 맞는 조명이 없습니다.</Text> : null}
    </div>
    </div>
    {limit < filtered.length ? <Button type="button" variant="secondary" disabled={disabled} onClick={() => setLimit((value) => value + BATCH_SIZE)}>더 보기</Button> : null}
  </ModalDialog>;
}
