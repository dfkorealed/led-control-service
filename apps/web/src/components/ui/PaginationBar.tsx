import type { ReactElement } from "react";
import { Button } from "./Button";
import { PageSizeSelect, validatePageSize } from "./PageSizeSelect";
import { Text } from "./Typography";
import { cn } from "./utils/cn";

export type DefaultPaginationPageSize = 10 | 20 | 50 | 100;
export type PaginationPageSize = DefaultPaginationPageSize | 500 | 1000;

interface PaginationCommonProps<TPageSize extends PaginationPageSize> {
  page: number;
  pageSize: NoInfer<TPageSize>;
  isPending?: boolean;
  hasPrevious: boolean;
  hasNext: boolean;
  onPrevious: () => void;
  onNext: () => void;
  onPageSizeChange: (pageSize: NoInfer<TPageSize>) => void;
  className?: string;
  showPageSizeSelector?: boolean;
}

type PaginationCountProps =
  | { mode?: "total"; totalCount: number; itemCount?: never }
  | { mode: "cursor"; itemCount: number | null; totalCount?: never };

type DefaultPaginationProps = PaginationCommonProps<DefaultPaginationPageSize> & PaginationCountProps & { pageSizeOptions?: undefined };
type CustomPaginationProps<TPageSize extends PaginationPageSize> = PaginationCommonProps<TPageSize> & PaginationCountProps & { pageSizeOptions: readonly TPageSize[] };

export type PaginationBarProps<TPageSize extends PaginationPageSize = PaginationPageSize> = DefaultPaginationProps | CustomPaginationProps<TPageSize>;

const defaultPageSizes: readonly DefaultPaginationPageSize[] = [10, 20, 50, 100];

// Only explicit options widen callbacks. Each branch passes its own correctly
// typed collection into the shared renderer, without casts or handler bivariance.
export function PaginationBar(props: DefaultPaginationProps): ReactElement;
export function PaginationBar<TPageSize extends PaginationPageSize>(props: CustomPaginationProps<TPageSize>): ReactElement;
export function PaginationBar<TPageSize extends PaginationPageSize>(props: PaginationBarProps<TPageSize>): ReactElement {
  if (props.pageSizeOptions === undefined) {
    return <PaginationContent<DefaultPaginationPageSize> {...props} pageSizeOptions={defaultPageSizes} />;
  }
  return <PaginationContent<TPageSize> {...props} />;
}

function PaginationContent<TPageSize extends PaginationPageSize>(props: CustomPaginationProps<TPageSize>) {
  const {
    page,
    pageSize,
    pageSizeOptions,
    isPending = false,
    hasPrevious,
    hasNext,
    onPrevious,
    onNext,
    onPageSizeChange,
    className,
    showPageSizeSelector = true
  } = props;
  validatePageSize(pageSize, pageSizeOptions);
  let countLabel: string;
  let nextDisabled = !hasNext;
  if (props.mode === "cursor") {
    // A new cursor/pending/error may have no confirmed rows yet. Null must not
    // announce an invented zero or reuse the previous page's current count.
    countLabel = props.itemCount === null ? "" : `현재 ${props.itemCount}건`;
  } else {
    // Unknown totals never reach this branch: cursor pagination owns only the
    // current row count and server flags, not a fabricated range/end page.
    const isEmpty = props.totalCount === 0;
    const firstItem = isEmpty ? 0 : Math.min((Math.max(page, 1) - 1) * pageSize + 1, props.totalCount);
    const lastItem = isEmpty ? 0 : Math.min(Math.max(page, 1) * pageSize, props.totalCount);
    countLabel = isEmpty ? "0건" : `${firstItem}~${lastItem} / ${props.totalCount}건`;
    nextDisabled ||= isEmpty;
  }

  return (
    <nav aria-label="페이지 이동" className={cn("flex min-w-0 flex-col gap-3 tablet:flex-row tablet:items-end tablet:justify-between", className)}>
      {showPageSizeSelector && <PageSizeSelect
        className="w-full tablet:max-w-40 tablet:flex-none"
        options={pageSizeOptions}
        value={pageSize}
        isDisabled={isPending}
        onChange={onPageSizeChange}
      />}
      <div className="flex min-w-0 items-center gap-2 tablet:w-auto">
        <Button type="button" size="sm" className="min-w-11 shrink-0" aria-label="이전 페이지" disabled={isPending || !hasPrevious} onClick={onPrevious}>
          이전
        </Button>
        <Text as="output" role="status" aria-live="polite" aria-busy={isPending || undefined} variant="caption" tone="secondary" className="min-w-0 flex-1 break-words text-center tabular-nums">
          <span className="block">{Math.max(page, 1)}페이지</span>
          <span className="block">{countLabel}</span>
        </Text>
        <Button type="button" size="sm" className="min-w-11 shrink-0" aria-label="다음 페이지" disabled={isPending || nextDisabled} onClick={onNext}>
          다음
        </Button>
      </div>
    </nav>
  );
}
