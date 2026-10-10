import { useContext, useEffect, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react";
import { Button } from "./Button";
import { SelectBox } from "./fields/SelectBox";
import { Card } from "./Card";
import { DataTableShell } from "./DataTableShell";
import { DataTableHeaderCell } from "./DataTableHeaderCell";
import { cn } from "./utils/cn";
import { CustomerThemeContext } from "./theme/CustomerThemeProvider";

export type DataGridAlign = "left" | "center" | "right";
export type DataGridSurface = "table" | "card";
export interface DataGridColumn<T> {
  id: string;
  header: string;
  minWidth: number;
  align?: DataGridAlign;
  sortValue?(row: T): string | number | boolean | Date | null | undefined;
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
type Sort = { columnId: string; direction: "ascending" | "descending" };
const collator = new Intl.Collator("ko", { numeric: true, sensitivity: "base" });
function comparable(value: string | number | boolean | Date | null | undefined): string | number | null {
  const normalized = value instanceof Date ? value.getTime() : typeof value === "boolean" ? Number(value) : value;
  // Invalid instants/nonfinite API numbers represent missing values, not sortable data.
  return normalized == null || (typeof normalized === "number" && !Number.isFinite(normalized)) ? null : normalized;
}
function sortedRows<T>(rows: readonly T[], accessor: NonNullable<DataGridColumn<T>["sortValue"]>, direction: Sort["direction"]): T[] {
  return rows.map((row, index) => ({ row, index, value: comparable(accessor(row)) })).sort((a, b) => {
    // Missing values stay last before applying direction; input index preserves equal-value order.
    if (a.value === null || b.value === null) return a.value === b.value ? a.index - b.index : a.value === null ? 1 : -1;
    const difference = typeof a.value === "number" && typeof b.value === "number"
      ? a.value - b.value : collator.compare(String(a.value), String(b.value));
    return (direction === "ascending" ? difference : -difference) || a.index - b.index;
  }).map(item => item.row);
}

/** Sorting covers supplied rows only. Query, pagination, row actions and filters stay with callers. */
export function DataGrid<T>({ caption, rows, columns, getRowKey, isBusy = false, emptyState, variant = "default", className }: DataGridProps<T>): ReactElement {
  const customerTheme = useContext(CustomerThemeContext);
  const container = useRef<HTMLElement>(null);
  const [width, setWidth] = useState(0);
  const [sort, setSort] = useState<Sort | null>(null);
  const sortColumn = columns.find(column => column.id === sort?.columnId && column.sortValue);
  useEffect(() => { if (sort && !sortColumn) setSort(null); }, [sort, sortColumn]);
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
  const compactCards = variant === "compact" && !table;
  const customerCards = Boolean(customerTheme) && compactCards;
  const cellClass = cn("min-w-0 wrap-anywhere whitespace-normal", variant === "compact" ? "px-3 py-2" : "px-4 py-3");
  const empty = emptyState ?? (isBusy ? "불러오는 중" : "항목이 없습니다.");
  const rowKey = (row: T) => { const key = getRowKey(row); return `${typeof key}:${key}`; };
  const displayedRows = sort && sortColumn?.sortValue ? sortedRows(rows, sortColumn.sortValue, sort.direction) : rows;
  const sortableColumns = columns.filter(column => column.sortValue);
  const toggleSort = (columnId: string) => setSort(current => ({ columnId, direction: current?.columnId === columnId && current.direction === "ascending" ? "descending" : "ascending" }));
  return <Card ref={container} className={cn("min-w-0", customerCards && "border-0 bg-transparent", className)} aria-busy={isBusy || undefined}>
    {sortableColumns.length ? <div className={cn("grid min-w-0 gap-2 border-b border-border-default", compactCards ? "p-2" : "p-3")}>
      {/* Compact cards keep the same controls in one row so their first action remains reachable. */}
      <p className={cn("m-0 text-caption text-content-secondary", compactCards && "sr-only")}>현재 목록 안에서 정렬</p>
      {!table ? <div className="flex min-w-0 flex-wrap items-end gap-2">
        <SelectBox label={compactCards ? undefined : "정렬 기준"} aria-label={compactCards ? "정렬 기준 · 현재 목록 안에서 정렬" : undefined} className="min-w-0 flex-1" placeholder="기본 순서" selectedKey={sortColumn?.id ?? null}
          items={sortableColumns.map(column => ({ id: column.id, label: column.header }))}
          onSelectionChange={columnId => setSort(columnId === null ? null : { columnId, direction: "ascending" })} />
        <Button type="button" size="sm" disabled={!sortColumn} aria-label={sort?.direction === "ascending" ? "내림차순으로 변경" : "오름차순으로 변경"}
          onClick={() => { if (sortColumn) toggleSort(sortColumn.id); }}>
          {sort?.direction === "descending" ? <ArrowDown size={16} aria-hidden="true" /> : <ArrowUp size={16} aria-hidden="true" />}
          {sort?.direction === "descending" ? "내림차순" : "오름차순"}
        </Button>
      </div> : null}
    </div> : null}
    {table ? <DataTableShell caption={caption} isBusy={isBusy} layout="fluid" className="rounded-none border-0">
      {/* Percent widths are runtime column geometry, not spacing/design tokens. */}
      <colgroup>{columns.map(column => <col key={column.id} style={{ width: `${column.minWidth / minimumWidth * 100}%` }} />)}</colgroup>
      <thead><tr>{columns.map(column => <DataTableHeaderCell key={column.id} aria-sort={sortColumn?.id === column.id ? sort?.direction : undefined} className={variant === "compact" ? "px-3 py-2" : undefined}>
        {/* Content-width headers need square corners to retain a continuous44px hit area at44px height. */}
        {column.sortValue ? <Button type="button" variant="ghost" size="sm" className="rounded-none min-w-11 max-w-full border-transparent bg-transparent px-0 font-semibold text-content-secondary whitespace-normal"
          aria-label={`${column.header} ${sortColumn?.id === column.id && sort?.direction === "ascending" ? "내림차순" : "오름차순"} 정렬`} onClick={() => toggleSort(column.id)}>
          <span className="min-w-0 wrap-anywhere">{column.header}</span>
          {sortColumn?.id === column.id ? sort?.direction === "ascending" ? <ArrowUp size={16} className="shrink-0" aria-hidden="true" /> : <ArrowDown size={16} className="shrink-0" aria-hidden="true" /> : <ArrowUpDown size={16} className="shrink-0" aria-hidden="true" />}
        </Button> : column.header}
      </DataTableHeaderCell>)}</tr></thead>
      <tbody>{displayedRows.length ? displayedRows.map(row => <tr key={rowKey(row)}>{columns.map(column => <td key={column.id} className={cn(cellClass, "border-t border-border-default", alignments[column.align ?? "left"])}>{column.renderCell(row, "table")}</td>)}</tr>)
        : <tr><td colSpan={columns.length} className={cellClass}>{empty}</td></tr>}</tbody>
    </DataTableShell> : <ul aria-label={caption} className={cn("m-0 grid min-w-0 list-none p-0", customerCards ? "gap-3" : "divide-y divide-border-default")}>
      {displayedRows.length ? displayedRows.map(row => <li key={rowKey(row)} className={cn(variant === "compact" ? "min-w-0 p-3" : "min-w-0 p-4", customerCards && "rounded-panel border border-border-default bg-surface-panel")}>
        <dl className="m-0 grid min-w-0 gap-3">{columns.map(column => <div key={column.id} className={cn("grid min-w-0 gap-1", customerCards && "grid-cols-[minmax(0,1fr)_minmax(0,2fr)] items-start gap-3")}>
          <dt className={cn("wrap-anywhere text-label font-semibold text-content-secondary", customerCards && "text-body-sm")}>{column.header}</dt>
          <dd className={cn("m-0 min-w-0 wrap-anywhere whitespace-normal text-body-sm", alignments[column.align ?? "left"], customerCards && "text-right")}>{column.renderCell(row, "card")}</dd>
        </div>)}</dl>
      </li>) : <li className="min-w-0 p-4">{empty}</li>}
    </ul>}
  </Card>;
}
