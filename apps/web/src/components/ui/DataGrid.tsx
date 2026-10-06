import { useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { Card } from "./Card";
import { DataTableShell } from "./DataTableShell";
import { DataTableHeaderCell } from "./DataTableHeaderCell";
import { cn } from "./utils/cn";

export type DataGridAlign = "left" | "center" | "right";
export type DataGridSurface = "table" | "card";
export interface DataGridColumn<T> {
  id: string;
  header: string;
  minWidth: number;
  align?: DataGridAlign;
  renderCell(row: T, surface: DataGridSurface): ReactNode;
}
export interface DataGridProps<T> {
  caption: string;
  rows: readonly T[];
  columns: readonly DataGridColumn<T>[];
  getRowKey(row: T): string | number;
  isBusy?: boolean;
  emptyState?: ReactNode;
  variant?: "default" | "compact";
  className?: string;
}
const alignments = { left: "text-left", center: "text-center", right: "text-right" };

/** Display only. Query, pagination, row actions and filter state stay with callers. */
export function DataGrid<T>({ caption, rows, columns, getRowKey, isBusy = false, emptyState, variant = "default", className }: DataGridProps<T>): ReactElement {
  const container = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    if (!container.current || typeof ResizeObserver === "undefined") return;
    let active = true;
    const observer = new ResizeObserver(entries => {
      const measured = entries.find(entry => entry.target === container.current)?.contentRect.width;
      if (active && measured !== undefined) setWidth(Number.isFinite(measured) ? Math.max(0, measured) : 0);
    });
    observer.observe(container.current);
    return () => { active = false; observer.disconnect(); };
  }, []);
  if (!columns.length || new Set(columns.map(column => column.id)).size !== columns.length || columns.some(column => !Number.isFinite(column.minWidth) || column.minWidth <= 0)) {
    throw new RangeError("DataGrid columns require unique IDs and positive finite minimum widths");
  }
  const minimumWidth = columns.reduce((total, column) => total + column.minWidth, 0);
  const table = width > 0 && width >= minimumWidth;
  const cellClass = cn("min-w-0 wrap-anywhere whitespace-normal", variant === "compact" ? "px-3 py-2" : "px-4 py-3");
  const empty = emptyState ?? (isBusy ? "불러오는 중" : "항목이 없습니다.");
  const rowKey = (row: T) => { const key = getRowKey(row); return `${typeof key}:${key}`; };
  return <Card ref={container} className={cn("min-w-0", className)} aria-busy={isBusy || undefined}>
    {table ? <DataTableShell caption={caption} isBusy={isBusy} layout="fluid" className="rounded-none border-0">
      {/* Percent widths are runtime column geometry, not spacing/design tokens. */}
      <colgroup>{columns.map(column => <col key={column.id} style={{ width: `${column.minWidth / minimumWidth * 100}%` }} />)}</colgroup>
      <thead><tr>{columns.map(column => <DataTableHeaderCell key={column.id} className={variant === "compact" ? "px-3 py-2" : undefined}>{column.header}</DataTableHeaderCell>)}</tr></thead>
      <tbody>{rows.length ? rows.map(row => <tr key={rowKey(row)}>{columns.map(column => <td key={column.id} className={cn(cellClass, "border-t border-border-default", alignments[column.align ?? "left"])}>{column.renderCell(row, "table")}</td>)}</tr>)
        : <tr><td colSpan={columns.length} className={cellClass}>{empty}</td></tr>}</tbody>
    </DataTableShell> : <ul aria-label={caption} className="m-0 grid min-w-0 list-none divide-y divide-border-default p-0">
      {rows.length ? rows.map(row => <li key={rowKey(row)} className={variant === "compact" ? "min-w-0 p-3" : "min-w-0 p-4"}>
        <dl className="m-0 grid min-w-0 gap-3">{columns.map(column => <div key={column.id} className="grid min-w-0 gap-1">
          <dt className="wrap-anywhere text-label font-semibold text-content-secondary">{column.header}</dt>
          <dd className={cn("m-0 min-w-0 wrap-anywhere whitespace-normal text-body-sm", alignments[column.align ?? "left"])}>{column.renderCell(row, "card")}</dd>
        </div>)}</dl>
      </li>) : <li className="min-w-0 p-4">{empty}</li>}
    </ul>}
  </Card>;
}
