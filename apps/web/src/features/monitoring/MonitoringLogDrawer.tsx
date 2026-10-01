import { useEffect, useState, type RefObject } from "react";
import { isApiStatus } from "../../api/client";
import { Button, DateRangePicker, DrawerDialog, FilterPanel, LogView, PaginationBar, SelectBox, Text, type DateRangeValue } from "../../components/ui";
import { formatMonitoringActivity } from "./monitoring-activity-presentation";
import { formatMonitoringTimestamp } from "./monitoring-time";
import { useMonitoringActivity } from "./useMonitoringActivity";

interface MonitoringLogDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  returnFocusRef: RefObject<HTMLElement | null>;
  fallbackFocusRef: RefObject<HTMLElement | null>;
  principal: string | null;
  siteId: string | null;
  floorId: string | null;
  timeZone: string;
}

export function MonitoringLogDrawer({ isOpen, onClose, returnFocusRef, fallbackFocusRef, principal, siteId, floorId, timeZone }: MonitoringLogDrawerProps) {
  const scopeKey = JSON.stringify([principal, siteId, floorId, isOpen]);
  const [navigation, setNavigation] = useState({ scopeKey, cursors: [""] });
  const cursorStack = navigation.scopeKey === scopeKey ? navigation.cursors : [""];
  const setCursorStack = (change: string[] | ((stack: string[]) => string[])) => setNavigation({ scopeKey, cursors: typeof change === "function" ? change(cursorStack) : change });
  const [limit, setLimit] = useState<50 | 100 | 500 | 1000>(50);
  const [period, setPeriod] = useState<DateRangeValue | null>(null);
  const cursor = cursorStack.at(-1) ?? "";
  const query = useMonitoringActivity({ principal: isOpen ? principal : null, siteId, floorId, cursor, limit, fromDate: period?.start, toDate: period?.end });
  const expired = isApiStatus(query.error, 410);
  const pending = query.isPending || query.isFetching || query.isPaused;
  const success = !pending && !query.error && Boolean(query.data);
  const options = [50, 100, 500, 1000] as const;

  useEffect(() => { if (isOpen && isApiStatus(query.error, 401)) onClose(); }, [isOpen, query.error, onClose]);

  return <DrawerDialog
    isOpen={isOpen}
    onClose={onClose}
    returnFocusRef={returnFocusRef}
    fallbackFocusRef={fallbackFocusRef}
    title="전체 로그"
    closeLabel="전체 로그 닫기"
    className="flex min-h-0 max-w-[var(--container-lg)] flex-col overflow-hidden"
    bodyClassName="min-h-0 flex-1 overflow-hidden"
  >
    <LogView label="운영 로그" filters={<FilterPanel label="운영 로그 필터" actions={period ? <Button variant="secondary" onClick={() => { setPeriod(null); setCursorStack([""]); }}>전체 보관 기간</Button> : undefined}>
      <DateRangePicker label="조회 기간" value={period} onChange={value => { setPeriod(value); setCursorStack([""]); }} description={period ? `${period.start} ~ ${period.end} · 종료일 포함` : "전체 보관 기간 · 최근 3개월"} />
    </FilterPanel>} pagination={success ? <PaginationBar mode="cursor" page={cursorStack.length} pageSize={limit} pageSizeOptions={options} itemCount={query.data!.items.length} hasPrevious={cursorStack.length > 1} hasNext={Boolean(query.data!.nextCursor)} onPrevious={() => setCursorStack(stack => stack.slice(0, -1))} onNext={() => { const next = query.data?.nextCursor; if (next) setCursorStack(stack => [...stack, next]); }} onPageSizeChange={value => { setLimit(value); setCursorStack([""]); }} /> : <SelectBox label="페이지당 항목 수" selectedKey={limit} items={options.map(id => ({ id, label: `${id}개` }))} isDisabled={pending} onSelectionChange={value => { if (value) { setLimit(value); setCursorStack([""]); } }} />} status={<>
      <Text variant="body-sm" tone="secondary">선택 층의 최근 3개월 운영 활동 기록입니다. 3개월 이전 기록은 보관되지 않습니다.</Text>
      {success ? <Text variant="caption" tone="secondary">보관 시작: {formatMonitoringTimestamp(query.data!.retainedFrom, timeZone)}</Text> : null}
      {expired ? <section role="status" className="grid gap-3">
        <Text>보관 기간이 지나 이 페이지를 볼 수 없습니다.</Text>
        <Button variant="secondary" onClick={() => setCursorStack([""])}>최신 기록 보기</Button>
      </section> : pending ? <Text role="status">운영 활동을 불러오는 중</Text>
        : query.error ? <section role="alert" className="grid gap-3">
          <Text>운영 활동을 불러오지 못했습니다.</Text>
          <Button variant="secondary" onClick={() => void query.refetch()}>다시 시도</Button>
        </section> : success && query.data?.items.length === 0 ? <Text>최근 3개월의 운영 활동 기록이 없습니다.</Text> : null}
    </>}>
          {success && query.data?.items.length ? <ol className="m-0 grid list-none gap-2 p-0">
            {query.data.items.map((item) => <li key={item.id} className="rounded-control border border-border-default bg-surface-elevated p-3 text-body-sm">{formatMonitoringActivity(item, timeZone)}</li>)}
          </ol> : null}
    </LogView>
  </DrawerDialog>;
}
