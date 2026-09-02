import { Search } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { DimmingTarget } from "@led-control/shared";
import type { Dashboard, DashboardFixture } from "../../api/queries";
import { Button } from "../../components/ui";
import { fixtureGroupReadiness, floorMeshReadiness } from "./control-readiness";

const MAX_FIXTURE_SELECTION = 1000;
const FIXTURE_LIST_BATCH_SIZE = 100;

export type ControlMode = "fixtures" | "floor" | "group";

export type ControlSelection =
  | { mode: "fixtures"; fixtureIds: string[] }
  | { mode: "floor"; floorId: string }
  | { mode: "group"; groupId: string };

export function controlSelectionToDimmingTarget(selection: ControlSelection): DimmingTarget | null {
  if (selection.mode === "fixtures") {
    if (selection.fixtureIds.length === 0) return null;
    return selection.fixtureIds.length === 1
      ? { type: "fixture", fixtureId: selection.fixtureIds[0] }
      : { type: "fixtures", fixtureIds: selection.fixtureIds };
  }
  if (selection.mode === "floor") {
    return selection.floorId ? { type: "floor", floorId: selection.floorId } : null;
  }
  return selection.groupId ? { type: "group", groupId: selection.groupId } : null;
}

interface ControlTargetPickerProps {
  dashboard: Dashboard;
  selection: ControlSelection;
  disabled: boolean;
  allowedModes?: readonly ControlMode[];
  fixtureFilter?: (fixture: DashboardFixture) => boolean;
  onChange: (selection: ControlSelection) => void;
}

type StatusFilter = "all" | DashboardFixture["status"];

export function ControlTargetPicker({
  dashboard,
  selection,
  disabled,
  allowedModes = ["fixtures", "floor", "group"],
  fixtureFilter,
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
    if (selectedFixtureIds.has(fixtureId)) {
      setSelectionLimitReached(false);
      onChange({ mode: "fixtures", fixtureIds: selection.fixtureIds.filter((id) => id !== fixtureId) });
      return;
    }
    if (selection.fixtureIds.length >= MAX_FIXTURE_SELECTION) {
      setSelectionLimitReached(true);
      return;
    }
    setSelectionLimitReached(false);
    onChange({ mode: "fixtures", fixtureIds: [...selection.fixtureIds, fixtureId] });
  }

  function selectVisibleFixtures() {
    if (selection.mode !== "fixtures") return;
    const fixtureIds = new Set(selection.fixtureIds);
    const unselectedFilteredIds = filteredFixtures
      .map(({ fixture }) => fixture.id)
      .filter((fixtureId) => !fixtureIds.has(fixtureId));
    const availableSlots = Math.max(0, MAX_FIXTURE_SELECTION - fixtureIds.size);
    unselectedFilteredIds.slice(0, availableSlots).forEach((fixtureId) => fixtureIds.add(fixtureId));
    setSelectionLimitReached(unselectedFilteredIds.length > availableSlots);
    onChange({
      mode: "fixtures",
      fixtureIds: Array.from(fixtureIds).slice(0, MAX_FIXTURE_SELECTION)
    });
  }

  return (
    <div className="control-target-picker">
      <div className="segmented-control control-target-modes" role="group" aria-label="제어 대상 유형">
        {([
          ["fixtures", "개별/다중"],
          ["floor", "층"],
          ["group", "구역"]
        ] as const).filter(([mode]) => allowedModes.includes(mode)).map(([mode, label]) => (
          <button
            key={mode}
            type="button"
            aria-pressed={selection.mode === mode}
            className={selection.mode === mode ? "active" : ""}
            disabled={disabled}
            onClick={() => switchMode(mode)}
          >
            {label}
          </button>
        ))}
      </div>

      {selection.mode === "fixtures" ? (
        <>
          <div className="control-filter-bar">
            <label className="control-search-field">
              <span className="sr-only">조명 검색</span>
              <Search size={16} aria-hidden="true" />
              <input
                type="search"
                aria-label="조명 검색"
                placeholder="조명 이름 검색"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </label>
            <label className="select-field compact">
              <span className="sr-only">상태 필터</span>
              <select aria-label="상태 필터" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}>
                <option value="all">모든 상태</option>
                <option value="online">온라인</option>
                <option value="offline">오프라인</option>
                <option value="fault">장애</option>
              </select>
            </label>
            <label className="select-field compact">
              <span className="sr-only">층 필터</span>
              <select aria-label="층 필터" value={floorFilter} onChange={(event) => setFloorFilter(event.target.value)}>
                <option value="all">모든 층</option>
                {dashboard.floors.map((floor) => <option key={floor.id} value={floor.id}>{floor.name}</option>)}
              </select>
            </label>
          </div>
          <div className="control-selection-actions">
            <span>{Math.min(visibleLimit, filteredFixtures.length)} / {filteredFixtures.length}개 표시</span>
            <button type="button" disabled={disabled || filteredFixtures.length === 0} onClick={selectVisibleFixtures}>검색 결과 전체 선택</button>
            <button
              type="button"
              disabled={disabled || selection.fixtureIds.length === 0}
              onClick={() => {
                setSelectionLimitReached(false);
                onChange({ mode: "fixtures", fixtureIds: [] });
              }}
            >
              선택 해제
            </button>
          </div>
          <p className={selectionLimitReached ? "control-selection-limit danger-text" : "control-selection-limit"} role={selectionLimitReached ? "alert" : undefined}>
            한 번에 최대 1,000개 조명까지 선택할 수 있습니다.
          </p>
          <div className="control-target-list" role="group" aria-label="조명 목록">
            {visibleFixtures.map(({ fixture, floor }) => {
              const checked = selectedFixtureIds.has(fixture.id);
              return (
                <label className={`control-fixture-row${checked ? " selected" : ""}`} key={fixture.id}>
                  <input
                    type="checkbox"
                    aria-label={`${fixture.name} 선택`}
                    checked={checked}
                    disabled={disabled}
                    onChange={() => toggleFixture(fixture.id)}
                  />
                  <span className={`device-state ${fixture.status === "fault" ? "danger" : fixture.status === "offline" ? "muted" : ""}`} />
                  <span className="control-target-identity">
                    <strong>{fixture.name}</strong>
                    <small>{floor.name} · {fixtureStatusLabel(fixture.status)} · {fixtureHealthLabel(fixture)}</small>
                  </span>
                  <span className="control-target-value">{fixture.brightness}%</span>
                </label>
              );
            })}
            {filteredFixtures.length === 0 ? <p className="control-empty-state">조건에 맞는 조명이 없습니다.</p> : null}
          </div>
          {visibleLimit < filteredFixtures.length ? (
            <Button
              variant="secondary"
              className="control-load-more"
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
        <div className="control-target-list control-target-button-list" role="group" aria-label="층 목록">
          {dashboard.floors.map((floor) => {
            const readiness = floorMeshReadiness(floor);
            return (
              <button
                type="button"
                aria-label={floor.name}
                className={selection.floorId === floor.id ? "control-target-button selected" : "control-target-button"}
                key={floor.id}
                disabled={disabled || !readiness.ready}
                onClick={() => onChange({ mode: "floor", floorId: floor.id })}
              >
                <span>
                  <strong>{floor.name}</strong>
                  <small>층 전체 조명 · {readiness.label}</small>
                  {readiness.error ? <small className="danger-text">{readiness.error}</small> : null}
                </span>
                <span>{floor.fixtures.length}개</span>
              </button>
            );
          })}
          {dashboard.floors.length === 0 ? <p className="control-empty-state">등록된 층이 없습니다.</p> : null}
        </div>
      ) : null}

      {selection.mode === "group" ? (
        <div className="control-target-list control-target-button-list" role="group" aria-label="구역 목록">
          {dashboard.groups.map((group) => {
            const readiness = fixtureGroupReadiness(group);
            return (
              <button
                type="button"
                aria-label={`${group.name} 선택`}
                className={selection.groupId === group.id ? "control-target-button selected" : "control-target-button"}
                key={group.id}
                disabled={disabled || !readiness.ready}
                onClick={() => onChange({ mode: "group", groupId: group.id })}
              >
                <span>
                  <strong>{group.name}</strong>
                  <small>저장된 구역 · {readiness.label}</small>
                  {readiness.error ? <small className="danger-text">{readiness.error}</small> : null}
                </span>
                <span>{group.fixtureIds.length}개</span>
              </button>
            );
          })}
          {dashboard.groups.length === 0 ? <p className="control-empty-state">등록된 구역이 없습니다.</p> : null}
        </div>
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
