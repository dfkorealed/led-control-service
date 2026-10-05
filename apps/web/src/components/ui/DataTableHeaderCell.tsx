import type { ReactElement, ThHTMLAttributes } from "react";
import { cn } from "./utils/cn";
import type { DataGridAlign } from "./DataGrid";

export type DataTableHeaderCellProps = ThHTMLAttributes<HTMLTableCellElement> & { align?: DataGridAlign };
const alignments = { left: "text-left", center: "text-center", right: "text-right" };
export function DataTableHeaderCell({ align = "center", className, scope = "col", ...props }: DataTableHeaderCellProps): ReactElement {
  return <th {...props} scope={scope} className={cn("min-w-0 wrap-anywhere whitespace-normal bg-surface-inset px-4 py-3 font-semibold text-content-secondary", alignments[align], className)} />;
}
