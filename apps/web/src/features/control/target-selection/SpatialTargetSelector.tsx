import { useEffect, useMemo, useState, type ReactNode } from "react";
import type { Dashboard, DashboardFixture } from "../../../api/queries";
import { useFloorMapSnapshot } from "../../../api/queries";
import { Button, ConfirmDialog, Text } from "../../../components/ui";
import { FloorScene } from "../../floor-map/FloorScene";
import { FloorMapViewport, type MapInteractionMode, type MapSelectionRect } from "../../floor-map/FloorMapViewport";
import { resolveControlSelection, toggleFixtureSelection, type ControlMode, type ControlSelection } from "../control-selection";
import { humanizeDeviceResponseMessage } from "../control-copy";
import { FixtureSelectionDrawer } from "./FixtureSelectionDrawer";
import { SelectionSummaryPanel } from "./SelectionSummaryPanel";
import { TargetSelectionToolbar } from "./TargetSelectionToolbar";

export interface SpatialTargetSelectorProps {
  siteId: string;
  dashboard: Dashboard;
  selection: ControlSelection;
  disabled: boolean;
  allowedModes?: readonly ControlMode[];
  fixtureFilter?: (fixture: DashboardFixture) => boolean;
  requiredGatewayId?: string | null;
  modeLabels?: Partial<Record<ControlMode, string>>;
  modeSelectionSemantics?: "current" | "pressed";
  interactionMode?: MapInteractionMode;
  onInteractionModeChange?: (mode: MapInteractionMode) => void;
  compactSummary?: ReactNode;
  onChange: (selection: ControlSelection) => void;
}

const defaultModes: readonly ControlMode[] = ["fixtures", "floor", "group"];

export function SpatialTargetSelector({
  siteId, dashboard, selection, disabled, allowedModes = defaultModes, fixtureFilter, requiredGatewayId = null, modeLabels, modeSelectionSemantics,
  interactionMode: controlledInteractionMode, onInteractionModeChange, compactSummary, onChange
}: SpatialTargetSelectorProps) {
  const selectionFloorId = floorForSelection(dashboard, selection);
  const validSelectionFloorId = dashboard.floors.some((floor) => floor.id === selectionFloorId) ? selectionFloorId : null;
  const [activeFloorId, setActiveFloorId] = useState(() => validSelectionFloorId ?? dashboard.floors[0]?.id ?? "");
  const [listOpen, setListOpen] = useState(false);
  const [requestedMode, setRequestedMode] = useState<ControlMode | null>(null);
  const [localInteractionMode, setLocalInteractionMode] = useState<MapInteractionMode>("select");
  const interactionMode = controlledInteractionMode ?? localInteractionMode;
  const activeFloor = dashboard.floors.find((floor) => floor.id === activeFloorId) ?? dashboard.floors[0];
  const mapQuery = useFloorMapSnapshot(activeFloor?.id, siteId);
  const resolved = useMemo(() => selectionWithConstraints(resolveControlSelection(dashboard, selection), fixtureFilter, requiredGatewayId), [dashboard, fixtureFilter, requiredGatewayId, selection]);
  const selectedFixtureIds = useMemo(() => new Set(resolved.fixtureIds), [resolved.fixtureIds]);
  const directGatewayId = useMemo(() => {
    if (selection.mode !== "fixtures" || selection.fixtureIds.length === 0) return null;
    return fixtureById(dashboard, selection.fixtureIds[0])?.gateway?.id ?? null;
  }, [dashboard, selection]);
  const disabledFixtureIds = useMemo(() => new Set(dashboard.floors.flatMap((floor) => floor.fixtures)
    .filter((fixture) => disabled || !isFixtureEligible(fixture, fixtureFilter, requiredGatewayId, directGatewayId, selection.mode === "fixtures" && selectedFixtureIds.has(fixture.id)))
    .map((fixture) => fixture.id)), [dashboard.floors, directGatewayId, disabled, fixtureFilter, requiredGatewayId, selectedFixtureIds, selection.mode]);

  useEffect(() => {
    const activeFloorStillExists = dashboard.floors.some((floor) => floor.id === activeFloorId);
    const reconciledFloorId = validSelectionFloorId ?? (activeFloorStillExists ? activeFloorId : dashboard.floors[0]?.id ?? "");
    if (reconciledFloorId !== activeFloorId) setActiveFloorId(reconciledFloorId);
  }, [activeFloorId, dashboard.floors, validSelectionFloorId]);
  useEffect(() => {
    if (!mapQuery.data && !mapQuery.isLoading && mapQuery.error) setListOpen(true);
  }, [mapQuery.data, mapQuery.error, mapQuery.isLoading]);

  function setInteractionMode(mode: MapInteractionMode) {
    if (controlledInteractionMode === undefined) setLocalInteractionMode(mode);
    onInteractionModeChange?.(mode);
  }

  function requestModeChange(mode: ControlMode) {
    if (mode === selection.mode || disabled) return;
    if (hasSelection(selection)) { setRequestedMode(mode); return; }
    changeMode(mode);
  }

  function changeMode(mode: ControlMode) {
    setRequestedMode(null);
    if (mode === "fixtures") onChange({ mode, fixtureIds: [] });
    if (mode === "floor") onChange({ mode, floorId: activeFloor?.id ?? "" });
    if (mode === "group") onChange({ mode, groupId: "" });
  }

  function toggleFixture(fixtureId: string) {
    if (disabled || selection.mode !== "fixtures") return;
    const fixture = fixtureById(dashboard, fixtureId);
    const selected = selectedFixtureIds.has(fixtureId);
    if (!fixture || !isFixtureEligible(fixture, fixtureFilter, requiredGatewayId, directGatewayId, selected)) return;
    const next = toggleFixtureSelection(selection.fixtureIds, fixtureId);
    onChange({ mode: "fixtures", fixtureIds: next.fixtureIds });
  }

  function selectArea(rect: MapSelectionRect) {
    if (disabled || selection.mode !== "fixtures" || !activeFloor) return;
    const areaFixtures = activeFloor.fixtures.filter((fixture) => fixture.placementStatus !== "unplaced" && fixture.x >= rect.left && fixture.x <= rect.right && fixture.y >= rect.top && fixture.y <= rect.bottom)
      .filter((fixture) => isFixtureEligible(fixture, fixtureFilter, requiredGatewayId, null, selectedFixtureIds.has(fixture.id)));
    // An empty direct selection has no existing gateway lock, so the first eligible
    // area member establishes it before any additional fixture can be included.
    const gatewayId = directGatewayId ?? areaFixtures[0]?.gateway?.id ?? null;
    const fixtureIds = areaFixtures.filter((fixture) => !gatewayId || fixture.gateway?.id === gatewayId)
      .map((fixture) => fixture.id);
    const next = new Set(selection.fixtureIds);
    fixtureIds.forEach((fixtureId) => { if (next.size < 1000) next.add(fixtureId); });
    onChange({ mode: "fixtures", fixtureIds: [...next].sort() });
  }

  const sceneSelection = useMemo(() => ({ kind: "multiple" as const, selectedFixtureIds, disabledFixtureIds }), [disabledFixtureIds, selectedFixtureIds]);
  const group = selection.mode === "group" ? dashboard.groups.find((item) => item.id === selection.groupId) : undefined;

  return <section className="grid min-h-0 min-w-0 gap-3 overflow-hidden" aria-label="공간 대상 선택" data-spatial-target-selector="">
    <TargetSelectionToolbar allowedModes={allowedModes} selection={selection} activeFloorId={activeFloor?.id ?? ""} floors={dashboard.floors} modeLabels={modeLabels}
      modeSelectionSemantics={modeSelectionSemantics}
      interactionMode={interactionMode} disabled={disabled} onModeChange={requestModeChange} onFloorChange={setActiveFloorId}
      onInteractionModeChange={setInteractionMode} onOpenList={() => setListOpen(true)} />
    <div className="grid min-h-0 min-w-0 gap-3 tablet:grid-cols-[minmax(0,1fr)_minmax(16rem,1fr)]">
      <div className="relative min-h-64 min-w-0 overflow-hidden rounded-panel border border-border-default bg-surface-inset tablet:min-h-0">
        {mapQuery.data && activeFloor ? <FloorMapViewport snapshot={mapQuery.data} ariaLabel={`${activeFloor.name} 도면`} mode={interactionMode} onAreaSelect={selectArea} viewportTestId="target-selection-map-viewport">
          <FloorScene snapshot={mapQuery.data} fixtures={activeFloor.fixtures} interactive={false} floorName={activeFloor.name} selection={sceneSelection} coarsePointer onFixturePress={toggleFixture} />
        </FloorMapViewport> : <div className="grid h-full place-items-center p-4"><Text tone="secondary">등록된 도면이 없어 목록으로 선택합니다.</Text></div>}
        {mapQuery.data && mapQuery.error ? <Text className="absolute top-3 left-3 z-6 rounded-control border border-border-default bg-surface-panel px-2 py-1" role="alert" tone="danger">도면을 최신 상태로 갱신하지 못했습니다.</Text> : null}
        {group ? <Text className="pointer-events-none absolute top-3 right-3 z-6 rounded-control border border-border-default bg-surface-panel px-2 py-1" variant="caption">{group.name}</Text> : null}
      </div>
      <div className="min-h-0 overflow-y-auto overscroll-contain"><SelectionSummaryPanel resolved={resolved} compactSummary={compactSummary} />
        {selection.mode === "floor" ? <SelectionChoices kind="floor" dashboard={dashboard} selection={selection} disabled={disabled} fixtureFilter={fixtureFilter} requiredGatewayId={requiredGatewayId} onChange={onChange} /> : null}
        {selection.mode === "group" ? <SelectionChoices kind="group" dashboard={dashboard} selection={selection} disabled={disabled} fixtureFilter={fixtureFilter} requiredGatewayId={requiredGatewayId} onChange={onChange} /> : null}
      </div>
    </div>
    <FixtureSelectionDrawer open={listOpen} dashboard={dashboard} selectedFixtureIds={selectedFixtureIds} disabledFixtureIds={disabledFixtureIds} disabled={disabled}
      onClose={() => setListOpen(false)} onToggleFixture={toggleFixture} />
    {requestedMode ? <ConfirmDialog isOpen title="선택 방식 변경" description="현재 선택을 버리고 다른 방식으로 변경할까요?" role="alertdialog"
      confirmLabel="변경" onCancel={() => setRequestedMode(null)} onConfirm={() => changeMode(requestedMode)}>{null}</ConfirmDialog> : null}
  </section>;
}

function SelectionChoices({ kind, dashboard, selection, disabled, fixtureFilter, requiredGatewayId, onChange }: {
  kind: "floor" | "group"; dashboard: Dashboard; selection: ControlSelection; disabled: boolean;
  fixtureFilter: SpatialTargetSelectorProps["fixtureFilter"]; requiredGatewayId: string | null; onChange: (selection: ControlSelection) => void;
}) {
  const items = kind === "floor" ? dashboard.floors : dashboard.groups;
  return <div className="mt-3 grid gap-2" role="group" aria-label={kind === "floor" ? "층 목록" : "저장된 구역 목록"}>
    {items.map((item) => {
      const candidate = kind === "floor" ? { mode: "floor" as const, floorId: item.id } : { mode: "group" as const, groupId: item.id };
      const candidateResolved = selectionWithConstraints(resolveControlSelection(dashboard, candidate), fixtureFilter, requiredGatewayId);
      const eligible = candidateResolved.available;
      const reason = eligible ? null : humanizeDeviceResponseMessage(candidateResolved.unavailableReason ?? "현재 제어할 수 없는 대상입니다.");
      const reasonId = `target-selection-reason-${kind}-${item.id}`;
      return <div key={item.id} className="grid gap-1"><Button type="button" variant="secondary" className="justify-between" disabled={disabled || !eligible}
      aria-describedby={reason ? reasonId : undefined}
      aria-current={(kind === "floor" ? selection.mode === "floor" && selection.floorId === item.id : selection.mode === "group" && selection.groupId === item.id) ? "true" : undefined}
      onClick={() => onChange(candidate)}>{item.name}</Button>{reason ? <Text id={reasonId} role="alert" variant="caption" tone="danger">{reason}</Text> : null}</div>;
    })}
  </div>;
}

function floorForSelection(dashboard: Dashboard, selection: ControlSelection) {
  if (selection.mode === "floor") return selection.floorId;
  if (selection.mode === "group") return dashboard.groups.find((group) => group.id === selection.groupId)?.floorId ?? null;
  return null;
}

function fixtureById(dashboard: Dashboard, fixtureId: string) {
  return dashboard.floors.flatMap((floor) => floor.fixtures).find((fixture) => fixture.id === fixtureId);
}

function hasSelection(selection: ControlSelection) {
  return selection.mode === "fixtures" ? selection.fixtureIds.length > 0 : Boolean(selection.mode === "floor" ? selection.floorId : selection.groupId);
}

function isFixtureEligible(fixture: DashboardFixture, filter: SpatialTargetSelectorProps["fixtureFilter"], requiredGatewayId: string | null, directGatewayId: string | null, selected: boolean) {
  if (selected) return true;
  return fixture.controllable && Boolean(fixture.gateway?.id) && (!filter || filter(fixture))
    && (!requiredGatewayId || fixture.gateway?.id === requiredGatewayId) && (!directGatewayId || fixture.gateway?.id === directGatewayId);
}

function selectionWithConstraints(resolved: ReturnType<typeof resolveControlSelection>, fixtureFilter: SpatialTargetSelectorProps["fixtureFilter"], requiredGatewayId: string | null) {
  if (!resolved.available) return resolved;
  const compatible = resolved.available && resolved.fixtures.every((fixture) => (!fixtureFilter || fixtureFilter(fixture))
    && (!requiredGatewayId || fixture.gateway?.id === requiredGatewayId));
  return compatible ? resolved : { ...resolved, available: false, unavailableReason: "선택 조건과 일치하지 않는 대상이 있습니다." };
}
