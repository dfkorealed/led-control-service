import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { FocusScope, useFocusManager } from "react-aria";
import { isApiStatus } from "../../api/client";
import { Button, DateRangePicker, DrawerDialog, FilterPanel, LogView, PaginationBar, Text, type DateRangeValue } from "../../components/ui";
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

  // The derived first-render guard prevents a stale cursor request, while this
  // discards the old stack so returning to that scope cannot revive page two.
  useEffect(() => { setNavigation(current => current.scopeKey === scopeKey ? current : { scopeKey, cursors: [""] }); }, [scopeKey]);
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
    </FilterPanel>} pagination={<FocusScope><MonitoringLogPager isOpen={isOpen} scopeKey={scopeKey} pending={pending} success={success} error={query.error}>
      <PaginationBar
        mode="cursor" page={cursorStack.length} pageSize={limit} pageSizeOptions={options}
        itemCount={success ? query.data!.items.length : null} isPending={pending}
        hasPrevious={cursorStack.length > 1} hasNext={success && Boolean(query.data!.nextCursor)}
        onPrevious={() => setCursorStack(stack => stack.slice(0, -1))}
        onNext={() => { const next = success ? query.data?.nextCursor : null; if (next) setCursorStack(stack => [...stack, next]); }}
        onPageSizeChange={value => { setLimit(value); setCursorStack([""]); }}
      />
    </MonitoringLogPager></FocusScope>} status={<>
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

function MonitoringLogPager({ isOpen, scopeKey, pending, success, error, children }: {
  isOpen: boolean; scopeKey: string; pending: boolean; success: boolean; error: unknown; children: ReactNode;
}) {
  const pagerRef = useRef<HTMLDivElement>(null);
  const focusIntentRef = useRef<{ scopeKey: string; control: HTMLButtonElement } | null>(null);
  const focusManager = useFocusManager();

  // Native disabling may lose focus despite stable controls. This lease belongs
  // only to this open scope, and any deliberate move outside the pager revokes it.
  useLayoutEffect(() => {
    const restore = () => {
      const intent = focusIntentRef.current;
      const pager = pagerRef.current;
      if (!isOpen || intent?.scopeKey !== scopeKey) { focusIntentRef.current = null; return; }
      if (!pager || !intent.control.isConnected) return;
      const active = document.activeElement;
      const dialog = pager.closest('[role="dialog"]');
      if (active && active !== document.body && active !== dialog && !pager.contains(active)) return;
      if (pending) pager.focus({ preventScroll: true });
      else if (!intent.control.disabled) intent.control.focus({ preventScroll: true });
      else if (!focusManager?.focusFirst({ tabbable: true })) pager.focus({ preventScroll: true });
    };
    restore();
    // Portalled SelectBox options finish closing after the layout pass. Recheck
    // the live lease then, without racing or overriding another valid focus.
    const frame = requestAnimationFrame(restore);
    return () => cancelAnimationFrame(frame);
  }, [isOpen, scopeKey, pending, success, error, focusManager]);

  return <div ref={pagerRef} role="group" aria-label="운영 로그 페이지 조작" aria-busy={pending || undefined} tabIndex={-1}
    onFocusCapture={event => { if (event.target instanceof HTMLButtonElement && event.currentTarget.contains(event.target)) focusIntentRef.current = { scopeKey, control: event.target }; }}
    onBlurCapture={event => {
      const next = event.relatedTarget;
      // The portalled options and their closing dialog fallback are part of the
      // same selection interaction, unlike a user move to date/body/close.
      if (next instanceof Element && !event.currentTarget.contains(next) && !next.closest('[role="listbox"]') &&
        !(event.target instanceof Element && event.target.closest('[role="listbox"]') && next.getAttribute("role") === "dialog")) focusIntentRef.current = null;
    }}>{children}</div>;
}
