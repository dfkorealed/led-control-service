import {
  energyReportListQuerySchema,
  type EnergyReportStatus,
  type EnergyScope
} from "@led-control/shared/energy-p2-contracts";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Button, DateRangePicker, FilterPanel, SelectBox, Text, TextField, cn, useDateRangeDraft, type DateRangeValue } from "../../../components/ui";
import type { ReportHistoryFilterState } from "./report-history-filters";
import { draftToDate, isEmptyDateDraft, type DateSegmentDraft } from "../../../components/ui/date/useDateDraft";

export interface InvalidRequestedRange { start: string | null; end: string | null }
export type ReportFilterIntent = "filter" | "dates" | "reset";

export interface ReportHistoryFiltersProps {
  value: ReportHistoryFilterState;
  onChange: (value: ReportHistoryFilterState, intent?: ReportFilterIntent) => void;
  className?: string;
  scopeKey?: string;
  invalidRequestedRange?: InvalidRequestedRange;
  onInvalidDraftChange?: (invalid: boolean) => void;
}

const statusItems: ReadonlyArray<{ id: EnergyReportStatus | ""; label: string }> = [
  { id: "", label: "전체 상태" },
  { id: "queued", label: "대기 중" },
  { id: "processing", label: "생성 중" },
  { id: "completed", label: "완료" },
  { id: "failed", label: "생성 실패" },
  { id: "expired", label: "만료됨" }
];
const scopeItems: ReadonlyArray<{ id: EnergyScope | ""; label: string }> = [
  { id: "", label: "전체 범위" },
  { id: "site", label: "현장" },
  { id: "fixture", label: "조명" },
  { id: "floor", label: "층" },
  { id: "group", label: "그룹" }
];

export function ReportHistoryFilters({ value, onChange, className, scopeKey = "reports", invalidRequestedRange, onInvalidDraftChange }: ReportHistoryFiltersProps) {
  const [searchInput, setSearchInput] = useState(value.query ?? "");
  const [dateDraft, setDateDraft] = useState<DateRangeValue | null>(() => reportDateRange(value));
  const [dateError, setDateError] = useState<string | null>(null);
  const rangeDraft = useDateRangeDraft(scopeKey, reportDateRange(value));
  const scopeEpoch = useRef({ key: scopeKey, epoch: {} });
  if (scopeEpoch.current.key !== scopeKey) scopeEpoch.current = { key: scopeKey, epoch: {} };
  const epoch = scopeEpoch.current.epoch;
  const start = draftToDate(rangeDraft.draft.start), end = draftToDate(rangeDraft.draft.end);
  const empty = isEmptyDateDraft(rangeDraft.draft.start) && isEmptyDateDraft(rangeDraft.draft.end);
  // Like command history, query validity follows raw segments, not the last
  // accepted canonical range. Notify before passive automatic query effects.
  const invalidDraft = !empty && (!start || !end || !safeUpdateFilterState(value, { requestedFrom: start, requestedTo: end }).success);
  useLayoutEffect(() => {
    if (scopeEpoch.current.epoch === epoch) onInvalidDraftChange?.(invalidDraft);
  }, [epoch, invalidDraft, onInvalidDraftChange]);
  // Scope epochs distinguish A→B→A, so a retained callback cannot publish into a later visit to A.
  const isCurrentScope = () => scopeEpoch.current.epoch === epoch;
  const publish = (next: ReportHistoryFilterState, intent?: ReportFilterIntent) => {
    if (!isCurrentScope()) return;
    if (invalidRequestedRange || onInvalidDraftChange) onChange(next, intent); else onChange(next);
  };
  const valueRef = useRef(value);
  const onChangeRef = useRef(onChange);
  valueRef.current = value;
  onChangeRef.current = onChange;

  useEffect(() => setSearchInput(value.query ?? ""), [scopeKey, value.query]);
  useEffect(() => {
    if (invalidRequestedRange) {
      // Raw URL strings cannot enter the strict canonical adapter. Keep numeric
      // segments (including impossible dates) in the parent draft, and retain
      // the complete original string in the visible error for malformed input.
      rangeDraft.onDraftChange({ start: rawUrlDateDraft(invalidRequestedRange.start), end: rawUrlDateDraft(invalidRequestedRange.end) });
      setDateDraft(null); setDateError("요청 기간을 확인해 주세요.");
      return;
    }
    setDateDraft(reportDateRange(value));
    rangeDraft.reset(reportDateRange(value));
    setDateError(null);
  }, [scopeKey, value.requestedFrom, value.requestedTo, invalidRequestedRange?.start, invalidRequestedRange?.end]);
  useEffect(() => {
    const query = searchInput.trim();
    if (query === (value.query ?? "")) return;
    const timer = window.setTimeout(() => {
      if (scopeEpoch.current.epoch === epoch) onChangeRef.current(updateFilterState(valueRef.current, query ? { query } : {}, query ? [] : ["query"]));
    }, 300);
    return () => window.clearTimeout(timer);
  }, [scopeKey, searchInput, value.query]);

  const dateRange = reportDateRange(value);
  const chips = [
    ...(value.query ? [{ key: "query", label: `검색: ${value.query}`, remove: () => {
      if (!isCurrentScope()) return;
      setSearchInput("");
      publish(removeFilters(value, "query"));
    } }] : []),
    ...(value.status ? [{ key: "status", label: `상태: ${itemLabel(statusItems, value.status)}`, remove: () => publish(removeFilters(value, "status")) }] : []),
    ...(value.scope ? [{ key: "scope", label: `범위: ${itemLabel(scopeItems, value.scope)}`, remove: () => publish(removeFilters(value, "scope")) }] : []),
    ...(dateRange ? [{ key: "requestedRange", label: `요청 기간: ${dateRange.start} ~ ${dateRange.end}`, remove: () => publish(removeFilters(value, "requestedFrom", "requestedTo")) }] : [])
  ];

  const activeConditions = chips.length ? <div className="flex min-w-0 flex-wrap items-center gap-2" aria-label="활성 조건">
    <Text as="span" variant="label" tone="secondary" className="w-full compact:w-auto">활성 조건</Text>
    {chips.map((chip) => <Button key={chip.key} type="button" size="sm" variant="ghost"
      aria-label={`${chip.label} 조건 제거`}
      className="h-auto min-h-11 w-full max-w-full whitespace-normal px-3 py-2 text-left compact:w-auto"
      onClick={chip.remove}>
      <span className="min-w-0 break-words">{chip.label}</span><span aria-hidden="true">×</span>
    </Button>)}
  </div> : undefined;
  const resetAction = chips.length ? <Button type="button" size="sm" variant="secondary"
    className="min-h-11 w-full compact:ml-auto compact:w-auto" onClick={() => {
      if (!isCurrentScope()) return;
      setSearchInput("");
      setDateDraft(null);
      setDateError(null);
      rangeDraft.reset(null);
      publish(energyReportListQuerySchema.parse({ limit: value.limit }), "reset");
    }}>전체 초기화</Button> : undefined;

  return (
    <section role="search" aria-label="보고서 이력 필터" className={cn("min-w-0", className)}>
      <FilterPanel label="보고서 조건" mode="popover" chips={activeConditions} actions={resetAction}
        activeFilterCount={Number(Boolean(value.status)) + Number(Boolean(value.scope)) + Number(Boolean(dateRange || invalidRequestedRange)) + Number(value.limit !== 20)}
        filterReset={<Button size="sm" variant="secondary" onClick={() => {
          if (!isCurrentScope()) return;
          setDateDraft(null); setDateError(null); rangeDraft.reset(null);
          publish(energyReportListQuerySchema.parse({ limit: 20, ...(value.query ? { query: value.query } : {}) }), "reset");
        }}>필터 초기화</Button>}
        search={
        <TextField
          type="search"
          label="보고서 검색"
          placeholder="대상명, 범위 또는 식별자"
          maxLength={100}
          value={searchInput}
          onChange={setSearchInput}
          className="min-w-0 w-full compact:w-56"
        />}>
        <SelectBox
          label="상태"
          items={statusItems}
          selectedKey={value.status ?? ""}
          onSelectionChange={(status) => publish(status
            ? updateFilterState(value, { status })
            : removeFilters(value, "status"))}
          className="min-w-0 w-full compact:w-40"
        />
        <SelectBox
          label="범위"
          items={scopeItems}
          selectedKey={value.scope ?? ""}
          onSelectionChange={(scope) => publish(scope
            ? updateFilterState(value, { scope })
            : removeFilters(value, "scope"))}
          className="min-w-0 w-full compact:w-40"
        />
        <SelectBox label="페이지 크기" selectedKey={String(value.limit)} items={[10, 20, 50, 100].map(limit => ({ id: String(limit), label: `${limit}개` }))}
          onSelectionChange={limit => limit && publish(updateFilterState(value, { limit: Number(limit) as ReportHistoryFilterState["limit"] }))} />
        <DateRangePicker
          label="요청 기간"
          description="보고서를 요청한 날짜로 검색합니다. 보고서 본문 대상 기간과 다릅니다."
          value={dateDraft}
          draftController={rangeDraft}
          validationBehavior="aria"
          isInvalid={invalidDraft || dateError !== null}
          errorMessage={dateError ?? (invalidDraft ? "요청 기간을 올바르게 완성해 주세요." : null)}
          onChange={(range) => {
            if (scopeEpoch.current.epoch !== epoch) return;
            // Keep an invalid range editable locally; only validated dates belong in URL/query state.
            setDateDraft(range);
            if (!range) {
              setDateError(null);
              publish(removeFilters(value, "requestedFrom", "requestedTo"), "dates");
              return;
            }
            const result = safeUpdateFilterState(value, {
              requestedFrom: range.start,
              requestedTo: range.end
            });
            if (!result.success) {
              setDateError(reportDateError(result.error.issues.map((issue) => issue.message)));
              return;
            }
            setDateError(null);
            publish(result.data, "dates");
          }}
          className="min-w-0"
        />
      </FilterPanel>
      {invalidRequestedRange ? <Text tone="danger" variant="body-sm" className="min-w-0 break-all">URL 요청 기간: {invalidRequestedRange.start ?? "미입력"} ~ {invalidRequestedRange.end ?? "미입력"}</Text> : null}
    </section>
  );
}

function rawUrlDateDraft(value: string | null): DateSegmentDraft {
  const parts = value?.split("-") ?? [];
  const segment = (index: number) => /^\d+$/.test(parts[index] ?? "") && Number.isSafeInteger(Number(parts[index])) ? Number(parts[index]) : null;
  return { year: segment(0), month: segment(1), day: segment(2) };
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

function safeUpdateFilterState(
  value: ReportHistoryFilterState,
  changes: Partial<ReportHistoryFilterState>
) {
  const candidate: Record<string, unknown> = { ...value, ...changes };
  delete candidate.cursor;
  return energyReportListQuerySchema.safeParse(candidate);
}

function removeFilters(value: ReportHistoryFilterState, ...keys: OptionalFilterKey[]) {
  return updateFilterState(value, {}, keys);
}

function itemLabel<T extends string>(items: ReadonlyArray<{ id: T; label: string }>, id: T) {
  return items.find((item) => item.id === id)?.label ?? id;
}

function reportDateRange(value: ReportHistoryFilterState): DateRangeValue | null {
  return value.requestedFrom && value.requestedTo
    ? { start: value.requestedFrom, end: value.requestedTo }
    : null;
}

function reportDateError(messages: string[]) {
  if (messages.includes("requested range must not exceed 90 days")) {
    return "요청 기간은 최대 90일까지 선택할 수 있습니다.";
  }
  if (messages.includes("requestedTo must not end before requestedFrom")) {
    return "종료일은 시작일보다 빠를 수 없습니다.";
  }
  return "요청 기간을 확인해 주세요.";
}
