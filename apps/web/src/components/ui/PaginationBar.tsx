import { Button } from "./Button";
import { SelectBox } from "./fields/SelectBox";
import { Text } from "./Typography";
import { cn } from "./utils/cn";

export type PaginationPageSize = 10 | 20 | 50 | 100;

export interface PaginationBarProps {
  page: number;
  pageSize: PaginationPageSize;
  totalCount: number;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onPageSizeChange: (pageSize: PaginationPageSize) => void;
  className?: string;
}

const pageSizeOptions: ReadonlyArray<{ id: PaginationPageSize; label: string }> = [
  { id: 10, label: "10개" },
  { id: 20, label: "20개" },
  { id: 50, label: "50개" },
  { id: 100, label: "100개" }
];

export function PaginationBar({
  page,
  pageSize,
  totalCount,
  hasPrevious,
  hasNext,
  onPrevious,
  onNext,
  onPageSizeChange,
  className
}: PaginationBarProps) {
  const isEmpty = totalCount === 0;
  const firstItem = isEmpty ? 0 : Math.min((Math.max(page, 1) - 1) * pageSize + 1, totalCount);
  const lastItem = isEmpty ? 0 : Math.min(Math.max(page, 1) * pageSize, totalCount);

  return (
    <nav aria-label="페이지 이동" className={cn("flex min-w-0 flex-col gap-3 tablet:flex-row tablet:items-end tablet:justify-between", className)}>
      <SelectBox
        label="페이지당 항목 수"
        size="sm"
        className="w-full tablet:max-w-40 tablet:flex-none"
        items={pageSizeOptions}
        selectedKey={pageSize}
        onSelectionChange={(value) => {
          if (value !== null) onPageSizeChange(value);
        }}
      />
      <div className="flex min-w-0 items-center gap-2 tablet:w-auto">
        <Button type="button" size="sm" className="min-w-11 shrink-0" aria-label="이전 페이지" disabled={isEmpty || !hasPrevious} onClick={onPrevious}>
          이전
        </Button>
        <Text as="output" role="status" aria-live="polite" variant="caption" tone="secondary" className="min-w-0 flex-1 whitespace-nowrap text-center tabular-nums">
          <span className="block">{Math.max(page, 1)}페이지</span>
          <span className="block">{isEmpty ? "0건" : `${firstItem}~${lastItem} / ${totalCount}건`}</span>
        </Text>
        <Button type="button" size="sm" className="min-w-11 shrink-0" aria-label="다음 페이지" disabled={isEmpty || !hasNext} onClick={onNext}>
          다음
        </Button>
      </div>
    </nav>
  );
}
