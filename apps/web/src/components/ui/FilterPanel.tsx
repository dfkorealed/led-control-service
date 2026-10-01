import type { ReactNode } from "react";
import { cn } from "./utils/cn";

export interface FilterPanelProps {
  label: string;
  children: ReactNode;
  chips?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

/** Presentation only: callers retain query, validation and reset policies. */
export function FilterPanel({ label, children, chips, actions, className }: FilterPanelProps) {
  return <section aria-label={label} className={cn("flex min-w-0 flex-col gap-3", className)}>
    <div className="flex min-w-0 flex-wrap items-end gap-3 *:min-w-0 *:max-w-full *:flex-auto">{children}</div>
    {chips != null && <div className="flex min-w-0 flex-wrap gap-2 break-all *:min-w-0 *:max-w-full">{chips}</div>}
    {actions != null && <div className="flex min-w-0 flex-wrap items-center gap-2 *:min-w-0 *:max-w-full">{actions}</div>}
  </section>;
}
