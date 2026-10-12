import { useState, type ReactNode, type RefObject } from "react";
import type { Dashboard } from "../../../api/queries";
import { List } from "lucide-react";
import { Button, SelectBox } from "../../../components/ui";
import type { ControlMode, ControlSelection } from "../control-selection";

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
  compact?: boolean;
}

const defaultModeLabels: Record<ControlMode, string> = { fixtures: "개별 조명", floor: "층 전체", group: "저장된 구역" };

export function TargetSelectionToolbar({
  allowedModes, selection, activeFloorId, floors, modeLabels, modeSelectionSemantics = "current", disabled = false,
  onModeChange, onFloorChange, onOpenList, listOpenerRef, managementAction, onClear, compactDisclosure = false, presentation = "embedded", compact = false
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
  const floor = <SelectBox label={<span className="sr-only">표시 층</span>} className={manual ? (compact ? "min-w-0 flex-1 gap-0 [&>label]:sr-only" : "min-w-0 flex-1 compact:w-48 compact:flex-none") : undefined}
    items={floors.map((item) => ({ id: item.id, label: item.name }))}
    selectedKey={activeFloorId} isDisabled={disabled || floors.length === 0} onSelectionChange={(floorId) => floorId && onFloorChange(floorId)} />;
  const actions = <>
    <Button ref={listOpenerRef} type="button" variant="secondary" className={compact ? "size-11 min-h-11! shrink-0 p-0" : undefined} aria-label={compact ? "조명 목록" : undefined} disabled={disabled} onClick={onOpenList}>{compact ? <List size={18} aria-hidden="true" /> : manual ? "조명 목록" : "조명 목록 열기"}</Button>
    {managementAction}
    {allowedModes.length === 1 && onClear ? <Button type="button" variant="ghost" disabled={disabled} onClick={onClear}>선택 비우기</Button> : null}
  </>;
  // Only the manual workspace changes reading/layout order. Embedded schedule,
  // sensor preparation and group editors keep their existing disclosure policy.
  return <div className={`grid min-w-0 shrink-0 ${manual ? "gap-2" : "gap-3"}`} data-target-selection-toolbar="">
    {manual ? <><div className="flex min-w-0 items-end gap-1">{floor}
      {compact ? <SelectBox label={<span className="sr-only">선택 범위</span>} className="min-w-0 flex-1 gap-0 [&>label]:sr-only" items={allowedModes.map(mode => ({ id: mode, label: modeLabels?.[mode] ?? defaultModeLabels[mode] }))}
        selectedKey={selection.mode} isDisabled={disabled} onSelectionChange={mode => mode && onModeChange(mode)} /> : null}
      {actions}</div>{!compact ? modes : null}</> : <>{modes}
    <div className={`grid min-w-0 gap-2 ${compactDisclosure ? "max-compact:grid-cols-[minmax(0,1fr)_auto]" : ""} compact:grid-cols-[minmax(0,1fr)_auto_auto_auto]`}>
      {floor}
      {compactDisclosure ? <Button type="button" variant="secondary" className="compact:hidden" aria-expanded={toolsOpen} onClick={() => setToolsOpen(!toolsOpen)}>선택 도구 {toolsOpen ? "접기" : "열기"}</Button> : null}
      <div className={`contents ${compactDisclosure && !toolsOpen ? "max-compact:hidden" : ""}`}>
        {actions}
      </div>
    </div></>}
  </div>;
}
