import type { ReactNode } from "react";
import { cn } from "./utils/cn";

export interface LogViewProps {
  label: string;
  filters: ReactNode;
  pagination: ReactNode;
  status: ReactNode;
  children: ReactNode;
  className?: string;
}

/** Parents must provide finite height and min-h-0 through every flex boundary. */
export function LogView({ label, filters, pagination, status, children, className }: LogViewProps) {
  return <section aria-label={label} className={cn("flex h-full min-h-0 min-w-0 flex-col gap-3 overflow-hidden", className)}>
    <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-hidden">
      {/* Limit filters/status to half the space remaining after the footer.
          Both scroll regions are focusable, including a long noninteractive error. */}
      <header role="region" aria-label={`${label} 필터·상태`} tabIndex={0} className="flex max-h-1/2 min-h-0 shrink flex-col gap-3 overflow-y-auto break-words">
        {filters}
        {status}
      </header>
      <div role="region" aria-label={`${label} 본문`} tabIndex={0} className="min-h-0 min-w-0 flex-1 overflow-y-auto break-words">{children}</div>
    </div>
    <footer className="min-w-0 shrink-0">{pagination}</footer>
  </section>;
}
