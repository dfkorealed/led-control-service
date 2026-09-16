import {
  energyReportListQuerySchema,
  type EnergyReportFormat,
  type EnergyReportStatus,
  type EnergyScope
} from "@led-control/shared/energy-p2-contracts";
import { useEffect, useRef, useState } from "react";
import { Button, DateRangePicker, SelectBox, Text, TextField, cn, type DateRangeValue } from "../../../components/ui";
import type { ReportHistoryFilterState } from "./report-history-filters";

export interface ReportHistoryFiltersProps {
  value: ReportHistoryFilterState;
  onChange: (value: ReportHistoryFilterState) => void;
  className?: string;
}

const statusItems: ReadonlyArray<{ id: EnergyReportStatus | ""; label: string }> = [
  { id: "", label: "전체 상태" },
  { id: "queued", label: "대기 중" },
  { id: "processing", label: "생성 중" },
  { id: "completed", label: "완료" },
  { id: "failed", label: "생성 실패" },
  { id: "expired", label: "만료됨" }
];
const formatItems: ReadonlyArray<{ id: EnergyReportFormat | ""; label: string }> = [
  { id: "", label: "전체 형식" },
  { id: "xlsx", label: "XLSX" },
  { id: "pdf", label: "PDF" }
];
const scopeItems: ReadonlyArray<{ id: EnergyScope | ""; label: string }> = [
  { id: "", label: "전체 범위" },
  { id: "site", label: "현장" },
  { id: "fixture", label: "조명" },
  { id: "floor", label: "층" },
  { id: "group", label: "그룹" }
];

export function ReportHistoryFilters({ value, onChange, className }: ReportHistoryFiltersProps) {
  const [searchInput, setSearchInput] = useState(value.query ?? "");
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  valueRef.current = value;
  onChangeRef.current = onChange;

  useEffect(() => setSearchInput(value.query ?? ""), [value.query]);
  useEffect(() => {
    const query = searchInput.trim();
    if (query === (value.query ?? "")) return;
    const timer = window.setTimeout(() => {
      onChangeRef.current(updateFilterState(valueRef.current, query ? { query } : {}, query ? [] : ["query"]));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [searchInput, value.query]);

  const dateRange: DateRangeValue | null = value.requestedFrom && value.requestedTo
    ? { start: value.requestedFrom, end: value.requestedTo }
    : null;
  const chips = [
    ...(value.query ? [{ key: "query", label: `검색: ${value.query}`, remove: () => {
      setSearchInput("");
      onChange(removeFilters(value, "query"));
    } }] : []),
    ...(value.status ? [{ key: "status", label: `상태: ${itemLabel(statusItems, value.status)}`, remove: () => onChange(removeFilters(value, "status")) }] : []),
    ...(value.format ? [{ key: "format", label: `형식: ${itemLabel(formatItems, value.format)}`, remove: () => onChange(removeFilters(value, "format")) }] : []),
    ...(value.scope ? [{ key: "scope", label: `범위: ${itemLabel(scopeItems, value.scope)}`, remove: () => onChange(removeFilters(value, "scope")) }] : []),
    ...(dateRange ? [{ key: "requestedRange", label: `요청 기간: ${dateRange.start} ~ ${dateRange.end}`, remove: () => onChange(removeFilters(value, "requestedFrom", "requestedTo")) }] : [])
  ];

  return (
    <section role="search" aria-label="보고서 이력 필터" className={cn("grid min-w-0 gap-3", className)}>
      <div className="grid min-w-0 grid-cols-1 gap-3 tablet:grid-cols-2 desktop:grid-cols-3">
        <TextField
          type="search"
          label="보고서 검색"
          placeholder="대상명, 범위 또는 식별자"
          maxLength={100}
          value={searchInput}
          onChange={setSearchInput}
          className="min-w-0"
        />
        <SelectBox
          label="상태"
          items={statusItems}
          selectedKey={value.status ?? ""}
          onSelectionChange={(status) => onChange(status
            ? updateFilterState(value, { status })
            : removeFilters(value, "status"))}
          className="min-w-0"
        />
        <SelectBox
          label="파일 형식"
          items={formatItems}
          selectedKey={value.format ?? ""}
          onSelectionChange={(format) => onChange(format
            ? updateFilterState(value, { format })
            : removeFilters(value, "format"))}
          className="min-w-0"
        />
        <SelectBox
          label="범위"
          items={scopeItems}
          selectedKey={value.scope ?? ""}
          onSelectionChange={(scope) => onChange(scope
            ? updateFilterState(value, { scope })
            : removeFilters(value, "scope"))}
          className="min-w-0"
        />
        <DateRangePicker
          label="요청 기간"
          value={dateRange}
          onChange={(range) => onChange(range
            ? updateFilterState(value, { requestedFrom: range.start, requestedTo: range.end })
            : removeFilters(value, "requestedFrom", "requestedTo"))}
          className="min-w-0 tablet:col-span-2"
        />
      </div>
      {chips.length ? (
        <div className="flex min-w-0 flex-wrap items-center gap-2" aria-label="활성 조건">
          <Text as="span" variant="label" tone="secondary" className="w-full compact:w-auto">활성 조건</Text>
          {chips.map((chip) => (
            <Button
              key={chip.key}
              type="button"
              size="sm"
              variant="ghost"
              aria-label={`${chip.label} 조건 제거`}
              className="h-auto min-h-11 w-full max-w-full whitespace-normal px-3 py-2 text-left compact:w-auto"
              onClick={chip.remove}
            >
              <span className="min-w-0 break-words">{chip.label}</span>
              <span aria-hidden="true">×</span>
            </Button>
          ))}
        </div>
      ) : null}
    </section>
  );
}

type OptionalFilterKey = Exclude<keyof ReportHistoryFilterState, "limit">;

function updateFilterState(
  value: ReportHistoryFilterState,
  changes: Partial<ReportHistoryFilterState>,
  removed: OptionalFilterKey[] = []
) {
  const candidate: Record<string, unknown> = { ...value, ...changes };
  delete candidate.cursor;
  for (const key of removed) delete candidate[key];
  return energyReportListQuerySchema.parse(candidate);
}

function removeFilters(value: ReportHistoryFilterState, ...keys: OptionalFilterKey[]) {
  return updateFilterState(value, {}, keys);
}

function itemLabel<T extends string>(items: ReadonlyArray<{ id: T; label: string }>, id: T) {
  return items.find((item) => item.id === id)?.label ?? id;
}
