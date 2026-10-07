import type { MonitoringActivityItem } from "@led-control/shared";
import { useMemo, type RefObject } from "react";
import { RecentActivityTicker, Text } from "../../components/ui";
import { monitoringActivityRows } from "./monitoring-activity-presentation";
import { formatMonitoringTimestamp } from "./monitoring-time";

interface MonitoringLogTickerProps {
  scopeKey?: string;
  items: readonly MonitoringActivityItem[];
  generatedAt: string | null;
  retainedFrom: string | null;
  isPending: boolean;
  error: unknown;
  isRefetchError: boolean;
  timeZone: string;
  onOpen: () => void;
  onRetry: () => void;
  triggerRef?: RefObject<HTMLButtonElement>;
}

export function MonitoringLogTicker({ scopeKey = "", items, generatedAt, isPending, error, isRefetchError, timeZone, onOpen, onRetry, triggerRef }: MonitoringLogTickerProps) {
  // The activity query owns the server-clock retention deadline for these items.
  const rows = useMemo(() => monitoringActivityRows(error ? [] : items, timeZone), [items, timeZone, error]);
  const stale = isRefetchError && Boolean(error);
  const copy = isPending ? "운영 활동을 불러오는 중"
      : error ? "운영 활동을 불러오지 못했습니다."
        : "최근 3개월의 운영 활동 기록이 없습니다.";

  return <section
    role="region"
    aria-label="최근 운영 로그"
    className="min-w-0"
    data-monitoring-log-ticker=""
  >
    <RecentActivityTicker scopeKey={scopeKey} items={rows} emptyContent={<Text variant="body-sm" className="min-w-0 break-words">{copy}</Text>}
      onOpen={onOpen} onRetry={error ? onRetry : undefined} triggerRef={triggerRef} />
    {stale ? <Text variant="caption" tone="secondary">활동 갱신에 실패했습니다. 마지막 조회: {generatedAt ? formatMonitoringTimestamp(generatedAt, timeZone) : "확인 불가"}</Text> : null}
  </section>;
}
