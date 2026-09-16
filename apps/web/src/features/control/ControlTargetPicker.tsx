import { useEffect, useMemo, useState } from "react";
import type { Dashboard, DashboardFixture } from "../../api/queries";
import { Button, Card, Checkbox, SearchField, SelectBox, Text } from "../../components/ui";
import { fixtureGroupReadiness, floorMeshReadiness } from "./control-readiness";
import { humanizeDeviceResponseMessage } from "./control-copy";
import {
  MAX_FIXTURE_SELECTION,
  type ControlMode,
  type ControlSelection,
  toggleFixtureSelection
} from "./control-selection";

const FIXTURE_LIST_BATCH_SIZE = 100;

export type { ControlMode, ControlSelection } from "./control-selection";
export { controlSelectionToDimmingTarget } from "./control-selection";

interface ControlTargetPickerProps {
  dashboard: Dashboard;
  selection: ControlSelection;
  disabled: boolean;
  allowedModes?: readonly ControlMode[];
  fixtureFilter?: (fixture: DashboardFixture) => boolean;
  fillAvailableHeight?: boolean;
  onChange: (selection: ControlSelection) => void;
}

type StatusFilter = "all" | DashboardFixture["status"];

const statusFilterItems: ReadonlyArray<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "모든 상태" },
  { id: "online", label: "온라인" },
  { id: "offline", label: "오프라인" },
  { id: "fault", label: "장애" }
];

export function ControlTargetPicker({
  dashboard,
  selection,
  disabled,
  allowedModes = ["fixtures", "floor", "group"],
  fixtureFilter,
  fillAvailableHeight = false,
  onChange
}: ControlTargetPickerProps) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [floorFilter, setFloorFilter] = useState("all");
  const [visibleLimit, setVisibleLimit] = useState(FIXTURE_LIST_BATCH_SIZE);
  const [selectionLimitReached, setSelectionLimitReached] = useState(false);
  const fixturesWithFloor = useMemo(
    () => dashboard.floors.flatMap((floor) => floor.fixtures.map((fixture) => ({ fixture, floor }))),
    [dashboard]
  );
  const filteredFixtures = useMemo(() => {
    const keyword = search.trim().toLocaleLowerCase();
    return fixturesWithFloor.filter(({ fixture, floor }) => {
      const matchesFixture = !fixtureFilter || fixtureFilter(fixture);
      const matchesSearch = !keyword || fixture.name.toLocaleLowerCase().includes(keyword);
      const matchesStatus = statusFilter === "all" || fixture.status === statusFilter;
      const matchesFloor = floorFilter === "all" || floor.id === floorFilter;
      return matchesFixture && matchesSearch && matchesStatus && matchesFloor;
    });
  }, [fixtureFilter, fixturesWithFloor, search, statusFilter, floorFilter]);
  const selectedFixtureIds = useMemo(
    () => new Set(selection.mode === "fixtures" ? selection.fixtureIds : []),
    [selection]
  );
  const selectedFixtureGatewayId = useMemo(() => {
    if (selection.mode !== "fixtures" || selection.fixtureIds.length === 0) return null;
    const firstFixtureId = selection.fixtureIds[0];
    return fixturesWithFloor.find(({ fixture }) => fixture.id === firstFixtureId)?.fixture.gateway?.id ?? null;
  }, [fixturesWithFloor, selection]);
  const visibleFixtures = useMemo(
    () => filteredFixtures.slice(0, visibleLimit),
    [filteredFixtures, visibleLimit]
  );

  useEffect(() => {
    setVisibleLimit(FIXTURE_LIST_BATCH_SIZE);
    setSelectionLimitReached(false);
  }, [dashboard.site.id, search, statusFilter, floorFilter]);

  function switchMode(mode: ControlMode) {
    if (mode === "fixtures") onChange({ mode, fixtureIds: [] });
    if (mode === "floor") onChange({ mode, floorId: "" });
    if (mode === "group") onChange({ mode, groupId: "" });
  }

  function toggleFixture(fixtureId: string) {
    if (selection.mode !== "fixtures") return;
    const fixture = fixturesWithFloor.find(({ fixture: item }) => item.id === fixtureId)?.fixture;
    if (!selectedFixtureIds.has(fixtureId) && selectedFixtureGatewayId && fixture?.gateway?.id !== selectedFixtureGatewayId) {
      return;
    }
    const next = toggleFixtureSelection(selection.fixtureIds, fixtureId);
    setSelectionLimitReached(next.limitReached);
    onChange({ mode: "fixtures", fixtureIds: next.fixtureIds });
  }

  function selectVisibleFixtures() {
    if (selection.mode !== "fixtures") return;
    const fixtureIds = new Set(selection.fixtureIds);
    const gatewayId = selectedFixtureGatewayId
      ?? filteredFixtures.find(({ fixture }) => fixture.gateway?.id)?.fixture.gateway?.id
      ?? null;
    const unselectedFilteredIds = filteredFixtures
      .filter(({ fixture }) => !fixtureIds.has(fixture.id) && (!gatewayId || fixture.gateway?.id === gatewayId))
      .map(({ fixture }) => fixture.id);
    const availableSlots = Math.max(0, MAX_FIXTURE_SELECTION - fixtureIds.size);
    unselectedFilteredIds.slice(0, availableSlots).forEach((fixtureId) => fixtureIds.add(fixtureId));
    setSelectionLimitReached(unselectedFilteredIds.length > availableSlots);
    onChange({
      mode: "fixtures",
      fixtureIds: Array.from(fixtureIds).slice(0, MAX_FIXTURE_SELECTION)
    });
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3" data-control-target-picker="">
      <div className="grid grid-cols-3 gap-2 max-compact:grid-cols-1" role="group" aria-label="제어 대상 유형">
        {([
          ["fixtures", "개별/다중"],
          ["floor", "층"],
          ["group", "구역"]
        ] as const).filter(([mode]) => allowedModes.includes(mode)).map(([mode, label]) => (
          <Button
            key={mode}
            variant="ghost"
            type="button"
            aria-pressed={selection.mode === mode}
            className={selection.mode === mode ? "border-action-primary bg-action-primary-soft" : ""}
            disabled={disabled}
            onClick={() => switchMode(mode)}
          >
            {label}
          </Button>
        ))}
      </div>

      {selection.mode === "fixtures" ? (
        <>
          <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-end gap-2 max-compact:grid-cols-1">
            <SearchField label={<span className="sr-only">조명 검색</span>} placeholder="조명 이름 검색" value={search} onChange={setSearch} />
            <SelectBox
              label={<span className="sr-only">상태 필터</span>}
              items={statusFilterItems}
              selectedKey={statusFilter}
              onSelectionChange={(key) => setStatusFilter(key ?? "all")}
            />
            <SelectBox
              label={<span className="sr-only">층 필터</span>}
              items={[{ id: "all", label: "모든 층" }, ...dashboard.floors.map((floor) => ({ id: floor.id, label: floor.name }))]}
              selectedKey={floorFilter}
              onSelectionChange={(key) => setFloorFilter(key ?? "all")}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Text as="span" variant="caption">{Math.min(visibleLimit, filteredFixtures.length)} / {filteredFixtures.length}개 표시</Text>
            <Button variant="secondary" type="button" disabled={disabled || filteredFixtures.length === 0} onClick={selectVisibleFixtures}>검색 결과 전체 선택</Button>
            <Button
              variant="secondary"
              type="button"
              disabled={disabled || selection.fixtureIds.length === 0}
              onClick={() => {
                setSelectionLimitReached(false);
                onChange({ mode: "fixtures", fixtureIds: [] });
              }}
            >
              선택 해제
            </Button>
          </div>
          <Text variant="caption" tone={selectionLimitReached ? "danger" : "secondary"} role={selectionLimitReached ? "alert" : undefined}>
            한 번에 최대 1,000개 조명까지 선택할 수 있습니다.
          </Text>
          <div className={`grid min-h-0 max-h-72 flex-1 content-start overflow-y-auto overscroll-contain rounded-panel border border-border-default ${fillAvailableHeight ? "tablet:max-h-none" : ""}`} role="group" aria-label="조명 목록" data-control-target-list="">
            {visibleFixtures.map(({ fixture, floor }) => {
              const checked = selectedFixtureIds.has(fixture.id);
              const lockedToOtherGateway = Boolean(
                selectedFixtureGatewayId && !checked && fixture.gateway?.id !== selectedFixtureGatewayId
              );
              return (
                <div className={`grid min-h-11 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 border-b border-border-subtle pb-2 last:border-b-0 ${checked ? "bg-action-primary-soft" : "bg-surface-panel"}`} key={fixture.id}>
                  <Checkbox
                    size="lg"
                    className="min-w-0 [&>label]:w-full [&>label]:min-w-0 [&>label]:justify-start [&>label]:rounded-none [&>label]:border-0 [&>label]:bg-transparent [&>label]:px-3 [&>label]:py-2 [&>label[data-selected]]:bg-transparent"
                    label={(
                      <span className="flex min-w-0 items-center gap-3">
                        <span aria-hidden="true" className={`h-2.5 w-2.5 shrink-0 rounded-pill ${fixture.status === "fault" ? "bg-fixture-fault" : fixture.status === "offline" ? "bg-fixture-offline" : "bg-fixture-connected"}`} />
                        <Text as="strong" weight="semibold">{fixture.name}</Text>
                        <span className="sr-only"> 선택</span>
                      </span>
                    )}
                    isSelected={checked}
                    isDisabled={disabled || lockedToOtherGateway}
                    onChange={() => toggleFixture(fixture.id)}
                  />
                  <Text as="small" variant="caption" tone="secondary" className="min-w-0 pl-16">{floor.name} · {fixtureStatusLabel(fixture.status)} · {fixtureHealthLabel(fixture)}</Text>
                  <Text as="span" weight="semibold" className="col-start-2 row-span-2 row-start-1 pr-3 tabular-nums">{fixture.brightness}%</Text>
                </div>
              );
            })}
            {filteredFixtures.length === 0 ? <Text className="p-4 text-center" tone="secondary">조건에 맞는 조명이 없습니다.</Text> : null}
          </div>
          {visibleLimit < filteredFixtures.length ? (
            <Button
              variant="secondary"
              className="w-full"
              type="button"
              disabled={disabled}
              onClick={() => setVisibleLimit((current) => current + FIXTURE_LIST_BATCH_SIZE)}
            >
              더 보기
            </Button>
          ) : null}
        </>
      ) : null}

      {selection.mode === "floor" ? (
        <Card className="grid overflow-hidden" role="group" aria-label="층 목록">
          {dashboard.floors.map((floor) => {
            const readiness = floorMeshReadiness(floor);
            return (
              <Button
                variant="secondary"
                type="button"
                aria-label={floor.name}
                className={`h-auto min-h-11 justify-between rounded-none border-x-0 border-t-0 px-4 py-3 text-left last:border-b-0 ${selection.floorId === floor.id ? "bg-action-primary-soft" : ""}`}
                key={floor.id}
                disabled={disabled || !readiness.ready}
                onClick={() => onChange({ mode: "floor", floorId: floor.id })}
              >
                <span className="grid gap-1">
                  <Text as="strong" weight="semibold">{floor.name}</Text>
                  <Text as="small" variant="caption" tone="secondary">층 전체 조명 · {readiness.label}</Text>
                  {readiness.error ? <Text as="small" variant="caption" tone="danger">{humanizeDeviceResponseMessage(readiness.error)}</Text> : null}
                </span>
                <span>{floor.fixtures.length}개</span>
              </Button>
            );
          })}
          {dashboard.floors.length === 0 ? <Text className="p-4 text-center" tone="secondary">등록된 층이 없습니다.</Text> : null}
        </Card>
      ) : null}

      {selection.mode === "group" ? (
        <Card className="grid overflow-hidden" role="group" aria-label="구역 목록">
          {dashboard.groups.map((group) => {
            const readiness = fixtureGroupReadiness(group);
            return (
              <Button
                variant="secondary"
                type="button"
                aria-label={`${group.name} 선택`}
                className={`h-auto min-h-11 justify-between rounded-none border-x-0 border-t-0 px-4 py-3 text-left last:border-b-0 ${selection.groupId === group.id ? "bg-action-primary-soft" : ""}`}
                key={group.id}
                disabled={disabled || !readiness.ready}
                onClick={() => onChange({ mode: "group", groupId: group.id })}
              >
                <span className="grid gap-1">
                  <Text as="strong" weight="semibold">{group.name}</Text>
                  <Text as="small" variant="caption" tone="secondary">저장된 구역 · {readiness.label}</Text>
                  {readiness.error ? <Text as="small" variant="caption" tone="danger">{humanizeDeviceResponseMessage(readiness.error)}</Text> : null}
                </span>
                <span>{group.fixtureIds.length}개</span>
              </Button>
            );
          })}
          {dashboard.groups.length === 0 ? <Text className="p-4 text-center" tone="secondary">등록된 구역이 없습니다.</Text> : null}
        </Card>
      ) : null}
    </div>
  );
}

function fixtureStatusLabel(status: DashboardFixture["status"]) {
  if (status === "online") return "온라인";
  if (status === "fault") return "장애";
  return "오프라인";
}

function fixtureHealthLabel(fixture: DashboardFixture) {
  if (!fixture.health) return "Health 확인 대기";
  return fixture.health.faultCodes.length > 0 ? "Health 장애" : "Health 정상";
}
