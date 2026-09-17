import type { Dashboard } from "../../../api/queries";
import { Button, SelectBox } from "../../../components/ui";
import type { ControlMode, ControlSelection } from "../control-selection";
import type { MapInteractionMode } from "../../floor-map/FloorMapViewport";

interface TargetSelectionToolbarProps {
  allowedModes: readonly ControlMode[];
  selection: ControlSelection;
  activeFloorId: string;
  floors: Dashboard["floors"];
  interactionMode: MapInteractionMode;
  modeLabels?: Partial<Record<ControlMode, string>>;
  modeSelectionSemantics?: "current" | "pressed";
  disabled?: boolean;
  onModeChange: (mode: ControlMode) => void;
  onFloorChange: (floorId: string) => void;
  onInteractionModeChange?: (mode: MapInteractionMode) => void;
  onOpenList: () => void;
  onClear?: () => void;
}

const defaultModeLabels: Record<ControlMode, string> = { fixtures: "개별 조명", floor: "층 전체", group: "저장된 구역" };

export function TargetSelectionToolbar({
  allowedModes, selection, activeFloorId, floors, interactionMode, modeLabels, modeSelectionSemantics = "current", disabled = false,
  onModeChange, onFloorChange, onInteractionModeChange, onOpenList, onClear
}: TargetSelectionToolbarProps) {
  return <div className="grid min-w-0 shrink-0 gap-3" data-target-selection-toolbar="">
    {allowedModes.length > 1 ? <div className="flex flex-wrap gap-2" role="group" aria-label="대상 선택 방식">
      {allowedModes.map((mode) => <Button key={mode} type="button" variant="ghost"
        {...(modeSelectionSemantics === "pressed"
          ? { "aria-pressed": selection.mode === mode }
          : { "aria-current": selection.mode === mode ? "true" : undefined })}
        disabled={disabled} onClick={() => onModeChange(mode)}>{modeLabels?.[mode] ?? defaultModeLabels[mode]}</Button>)}
      {onClear ? <Button type="button" variant="ghost" disabled={disabled} onClick={onClear}>선택 비우기</Button> : null}
    </div> : null}
    <div className="grid min-w-0 gap-2 compact:grid-cols-[minmax(0,1fr)_auto_auto]">
      <SelectBox label={<span className="sr-only">표시 층</span>} items={floors.map((floor) => ({ id: floor.id, label: floor.name }))}
        selectedKey={activeFloorId} isDisabled={disabled || floors.length === 0} onSelectionChange={(floorId) => floorId && onFloorChange(floorId)} />
      <Button type="button" variant="secondary" disabled={disabled} onClick={onOpenList}>조명 목록 열기</Button>
      {onInteractionModeChange ? <div className="flex flex-wrap gap-1" role="group" aria-label="지도 조작">
        {(["pan", "select", "area"] as const).map((mode) => <Button key={mode} type="button" variant="ghost" className="min-w-11 px-2 max-compact:min-w-14 max-compact:min-h-14"
          aria-label={mode === "pan" ? "지도 이동" : mode === "select" ? "조명 선택" : "영역 선택"} aria-current={interactionMode === mode ? "true" : undefined}
          disabled={disabled} onClick={() => onInteractionModeChange(mode)}>{mode === "pan" ? "이동" : mode === "select" ? "선택" : "영역"}</Button>)}
        {allowedModes.length === 1 && onClear ? <Button type="button" variant="ghost" disabled={disabled} onClick={onClear}>선택 비우기</Button> : null}
      </div> : null}
    </div>
  </div>;
}
