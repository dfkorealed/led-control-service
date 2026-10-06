import type { ReactNode } from "react";
import { Card } from "./Card";
import { cn } from "./utils/cn";

export interface DataTableShellProps {
  caption: ReactNode;
  isBusy?: boolean;
  children: ReactNode;
  className?: string;
  layout?: "legacy" | "fluid";
}

export function DataTableShell({ caption, isBusy = false, children, className, layout = "legacy" }: DataTableShellProps) {
  return (
    <Card className={cn("min-w-0", layout === "legacy" && "overflow-hidden", className)}>
      <div className={cn("min-w-0", layout === "legacy" && "overflow-x-auto")} aria-busy={isBusy || undefined}>
        <table className={cn("w-full border-collapse text-body-sm", layout === "legacy" ? "min-w-5xl" : "table-fixed")}>
          <caption className="sr-only">{caption}</caption>
          {children}
        </table>
      </div>
    </Card>
  );
}
