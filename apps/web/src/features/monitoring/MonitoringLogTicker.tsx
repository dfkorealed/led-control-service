import type { MonitoringActivityItem } from "@led-control/shared";
import { useEffect, useState, type RefObject } from "react";
import { Button, Text } from "../../components/ui";
import { formatMonitoringActivity } from "./monitoring-activity-presentation";
import { formatMonitoringTimestamp } from "./monitoring-time";

interface MonitoringLogTickerProps {
  items: MonitoringActivityItem[];
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

export function MonitoringLogTicker({ items, generatedAt, retainedFrom, isPending, error, isRefetchError, timeZone, onOpen, onRetry, triggerRef }: MonitoringLogTickerProps) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [paused, setPaused] = useState(false);
  const [visible, setVisible] = useState(document.visibilityState === "visible");
  const itemIds = items.map((item) => item.id).join("|");

  useEffect(() => { setActiveIndex(0); }, [itemIds]);
  useEffect(() => {
    const handleVisibility = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []);
  useEffect(() => {
    if (paused || !visible || items.length < 2) return;
    const timer = window.setInterval(() => setActiveIndex((index) => (index + 1) % items.length), 3_000);
    return () => window.clearInterval(timer);
  }, [items.length, paused, visible]);

  const item = items[activeIndex % items.length];
  const hasItems = items.length > 0;
  const stale = hasItems && isRefetchError && Boolean(error);
  const copy = hasItems && item
    ? formatMonitoringActivity(item, timeZone)
    : isPending ? "운영 활동을 불러오는 중"
      : error ? "운영 활동을 불러오지 못했습니다."
        : "최근 3개월의 운영 활동 기록이 없습니다.";

  return <section
    role="region"
    aria-label="최근 운영 로그"
    className="grid min-w-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 rounded-control border border-border-default bg-surface-panel p-3"
    onMouseEnter={() => setPaused(true)}
    onMouseLeave={() => setPaused(false)}
    onFocusCapture={() => setPaused(true)}
    onBlurCapture={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setPaused(false); }}
    data-monitoring-log-ticker=""
  >
    <div className="min-w-0">
      <Text variant="body-sm" className="truncate">{copy}</Text>
      {stale ? <Text variant="caption" tone="secondary">활동 갱신에 실패했습니다. 마지막 조회: {generatedAt ? formatMonitoringTimestamp(generatedAt, timeZone) : "확인 불가"}</Text> : null}
      {!hasItems && !error && !isPending && retainedFrom ? <Text variant="caption" tone="secondary">3개월 이전 기록은 보관되지 않습니다.</Text> : null}
    </div>
    {hasItems ? <Button ref={triggerRef} variant="ghost" onClick={onOpen}>전체 보기</Button>
      : error ? <Button variant="secondary" onClick={onRetry}>다시 시도</Button> : null}
  </section>;
}
