import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Dashboard, DashboardFixture } from "../../../api/queries";
import { useFloorMapSnapshot } from "../../../api/queries";
import { Button, ConfirmDialog, InlineStatusSummary, OperationMapPanel, Text } from "../../../components/ui";
import { FloorScene } from "../../floor-map/FloorScene";
import { FloorMapViewport, type MapSelectionRect } from "../../floor-map/FloorMapViewport";
import { resolveControlSelection, toggleFixtureSelection, type ControlMode, type ControlSelection } from "../control-selection";
import { humanizeDeviceResponseMessage } from "../control-copy";
import { FixtureSelectionDrawer } from "./FixtureSelectionDrawer";
import { SelectionSummaryPanel } from "./SelectionSummaryPanel";
import { TargetMapTools, TargetSelectionToolbar } from "./TargetSelectionToolbar";

export interface SpatialTargetSelectorProps {
  siteId: string;
  dashboard: Dashboard;
  selection: ControlSelection;
  /** Renders an immutable selection while retaining `selection` as authoring metadata. */
  displaySelection?: ControlSelection;
  disabled: boolean;
  presentation?: "embedded" | "manual-workspace";
  allowedModes?: readonly ControlMode[];
  fixtureFilter?: (fixture: DashboardFixture) => boolean;
  fixtureFilterReason?: string;
  fixtureBlockedReason?: (fixture: DashboardFixture) => string;
  onInspectFixture?: (fixtureId: string) => void;
  inspectionPanel?: ReactNode;
  /** A new boundary resets the displayed floor; users may still inspect other floors. */
  preferredFloorId?: string;
  requiredGatewayId?: string | null;
  modeLabels?: Partial<Record<ControlMode, string>>;
  modeSelectionSemantics?: "current" | "pressed";
  compactSummary?: ReactNode;
  compactDetails?: ReactNode;
  managementAction?: ReactNode;
  hideEmbeddedSummary?: boolean;
  onCompactSheetHeightChange?: (height: number) => void;
  onChange: (selection: ControlSelection) => void;
}

const defaultModes: readonly ControlMode[] = ["fixtures", "floor", "group"];
export const spatialTargetDialogClassName = "grid! h-full! w-full! max-w-6xl grid-rows-[auto_minmax(0,1fr)] overflow-hidden! max-compact:max-h-full!";

export function SpatialTargetSelector({
  siteId, dashboard, selection, displaySelection, disabled, allowedModes = defaultModes, fixtureFilter, fixtureFilterReason, fixtureBlockedReason, onInspectFixture, inspectionPanel, preferredFloorId, requiredGatewayId = null, modeLabels, modeSelectionSemantics,
  compactSummary, compactDetails, managementAction, hideEmbeddedSummary = false, presentation = "embedded", onCompactSheetHeightChange, onChange
}: SpatialTargetSelectorProps) {
  const resolvedSelection = displaySelection ?? selection;
  const selectionFloorId = floorForSelection(dashboard, selection);
  const validSelectionFloorId = dashboard.floors.some((floor) => floor.id === selectionFloorId) ? selectionFloorId : null;
  const [activeFloorId, setActiveFloorId] = useState(() => preferredFloorId || validSelectionFloorId || dashboard.floors[0]?.id || "");
  const [listOpen, setListOpen] = useState(false);
  const listOpenerRef = useRef<HTMLButtonElement>(null);
  const [requestedMode, setRequestedMode] = useState<ControlMode | null>(null);
  const [tool, setTool] = useState<"pan" | "select" | "area">("select");
  const manualWorkspace = presentation === "manual-workspace";
  const selectionDisabled = disabled || selection.mode !== "fixtures";
  const activeTool = selectionDisabled ? "pan" : tool;
  const activeFloor = dashboard.floors.find((floor) => floor.id === activeFloorId) ?? dashboard.floors[0];
  const mapQuery = useFloorMapSnapshot(activeFloor?.id, siteId);
  const resolved = useMemo(() => selectionWithConstraints(resolveControlSelection(dashboard, resolvedSelection), fixtureFilter, requiredGatewayId), [dashboard, fixtureFilter, requiredGatewayId, resolvedSelection]);
  const selectedFixtureIds = useMemo(() => new Set(resolved.fixtureIds), [resolved.fixtureIds]);
  const directGatewayId = useMemo(() => {
    if (selection.mode !== "fixtures" || selection.fixtureIds.length === 0) return null;
    return fixtureById(dashboard, selection.fixtureIds[0])?.gateway?.id ?? null;
  }, [dashboard, selection]);
  const disabledReasons = useMemo(() => new Map(dashboard.floors.flatMap((floor) => floor.fixtures).flatMap((fixture) => {
    const reason = disabled ? "현재 선택을 변경할 수 없습니다."
      : selection.mode !== "fixtures" ? "구성원을 변경하려면 직접 선택으로 전환하세요."
      : selectedFixtureIds.has(fixture.id) ? null
      : fixtureEligibilityReason(fixture, fixtureFilter, requiredGatewayId, directGatewayId, fixtureBlockedReason?.(fixture) ?? fixtureFilterReason);
    return reason ? [[fixture.id, reason] as const] : [];
  })), [dashboard.floors, directGatewayId, disabled, fixtureFilter, fixtureFilterReason, fixtureBlockedReason, requiredGatewayId, selectedFixtureIds, selection.mode]);
  const disabledFixtureIds = useMemo(() => new Set(disabledReasons.keys()), [disabledReasons]);

  useEffect(() => { if (preferredFloorId) setActiveFloorId(preferredFloorId); }, [preferredFloorId]);

  useEffect(() => {
    const activeFloorStillExists = dashboard.floors.some((floor) => floor.id === activeFloorId);
    const reconciledFloorId = validSelectionFloorId ?? (activeFloorStillExists ? activeFloorId : dashboard.floors[0]?.id ?? "");
    if (reconciledFloorId !== activeFloorId) setActiveFloorId(reconciledFloorId);
  }, [activeFloorId, dashboard.floors, validSelectionFloorId]);
  useEffect(() => {
    if (!mapQuery.data && !mapQuery.isLoading && mapQuery.error) setListOpen(true);
  }, [mapQuery.data, mapQuery.error, mapQuery.isLoading]);

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
    onInspectFixture?.(fixtureId);
    const fixture = fixtureById(dashboard, fixtureId);
    const selected = selectedFixtureIds.has(fixtureId);
    if (!selected && (!fixture || !isFixtureEligible(fixture, fixtureFilter, requiredGatewayId, directGatewayId, false))) return;
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

  const sceneSelection = useMemo(() => ({ kind: "multiple" as const, selectedFixtureIds, disabledFixtureIds, disabledReasons }), [disabledFixtureIds, disabledReasons, selectedFixtureIds]);
  const group = selection.mode === "group" ? dashboard.groups.find((item) => item.id === selection.groupId) : undefined;

  return <section className={`flex ${hideEmbeddedSummary ? "min-h-min" : "min-h-0"} min-w-0 flex-1 flex-col gap-3 overflow-hidden ${hideEmbeddedSummary ? "max-compact:flex-none max-compact:overflow-visible" : ""}`} aria-label="공간 대상 선택" data-spatial-target-selector="">
    <TargetSelectionToolbar allowedModes={allowedModes} selection={selection} activeFloorId={activeFloor?.id ?? ""} floors={dashboard.floors} modeLabels={modeLabels}
      compactDisclosure={hideEmbeddedSummary && !manualWorkspace} modeSelectionSemantics={modeSelectionSemantics}
      disabled={disabled} onModeChange={requestModeChange} onFloorChange={setActiveFloorId}
      onOpenList={() => setListOpen(true)} listOpenerRef={listOpenerRef} managementAction={managementAction}
      onClear={selection.mode === "fixtures" && selection.fixtureIds.length > 0 ? () => onChange({ mode: "fixtures", fixtureIds: [] }) : undefined} />
    {hideEmbeddedSummary ? <Text className="compact:hidden" variant="caption">{resolved.fixtureIds.length}개 선택 · {selection.mode === "fixtures" ? "개별 조명" : selection.mode === "floor" ? "층 전체" : "저장된 구역"}</Text> : null}
    {/* Manual desktop's outer workspace owns short-window scrolling. Let chrome
        wheels chain to it; embedded/mobile panes retain their containment. */}
    <div className={`grid ${hideEmbeddedSummary ? "min-h-min" : "min-h-0"} min-w-0 flex-1 gap-3 overflow-y-auto overscroll-contain ${manualWorkspace ? "compact:overscroll-auto" : ""} ${hideEmbeddedSummary ? "max-compact:flex-none max-compact:overflow-visible" : ""} ${hideEmbeddedSummary && selection.mode === "fixtures" ? "tablet:overflow-hidden" : "tablet:grid-cols-[minmax(0,1fr)_16rem] tablet:overflow-hidden"}`} data-target-selection-content="">
      {/* The transparent coarse hit box stays rectangular; the shared inner
          20px marker dot retains its circular appearance. Rounded hit boxes
          lose their corners and cannot provide the required 48×48 target. */}
      {/* Footer controls preserve the actual 240px map minimum. The legend has
          its own flow row so neither can cover the other on short screens. */}
      <OperationMapPanel className="[&_[data-spatial-map-marker]]:rounded-none! min-h-min"
        status={manualWorkspace ? <InlineStatusSummary label={`${activeFloor?.name ?? "현재"} 도면 조명 상태`} items={[
          { id: "total", label: "전체", value: activeFloor?.summary?.totalFixtures ?? null, tone: "neutral" },
          { id: "online", label: "정상", value: activeFloor?.summary?.onlineFixtures ?? null, tone: "success" },
          { id: "fault", label: "장애", value: activeFloor?.summary?.faultFixtures ?? null, tone: "danger" },
          { id: "offline", label: "오프라인", value: activeFloor?.summary?.offlineFixtures ?? null, tone: "warning" }
        ]} /> : undefined}
        tools={manualWorkspace ? <TargetMapTools mode={activeTool} selectionDisabled={selectionDisabled} onModeChange={setTool} /> : undefined}>
        {mapQuery.data && activeFloor ? <div className="min-h-min min-w-0 flex-1"><FloorMapViewport snapshot={mapQuery.data} ariaLabel={`${activeFloor.name} 도면`} interactionPolicy={selection.mode === "fixtures" && !disabled ? "direct-selection" : "pan"}
          mode={manualWorkspace ? activeTool : "pan"} toolModePolicy={manualWorkspace ? "explicit" : "interaction-default"}
          onAreaSelect={selectArea} wheelZoomWithoutModifier controlsPlacement="footer" maintainCameraOnResize viewportTestId="target-selection-map-viewport">
          <FloorScene snapshot={mapQuery.data} fixtures={activeFloor.fixtures} interactive={false} floorName={activeFloor.name} selection={sceneSelection} coarsePointer onFixturePress={toggleFixture} inspectDisabledFixtures={Boolean(onInspectFixture) && !disabled} />
        </FloorMapViewport></div> : <div className="grid h-full place-items-center p-4"><Text tone="secondary">등록된 도면이 없어 목록으로 선택합니다.</Text></div>}
        {mapQuery.data && mapQuery.error ? <Text className="absolute top-3 left-3 z-6 rounded-control border border-border-default bg-surface-panel px-2 py-1" role="alert" tone="danger">도면을 최신 상태로 갱신하지 못했습니다.</Text> : null}
        {group ? <Text className="pointer-events-none absolute top-3 right-3 z-6 rounded-control border border-border-default bg-surface-panel px-2 py-1" variant="caption">{group.name}</Text> : null}
        {mapQuery.data ? <div className="pointer-events-none flex shrink-0 flex-wrap gap-2 border-t border-border-default bg-surface-panel px-2 py-1 text-label" aria-label="지도 조명 상태 범례">
          <span className="inline-flex items-center gap-1"><span aria-hidden="true" className="size-2 rounded-fixture-marker bg-fixture-connected" />정상</span>
          <span className="inline-flex items-center gap-1"><span aria-hidden="true" className="size-2 rounded-fixture-marker bg-fixture-fault" />장애</span>
          <span className="inline-flex items-center gap-1"><span aria-hidden="true" className="size-2 rounded-fixture-marker bg-fixture-offline" />오프라인</span>
          <span className="inline-flex items-center gap-1"><span aria-hidden="true" className="size-2 rounded-fixture-marker bg-fixture-selected" />선택</span>
        </div> : null}
      </OperationMapPanel>
      {/* On desktop, long choice lists must scroll within the map row rather
          than contribute their intrinsic height to that auto-sized grid row.
          Compact inspection must reserve its intrinsic height: a zero-height
          second grid row lets preparation buttons sit behind the map. The
          outer content scrolls both map and inspection on those screens. */}
      <div className={hideEmbeddedSummary && selection.mode === "fixtures" ? "hidden" : `min-h-0 overflow-y-auto overscroll-contain tablet:[contain:size] ${inspectionPanel ? "max-tablet:min-h-min max-tablet:overflow-visible" : ""}`} data-target-selection-detail-panel="">{!hideEmbeddedSummary ? <SelectionSummaryPanel resolved={resolved} compactSummary={compactSummary} compactDetails={compactDetails} onCompactSheetHeightChange={onCompactSheetHeightChange} /> : null}
        {inspectionPanel}
        {selection.mode === "floor" ? <SelectionChoices kind="floor" dashboard={dashboard} selection={selection} disabled={disabled} fixtureFilter={fixtureFilter} requiredGatewayId={requiredGatewayId} onChange={onChange} /> : null}
        {selection.mode === "group" ? <SelectionChoices kind="group" dashboard={dashboard} selection={selection} disabled={disabled} fixtureFilter={fixtureFilter} requiredGatewayId={requiredGatewayId} onChange={onChange} /> : null}
      </div>
    </div>
    <FixtureSelectionDrawer open={listOpen} dashboard={dashboard} selectedFixtureIds={selectedFixtureIds} disabledFixtureIds={disabledFixtureIds} disabledReasons={disabledReasons} readOnly={selection.mode !== "fixtures"} disabled={disabled} returnFocusRef={listOpenerRef}
      onClose={() => setListOpen(false)} onToggleFixture={toggleFixture} onInspectFixture={onInspectFixture ? fixtureId => { onInspectFixture(fixtureId); setListOpen(false); } : undefined} />
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
      onClick={() => onChange(candidate)}>{item.name}</Button>{reason ? <Text id={reasonId} variant="caption" tone="danger">{reason}</Text> : null}</div>;
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
  return fixtureEligibilityReason(fixture, filter, requiredGatewayId, directGatewayId) === null;
}

function fixtureEligibilityReason(fixture: DashboardFixture, filter: SpatialTargetSelectorProps["fixtureFilter"], requiredGatewayId: string | null, directGatewayId: string | null, filterReason = "선택 조건과 일치하지 않는 조명입니다.") {
  if (!fixture.gateway?.id || fixture.controlBlockReason === "fixture_unmapped") return "게이트웨이에 매핑되지 않았습니다.";
  if (!fixture.controllable) {
    if (fixture.controlBlockReason === "gateway_offline") return "게이트웨이가 오프라인입니다.";
    if (fixture.controlBlockReason === "fixture_fault") return "조명 장애를 먼저 점검해야 합니다.";
    return "조명이 오프라인이거나 현재 제어할 수 없습니다.";
  }
  if (filter && !filter(fixture)) return filterReason;
  if ((requiredGatewayId && fixture.gateway.id !== requiredGatewayId) || (directGatewayId && fixture.gateway.id !== directGatewayId)) return "선택한 대상과 같은 게이트웨이의 조명만 선택할 수 있습니다.";
  return null;
}

function selectionWithConstraints(resolved: ReturnType<typeof resolveControlSelection>, fixtureFilter: SpatialTargetSelectorProps["fixtureFilter"], requiredGatewayId: string | null) {
  if (!resolved.available) return resolved;
  const compatible = resolved.available && resolved.fixtures.every((fixture) => (!fixtureFilter || fixtureFilter(fixture))
    && (!requiredGatewayId || fixture.gateway?.id === requiredGatewayId));
  return compatible ? resolved : { ...resolved, available: false, unavailableReason: "선택 조건과 일치하지 않는 대상이 있습니다." };
}
