import { useState, type ReactNode, type RefObject } from "react";
import type { Dashboard } from "../../../api/queries";
import { Button, SelectBox } from "../../../components/ui";
import type { ControlMode, ControlSelection } from "../control-selection";
import type { MapInteractionMode } from "../../floor-map/map-gestures";
import { Move, MousePointer2, Scan } from "lucide-react";

/** Explicit manual tools remain in map chrome even on narrow screens. */
export function TargetMapTools({ mode, selectionDisabled, onModeChange }: {
  mode: MapInteractionMode;
  selectionDisabled: boolean;
  onModeChange: (mode: MapInteractionMode) => void;
}) {
  const tools = { pan: { label: "이동", icon: Move }, select: { label: "개별 선택", icon: MousePointer2 }, area: { label: "영역 선택", icon: Scan } };
  return <div role="group" aria-label="지도 선택 도구" className="flex flex-wrap gap-1">
    {(["pan", "select", "area"] as const).map(tool => {
      const Icon = tools[tool].icon;
      return <Button key={tool} type="button" variant="secondary" aria-pressed={mode === tool}
        disabled={tool !== "pan" && selectionDisabled} onClick={() => onModeChange(tool)}><Icon size={16} aria-hidden="true" />{tools[tool].label}</Button>;
    })}
  </div>;
}

interface TargetSelectionToolbarProps {
  allowedModes: readonly ControlMode[];
  selection: ControlSelection;
  activeFloorId: string;
  floors: Dashboard["floors"];
  modeLabels?: Partial<Record<ControlMode, string>>;
  modeSelectionSemantics?: "current" | "pressed";
  disabled?: boolean;
  onModeChange: (mode: ControlMode) => void;
  onFloorChange: (floorId: string) => void;
  onOpenList: () => void;
  listOpenerRef?: RefObject<HTMLButtonElement>;
  managementAction?: ReactNode;
  onClear?: () => void;
  compactDisclosure?: boolean;
  presentation?: "embedded" | "manual-workspace";
}

const defaultModeLabels: Record<ControlMode, string> = { fixtures: "개별 조명", floor: "층 전체", group: "저장된 구역" };

export function TargetSelectionToolbar({
  allowedModes, selection, activeFloorId, floors, modeLabels, modeSelectionSemantics = "current", disabled = false,
  onModeChange, onFloorChange, onOpenList, listOpenerRef, managementAction, onClear, compactDisclosure = false, presentation = "embedded"
}: TargetSelectionToolbarProps) {
  const [toolsOpen, setToolsOpen] = useState(false);
  const manual = presentation === "manual-workspace";
  const modes = allowedModes.length > 1 ? <div className={`flex flex-wrap gap-1 ${compactDisclosure && !toolsOpen ? "max-compact:hidden" : ""}`} role="group" aria-label="대상 선택 방식">
      {allowedModes.map((mode) => <Button key={mode} type="button" variant="ghost"
        {...(modeSelectionSemantics === "pressed"
          ? { "aria-pressed": selection.mode === mode }
          : { "aria-current": selection.mode === mode ? "true" : undefined })}
        className={manual && selection.mode === mode ? "border-action-primary bg-action-primary-soft text-action-primary" : undefined}
        disabled={disabled} onClick={() => onModeChange(mode)}>{modeLabels?.[mode] ?? defaultModeLabels[mode]}</Button>)}
      {onClear ? <Button type="button" variant="ghost" disabled={disabled} onClick={onClear}>선택 비우기</Button> : null}
    </div> : null;
  const floor = <SelectBox label={<span className="sr-only">표시 층</span>} className={manual ? "w-full compact:w-48 compact:shrink-0" : undefined}
    items={floors.map((item) => ({ id: item.id, label: item.name }))}
    selectedKey={activeFloorId} isDisabled={disabled || floors.length === 0} onSelectionChange={(floorId) => floorId && onFloorChange(floorId)} />;
  const actions = <>
    <Button ref={listOpenerRef} type="button" variant="secondary" disabled={disabled} onClick={onOpenList}>조명 목록 열기</Button>
    {managementAction}
    {allowedModes.length === 1 && onClear ? <Button type="button" variant="ghost" disabled={disabled} onClick={onClear}>선택 비우기</Button> : null}
  </>;
  // Only the manual workspace changes reading/layout order. Embedded schedule,
  // sensor preparation and group editors keep their existing disclosure policy.
  return <div className={manual ? "flex min-w-0 shrink-0 flex-wrap items-end gap-2" : "grid min-w-0 shrink-0 gap-3"} data-target-selection-toolbar="">
    {manual ? <>{floor}{modes}<div className="flex flex-wrap gap-2 compact:ml-auto">{actions}</div></> : <>{modes}
    <div className={`grid min-w-0 gap-2 ${compactDisclosure ? "max-compact:grid-cols-[minmax(0,1fr)_auto]" : ""} compact:grid-cols-[minmax(0,1fr)_auto_auto_auto]`}>
      {floor}
      {compactDisclosure ? <Button type="button" variant="secondary" className="compact:hidden" aria-expanded={toolsOpen} onClick={() => setToolsOpen(!toolsOpen)}>선택 도구 {toolsOpen ? "접기" : "열기"}</Button> : null}
      <div className={`contents ${compactDisclosure && !toolsOpen ? "max-compact:hidden" : ""}`}>
        {actions}
      </div>
    </div></>}
  </div>;
}
