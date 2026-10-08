import { useRef } from "react";
import { Power, PowerOff } from "lucide-react";
import { Button, DataGrid, RowActions } from "../../../../components/ui";

// One measured container owns both surfaces; automation has no viewport breakpoint.
export const AutomationRuleTable = DataGrid;

export function AutomationRuleActions({ name, enabled, disabled, toggleDisabled = false, editDisabled = false, touchClassName = "", onToggle, onEdit, onDelete }: {
  name: string;
  enabled: boolean;
  disabled: boolean;
  toggleDisabled?: boolean;
  editDisabled?: boolean;
  touchClassName?: string;
  onToggle(): void;
  onEdit(opener: HTMLButtonElement): void;
  onDelete(opener: HTMLButtonElement): void;
}) {
  const opener = useRef<HTMLButtonElement>(null);
  // BIO callers retain their prior larger compact targets because a rounded
  // 44px icon lacks a complete 44×44 touch area. Other callers keep their sizes.
  return <div className="flex flex-wrap justify-center gap-2" data-schedule-row-actions="">
    <Button variant="ghost" className={`min-w-11 p-0 ${touchClassName}`} type="button" aria-label={`${name} ${enabled ? "비활성화" : "활성화"}`}
      disabled={disabled || toggleDisabled} onClick={onToggle}>{enabled ? <PowerOff size={16} aria-hidden="true" /> : <Power size={16} aria-hidden="true" />}</Button>
    <RowActions<"edit" | "delete"> ref={opener} rowLabel={name} isDisabled={disabled} className={touchClassName}
      items={[{ id: "edit", label: "수정", isDisabled: editDisabled }, { id: "delete", label: "삭제" }]}
      onAction={key => {
        if (!opener.current || disabled) return;
        if (key === "edit" && !editDisabled) onEdit(opener.current);
        if (key === "delete") onDelete(opener.current);
      }} />
  </div>;
}
