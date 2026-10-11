import { useRef, useState, type ReactNode } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Button as AriaButton, DialogTrigger } from "react-aria-components";
import { Button } from "./Button";
import { Popover } from "./overlays/Popover";
import { cn } from "./utils/cn";

export interface FilterPanelProps {
  label: string;
  children: ReactNode;
  chips?: ReactNode;
  actions?: ReactNode;
  className?: string;
  mode?: "inline" | "popover";
  variant?: "default" | "compact";
  search?: ReactNode;
  activeFilterCount?: number;
  triggerLabel?: string;
  summary?: ReactNode;
  filterReset?: ReactNode;
  isOpen?: boolean;
  onOpenChange?(open: boolean): void;
  isDisabled?: boolean;
  isDismissDisabled?: boolean;
}

/** Presentation only: callers retain query, validation and reset policies. */
export function FilterPanel({ label, children, chips, actions, className, mode = "inline", variant = "default", search, activeFilterCount = 0, triggerLabel = "필터",
  summary, filterReset, isOpen, onOpenChange, isDisabled = false, isDismissDisabled = false }: FilterPanelProps) {
  const trigger = useRef<HTMLButtonElement>(null);
  const [localOpen, setLocalOpen] = useState(false);
  const open = isOpen ?? localOpen;
  const changeOpen = (next: boolean) => {
    if ((next && isDisabled) || (!next && isDismissDisabled)) return;
    if (isOpen === undefined) setLocalOpen(next);
    onOpenChange?.(next);
  };
  const conditions = summary ?? chips;
  if (mode === "popover") return <section aria-label={label} className={cn("flex min-w-0 flex-col gap-3", variant === "compact" && "gap-2", className)}>
    <div className="flex min-w-0 flex-wrap items-end gap-2">
      {search != null && <div className="min-w-0 max-w-full flex-1">{search}</div>}
      <DialogTrigger isOpen={open} onOpenChange={changeOpen}>
        <AriaButton ref={trigger} isDisabled={isDisabled} aria-label={`${label} 상세 필터, 활성 조건 ${activeFilterCount}개`}
          // Rounded corners need extra width to retain a continuous 44×44 pointer area.
          className="inline-flex min-h-11 min-w-16 shrink-0 items-center justify-center gap-1 rounded-control border border-border-default bg-surface-panel px-2 text-content-primary outline-none data-focus-visible:shadow-focus data-disabled:opacity-60">
          <SlidersHorizontal size={18} aria-hidden="true" /><span aria-hidden="true">{triggerLabel}</span>
          {activeFilterCount > 0 ? <span aria-hidden="true" className="rounded-pill bg-action-primary-soft px-1.5 text-label text-action-primary">{activeFilterCount}</span> : null}
        </AriaButton>
        <Popover label={label} triggerRef={trigger} placement="bottom end" mobilePresentation="bottom-sheet" className="w-96 min-w-0" isKeyboardDismissDisabled={isDismissDisabled}
          shouldCloseOnInteractOutside={() => !isDismissDisabled}>
          <div className={cn("grid min-w-0 gap-4 *:min-w-0 *:max-w-full", variant === "compact" && "gap-3")}>
            {children}
            <div className="flex min-w-0 flex-wrap items-center justify-end gap-2 *:min-w-0 *:max-w-full">
              {filterReset}
              <Button type="button" size="sm" disabled={isDismissDisabled} onClick={() => changeOpen(false)}>필터 닫기</Button>
            </div>
          </div>
        </Popover>
      </DialogTrigger>
    </div>
    {conditions != null && <div className="flex min-w-0 flex-wrap gap-2 break-words *:min-w-0 *:max-w-full">{conditions}</div>}
    {/* Render reset in only one place so caller IDs/refs are never duplicated. */}
    {(!open && filterReset != null || actions != null) && <div className="flex min-w-0 flex-wrap items-center gap-2 *:min-w-0 *:max-w-full">{!open && filterReset}{actions}</div>}
  </section>;
  return <section aria-label={label} className={cn("flex min-w-0 flex-col gap-3", variant === "compact" && "gap-2", className)}>
    <div className={cn("flex min-w-0 flex-wrap items-end gap-3 *:min-w-0 *:max-w-full *:flex-auto", variant === "compact" && "gap-2")}>{search}{children}</div>
    {conditions != null && <div className="flex min-w-0 flex-wrap gap-2 break-all *:min-w-0 *:max-w-full">{conditions}</div>}
    {(actions != null || filterReset != null) && <div className="flex min-w-0 flex-wrap items-center gap-2 *:min-w-0 *:max-w-full">{filterReset}{actions}</div>}
  </section>;
}
