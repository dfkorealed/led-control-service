import { InlineStatusSummary, type InlineStatusSummaryProps } from "../../components/ui";

interface MonitoringSummaryProps {
  scope: "site" | "floor";
  mapName?: string;
  total: number | null;
  online: number | null;
  fault: number | null;
  offline: number | null;
}

export function MonitoringSummary({ scope, mapName, total, online, fault, offline }: MonitoringSummaryProps) {
  const site = scope === "site";
  const metrics: InlineStatusSummaryProps["items"] = [
    { id: "all", label: site ? "현장 조명" : "전체 조명", value: total, tone: "info" },
    { id: "online", label: site ? "현장 정상" : "정상", value: online, tone: "success" },
    { id: "fault", label: site ? "현장 점검" : "점검 필요", value: fault, tone: "danger" },
    { id: "offline", label: site ? "현장 오프라인" : "오프라인", value: offline, tone: "neutral" }
  ];

  return <section
    className="min-w-0"
    role="region"
    aria-label={site ? "현장 전체 조명 현황" : "선택 층 조명 현황"}
    data-monitoring-summary={site ? undefined : ""}
    data-monitoring-site-summary={site ? "" : undefined}
  >
    <InlineStatusSummary label={site ? "현장 전체 집계" : `${mapName ?? "선택 층"} · 조명 현황`} items={metrics} />
  </section>;
}
