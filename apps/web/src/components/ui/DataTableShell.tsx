import type { ReactNode } from "react";
import { Card } from "./Card";
import { cn } from "./utils/cn";

export interface DataTableShellProps {
  caption: ReactNode;
  isBusy?: boolean;
  children: ReactNode;
  className?: string;
}

export function DataTableShell({ caption, isBusy = false, children, className }: DataTableShellProps) {
  return (
    <Card className={cn("min-w-0 overflow-hidden", className)}>
      <div className="min-w-0 overflow-x-auto" aria-busy={isBusy || undefined}>
        <table className="w-full min-w-5xl border-collapse text-body-sm">
          <caption className="sr-only">{caption}</caption>
          {children}
        </table>
      </div>
    </Card>
  );
}
