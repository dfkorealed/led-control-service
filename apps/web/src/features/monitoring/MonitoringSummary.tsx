import { MetricCard } from "../../components/ui";

interface MonitoringSummaryProps {
  scope: "site" | "floor";
  total: number | null;
  online: number | null;
  fault: number | null;
  offline: number | null;
}

const CARD_CLASS_NAME = "min-h-18 grid-cols-1 content-center gap-0! rounded-none! border-0! bg-surface-panel! px-4! py-1! [&>strong]:text-card-title! [&>strong>span]:text-card-title! max-compact:min-h-16 max-compact:px-2! max-compact:[&>p]:hidden max-compact:[&_[data-metric-label]]:text-label";

export function MonitoringSummary({ scope, total, online, fault, offline }: MonitoringSummaryProps) {
  const site = scope === "site";
  const display = (value: number | null) => value === null ? "집계 준비 중" : value;

  return <section
    className="grid grid-cols-2 gap-0.5 overflow-hidden rounded-panel border border-border-default bg-border-default phone-wide:grid-cols-4"
    role="region"
    aria-label={site ? "현장 전체 조명 현황" : "선택 층 조명 현황"}
    data-monitoring-summary={site ? undefined : ""}
    data-monitoring-site-summary={site ? "" : undefined}
  >
    <MetricCard className={CARD_CLASS_NAME} label={site ? "현장 조명" : "전체 조명"} value={display(total)} helper={site ? "현장 전체 기준" : "선택 층 기준"} tone="primary" />
    <MetricCard className={CARD_CLASS_NAME} label={site ? "현장 정상" : "정상"} value={display(online)} helper="최근 수신 정상" tone="success" />
    <MetricCard className={CARD_CLASS_NAME} label={site ? "현장 점검" : "점검 필요"} value={display(fault)} helper="우선 점검 대상" tone="danger" />
    <MetricCard className={CARD_CLASS_NAME} label={site ? "현장 오프라인" : "오프라인"} value={display(offline)} helper="상태 확인 대기 포함" />
  </section>;
}
