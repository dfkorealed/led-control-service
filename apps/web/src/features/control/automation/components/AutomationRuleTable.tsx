import { useRef } from "react";
import { Power, PowerOff } from "lucide-react";
import { Button, DataGrid, RowActions } from "../../../../components/ui";

// One measured container owns both surfaces; automation has no viewport breakpoint.
export const AutomationRuleTable = DataGrid;

export function AutomationRuleActions({ name, enabled, disabled, editDisabled = false, onToggle, onEdit, onDelete }: {
  name: string;
  enabled: boolean;
  disabled: boolean;
  editDisabled?: boolean;
  onToggle(): void;
  onEdit(opener: HTMLButtonElement): void;
  onDelete(opener: HTMLButtonElement): void;
}) {
  const opener = useRef<HTMLButtonElement>(null);
  return <div className="flex flex-wrap justify-center gap-2" data-schedule-row-actions="">
    <Button variant="ghost" className="min-w-11 p-0" type="button" aria-label={`${name} ${enabled ? "비활성화" : "활성화"}`}
      disabled={disabled} onClick={onToggle}>{enabled ? <PowerOff size={16} aria-hidden="true" /> : <Power size={16} aria-hidden="true" />}</Button>
    <RowActions<"edit" | "delete"> ref={opener} rowLabel={name} isDisabled={disabled}
      items={[{ id: "edit", label: "수정", isDisabled: editDisabled }, { id: "delete", label: "삭제" }]}
      onAction={key => {
        if (!opener.current || disabled) return;
        if (key === "edit" && !editDisabled) onEdit(opener.current);
        if (key === "delete") onDelete(opener.current);
      }} />
  </div>;
}
