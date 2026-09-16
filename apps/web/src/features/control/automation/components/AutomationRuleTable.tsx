import type { ReactNode } from "react";

export const automationTableHeadingClassName = "border-b border-border-default bg-action-primary-soft p-3 text-left align-middle text-overline font-black whitespace-nowrap text-content-muted";

const automationTableCellBaseClassName = "h-14 p-3 text-left align-middle text-caption whitespace-nowrap";

export function automationTableCellClassName(isLastRow: boolean, className = "") {
  return `${automationTableCellBaseClassName} ${isLastRow ? "border-b-0" : "border-b border-border-default"} ${className}`.trim();
}

export function AutomationRuleTable({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 overflow-x-auto overscroll-x-contain rounded-panel border border-border-default bg-surface-panel" data-automation-table-wrap="">
      <table className="w-full min-w-296 border-collapse text-caption" aria-label={label}>
        {children}
      </table>
    </div>
  );
}
