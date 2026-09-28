import { Button, SearchField, SelectBox, Text } from "../../../../components/ui";
import type { AutomationSyncStatus } from "../../../../api/automation";

export type AutomationListPageSize = 10 | 20 | 50 | 100;

export interface AutomationListFilter {
  query: string;
  status: "all" | "enabled" | "disabled";
  syncStatus: "all" | AutomationSyncStatus;
  limit: AutomationListPageSize;
}

const statusItems: ReadonlyArray<{ id: AutomationListFilter["status"]; label: string }> = [
  { id: "all", label: "전체" },
  { id: "enabled", label: "활성" },
  { id: "disabled", label: "비활성" }
];
const syncItems: ReadonlyArray<{ id: AutomationListFilter["syncStatus"]; label: string }> = [
  { id: "all", label: "전체" },
  { id: "APPLIED", label: "적용됨" },
  { id: "PENDING", label: "적용 대기" },
  { id: "REJECTED", label: "적용 실패" }
];
const pageSizeItems: ReadonlyArray<{ id: AutomationListPageSize; label: string }> = [
  { id: 10, label: "10개" }, { id: 20, label: "20개" },
  { id: 50, label: "50개" }, { id: 100, label: "100개" }
];

export interface AutomationRuleControlsProps {
  label: string;
  filter: AutomationListFilter;
  filteredTotal?: number;
  pageIndex: number;
  currentPageCount: number;
  hasNextPage: boolean;
  isFetchingNextPage?: boolean;
  onFilterChange: (filter: AutomationListFilter) => void;
  onPrevious: () => void;
  onNext: () => void;
}

export function AutomationRuleControls({ label, filter, filteredTotal, pageIndex, currentPageCount,
  hasNextPage, isFetchingNextPage = false, onFilterChange, onPrevious, onNext }: AutomationRuleControlsProps) {
  const canMove = filteredTotal !== undefined;
  return <section aria-label={`${label} 목록 조건`} className="grid min-w-0 gap-3 rounded-panel border border-border-default bg-surface-panel p-3">
    <div className="grid min-w-0 gap-2 compact:grid-cols-2 tablet:grid-cols-[minmax(0,1fr)_repeat(3,minmax(8rem,auto))]">
      <SearchField label={`${label} 검색`} value={filter.query} maxLength={100} placeholder="규칙 이름 검색"
        onChange={(query) => onFilterChange({ ...filter, query })} />
      <SelectBox label="활성 상태" items={statusItems} selectedKey={filter.status}
        onSelectionChange={(status) => status && onFilterChange({ ...filter, status })} />
      <SelectBox label="Gateway 동기화" items={syncItems} selectedKey={filter.syncStatus}
        onSelectionChange={(syncStatus) => syncStatus && onFilterChange({ ...filter, syncStatus })} />
      <SelectBox label="페이지당 항목 수" items={pageSizeItems} selectedKey={filter.limit}
        onSelectionChange={(limit) => limit && onFilterChange({ ...filter, limit })} />
    </div>
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      <Text as="output" role="status" aria-live="polite" variant="caption" tone="secondary">
        {filteredTotal === undefined ? "조건 결과 확인 중" : `조건에 맞는 규칙 ${filteredTotal}건`}
        {filteredTotal !== undefined ? ` · ${pageIndex + 1}번째 묶음 · 현재 ${currentPageCount}건` : null}
      </Text>
      <div className="flex items-center gap-2">
        <Button type="button" variant="secondary" size="sm" disabled={!canMove || pageIndex === 0} onClick={onPrevious}>이전</Button>
        <Button type="button" variant="secondary" size="sm" disabled={!canMove || !hasNextPage || isFetchingNextPage} onClick={onNext}>
          {isFetchingNextPage ? "불러오는 중" : "다음"}
        </Button>
      </div>
    </div>
  </section>;
}
