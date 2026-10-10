import type { ReactNode } from "react";
import { cn } from "../utils/cn";

export interface OperationMapPanelProps {
  title?: ReactNode;
  status?: ReactNode;
  tools?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Owns chrome only; callers retain renderer, data, selection and camera lifetime. */
export function OperationMapPanel({ title, status, tools, children, className }: OperationMapPanelProps) {
  return <div data-operation-map-panel="" className={cn("flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-panel border border-border-default bg-surface-inset", className)}>
    {title != null || status != null || tools != null ? <div data-operation-map-chrome="" className="flex min-w-0 shrink-0 flex-wrap items-center justify-between gap-2 border-b border-border-default bg-surface-panel px-4 py-3 max-compact:px-3">
      {title != null || tools != null ? <div className="flex min-w-0 flex-wrap items-center gap-2">{title}{tools}</div> : null}
      {status != null ? <div className="ml-auto min-w-0">{status}</div> : null}
    </div> : null}
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col">{children}</div>
  </div>;
}
