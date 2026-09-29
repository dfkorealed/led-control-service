import { MetricButton, MetricCard, type MetricTone } from "../../components/ui";
import type { MonitoringFixtureFilter } from "./monitoring-fixture-filter";

interface MonitoringSummaryProps {
  scope: "site" | "floor";
  total: number | null;
  online: number | null;
  fault: number | null;
  offline: number | null;
  filter?: MonitoringFixtureFilter;
  onSelect?: (filter: MonitoringFixtureFilter) => void;
}

const CARD_CLASS_NAME = "min-h-18 grid-cols-1 content-center gap-0! rounded-none! border-0! bg-surface-panel! px-4! py-1! [&>strong]:text-card-title! [&>strong>span]:text-card-title! max-compact:min-h-16 max-compact:px-2! max-compact:[&>p]:hidden max-compact:[&_[data-metric-label]]:text-label";

export function MonitoringSummary({ scope, total, online, fault, offline, filter, onSelect }: MonitoringSummaryProps) {
  const site = scope === "site";
  const display = (value: number | null) => value === null ? "집계 준비 중" : value;
  const metrics: Array<{ id: MonitoringFixtureFilter; label: string; value: number | null; helper: string; tone?: MetricTone }> = [
    { id: "all", label: site ? "현장 조명" : "전체 조명", value: total, helper: site ? "현장 전체 기준" : "선택 층 기준", tone: "primary" },
    { id: "online", label: site ? "현장 정상" : "정상", value: online, helper: "최근 수신 정상", tone: "success" },
    { id: "fault", label: site ? "현장 점검" : "점검 필요", value: fault, helper: "우선 점검 대상", tone: "danger" },
    { id: "offline", label: site ? "현장 오프라인" : "오프라인", value: offline, helper: "상태 확인 대기 포함" }
  ];

  return <section
    className="grid grid-cols-2 gap-0.5 overflow-hidden rounded-panel border border-border-default bg-border-default phone-wide:grid-cols-4"
    role="region"
    aria-label={site ? "현장 전체 조명 현황" : "선택 층 조명 현황"}
    data-monitoring-summary={site ? undefined : ""}
    data-monitoring-site-summary={site ? "" : undefined}
  >
    {metrics.map(metric => {
      const props = { className: CARD_CLASS_NAME, label: metric.label, value: display(metric.value), helper: metric.helper, tone: metric.tone };
      return !site && onSelect
        ? <MetricButton key={metric.id} {...props} selected={filter === metric.id} disabled={metric.value === null} onClick={() => onSelect(metric.id)} />
        : <MetricCard key={metric.id} {...props} />;
    })}
  </section>;
}
