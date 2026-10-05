import { useState } from "react";
import { Button, FilterPanel, Heading, MetricButton, MetricCard, Text, type MetricTone } from "../../components/ui";
import type { MonitoringFixtureFilter } from "./monitoring-fixture-filter";

interface MonitoringSummaryProps {
  scope: "site" | "floor";
  mapName?: string;
  total: number | null;
  online: number | null;
  fault: number | null;
  offline: number | null;
  filter?: MonitoringFixtureFilter;
  onSelect?: (filter: MonitoringFixtureFilter) => void;
}

const CARD_CLASS_NAME = "min-h-18 grid-cols-1 content-center gap-0! rounded-none! border-0! bg-surface-panel! px-4! py-1! [&>strong]:text-card-title! [&>strong>span]:text-card-title! max-compact:min-h-16 max-compact:px-2! max-compact:[&>p]:hidden max-compact:[&_[data-metric-label]]:text-label";

export function MonitoringSummary({ scope, mapName, total, online, fault, offline, filter, onSelect }: MonitoringSummaryProps) {
  const [filterOpen, setFilterOpen] = useState(false);
  const site = scope === "site";
  const display = (value: number | null) => value === null ? "집계 준비 중" : value;
  const metrics: Array<{ id: MonitoringFixtureFilter; label: string; value: number | null; tone?: MetricTone }> = [
    { id: "all", label: site ? "현장 조명" : "전체 조명", value: total, tone: "primary" },
    { id: "online", label: site ? "현장 정상" : "정상", value: online, tone: "success" },
    { id: "fault", label: site ? "현장 점검" : "점검 필요", value: fault, tone: "danger" },
    { id: "offline", label: site ? "현장 오프라인" : "오프라인", value: offline }
  ];

  return <section
    className="grid min-w-0 gap-2"
    role="region"
    aria-label={site ? "현장 전체 조명 현황" : "선택 층 조명 현황"}
    data-monitoring-summary={site ? undefined : ""}
    data-monitoring-site-summary={site ? "" : undefined}
  >
    {!site && onSelect ? <div className="flex min-w-0 flex-wrap items-start justify-between gap-2">
      {mapName ? <Heading as="h2" variant="label" className="min-w-0 break-words">{mapName} · 조명 현황</Heading> : null}
      <FilterPanel label="맵 조명 상태 필터" mode="popover" variant="compact" isOpen={filterOpen} onOpenChange={setFilterOpen}
        activeFilterCount={filter && filter !== "all" ? 1 : 0}
        summary={<Text variant="caption">표시 상태: {metrics.find(metric => metric.id === filter)?.label ?? "전체 조명"}</Text>}
        filterReset={filter && filter !== "all" ? <Button variant="secondary" onClick={() => { setFilterOpen(false); onSelect("all"); }}>필터 초기화</Button> : undefined}>
        <div className="grid min-w-0 grid-cols-2 gap-2">
          {metrics.map(metric => <MetricButton key={metric.id} label={metric.label} value={display(metric.value)} tone={metric.tone}
            selected={filter === metric.id} disabled={metric.value === null}
            onClick={() => { setFilterOpen(false); onSelect(metric.id); }} />)}
        </div>
      </FilterPanel>
    </div> : !site && mapName ? <Heading as="h2" variant="label" className="break-words">{mapName} · 조명 현황</Heading> : null}
    <div className="grid grid-cols-2 gap-0.5 overflow-hidden rounded-panel border border-border-default bg-border-default phone-wide:grid-cols-4">
    {metrics.map(metric => {
      const props = { className: CARD_CLASS_NAME, label: metric.label, value: display(metric.value), tone: metric.tone };
      return <MetricCard key={metric.id} {...props} />;
    })}
    </div>
  </section>;
}
