import { useEffect, useState, type RefObject } from "react";
import { isApiStatus } from "../../api/client";
import { Button, DrawerDialog, Text } from "../../components/ui";
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
  const [cursorStack, setCursorStack] = useState<string[]>([""]);
  const cursor = cursorStack.at(-1) ?? "";
  const query = useMonitoringActivity({ principal: isOpen ? principal : null, siteId, floorId, cursor, limit: 5 });
  const expired = isApiStatus(query.error, 410);

  useEffect(() => { setCursorStack([""]); }, [principal, siteId, floorId, isOpen]);
  useEffect(() => { if (isOpen && isApiStatus(query.error, 401)) onClose(); }, [isOpen, query.error, onClose]);

  return <DrawerDialog
    isOpen={isOpen}
    onClose={onClose}
    returnFocusRef={returnFocusRef}
    fallbackFocusRef={fallbackFocusRef}
    title="전체 로그"
    closeLabel="전체 로그 닫기"
    className="max-w-[440px]"
  >
    <div className="grid gap-4" data-monitoring-log-drawer="">
      <Text variant="body-sm" tone="secondary">최근 3개월의 운영 활동 기록입니다. 3개월 이전 기록은 보관되지 않습니다.</Text>
      {query.data && !query.error && !query.isFetching ? <Text variant="caption" tone="secondary">보관 시작: {formatMonitoringTimestamp(query.data.retainedFrom, timeZone)}</Text> : null}
      {expired ? <section role="status" className="grid gap-3">
        <Text>보관 기간이 지나 이 페이지를 볼 수 없습니다.</Text>
        <Button variant="secondary" onClick={() => setCursorStack([""])}>최신 기록 보기</Button>
      </section> : query.isPending ? <Text role="status">운영 활동을 불러오는 중</Text>
        : query.error ? <section role="alert" className="grid gap-3">
          <Text>운영 활동을 불러오지 못했습니다.</Text>
          <Button variant="secondary" onClick={() => void query.refetch()}>다시 시도</Button>
        </section> : <>
          {!query.isFetching && query.data?.items.length ? <ol className="m-0 grid list-none gap-2 p-0">
            {query.data.items.map((item) => <li key={item.id} className="rounded-control border border-border-default bg-surface-elevated p-3 text-body-sm">{formatMonitoringActivity(item, timeZone)}</li>)}
          </ol> : <Text>최근 3개월의 운영 활동 기록이 없습니다.</Text>}
          <nav aria-label="운영 로그 페이지" className="flex items-center justify-between gap-3">
            <Button variant="secondary" disabled={cursorStack.length === 1} onClick={() => setCursorStack((stack) => stack.slice(0, -1))}>이전</Button>
            <Button variant="secondary" disabled={!query.data?.nextCursor} onClick={() => {
              const nextCursor = query.data?.nextCursor;
              if (nextCursor) setCursorStack((stack) => [...stack, nextCursor]);
            }}>다음</Button>
          </nav>
        </>}
    </div>
  </DrawerDialog>;
}
