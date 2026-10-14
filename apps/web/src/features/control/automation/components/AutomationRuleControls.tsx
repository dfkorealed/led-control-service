import { Button, FilterPanel, PageSizeSelect, SearchField, SelectBox, Text } from "../../../../components/ui";
import type { AutomationSyncStatus } from "../../../../api/automation";
import type { ReactNode } from "react";

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
export interface AutomationRuleControlsProps {
  label: string;
  filter: AutomationListFilter;
  filteredTotal?: number;
  pageIndex: number;
  currentPageCount: number;
  hasNextPage: boolean;
  isFetchingNextPage?: boolean;
  actions?: ReactNode;
  onFilterChange: (filter: AutomationListFilter) => void;
  onPrevious: () => void;
  onNext: () => void;
}

export function AutomationRuleControls({ label, filter, filteredTotal, pageIndex, currentPageCount,
  hasNextPage, isFetchingNextPage = false, actions, onFilterChange, onPrevious, onNext }: AutomationRuleControlsProps) {
  const canMove = filteredTotal !== undefined;
  return <section aria-label={`${label} 목록 조건`} className="grid min-w-0 gap-3">
    <FilterPanel label={`${label} 필터`} mode="popover"
      search={<SearchField label={`${label} 검색`} value={filter.query} maxLength={100} placeholder="규칙 이름 검색"
        onChange={(query) => onFilterChange({ ...filter, query })} />}
      activeFilterCount={Number(filter.status !== "all") + Number(filter.syncStatus !== "all") + Number(filter.limit !== 10)}
      summary={<Text variant="caption" tone="secondary">활성 상태: {statusItems.find(item => item.id === filter.status)?.label} · Gateway 동기화: {syncItems.find(item => item.id === filter.syncStatus)?.label} · 페이지당 {filter.limit}개</Text>}
      filterReset={label === "스케줄" ? undefined : <Button type="button" variant="secondary" size="sm" onClick={() => onFilterChange({ ...filter, status: "all", syncStatus: "all", limit: 10 })}>필터 초기화</Button>}>
      <SelectBox label="활성 상태" items={statusItems} selectedKey={filter.status}
        onSelectionChange={(status) => status && onFilterChange({ ...filter, status })} />
      <SelectBox label="Gateway 동기화" items={syncItems} selectedKey={filter.syncStatus}
        onSelectionChange={(syncStatus) => syncStatus && onFilterChange({ ...filter, syncStatus })} />
      <PageSizeSelect value={filter.limit} options={[10, 20, 50, 100] as const} onChange={limit => onFilterChange({ ...filter, limit })} />
    </FilterPanel>
    <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
      {actions}
      <Text as="output" role="status" aria-live="polite" variant="caption" tone="secondary">
        {filteredTotal === undefined ? "조건 결과 확인 중" : `조건에 맞는 규칙 ${filteredTotal}건`}

      </Text>
      <div className="flex items-center gap-2">
        <Button type="button" variant="secondary" size="sm" disabled={!canMove || pageIndex === 0} onClick={onPrevious}>이전</Button>
        <Button type="button" variant="secondary" size="sm" disabled={!canMove || !hasNextPage || isFetchingNextPage} isLoading={isFetchingNextPage} loadingLabel="불러오는 중" onClick={onNext}>
          다음
        </Button>
      </div>
    </div>
  </section>;
}
