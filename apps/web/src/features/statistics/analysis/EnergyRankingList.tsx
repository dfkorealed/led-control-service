import type { EnergyRankingItem, EnergyRankingMetric } from "@led-control/shared/energy-analytics-contracts";
import { Button, Card, Heading, Text } from "../../../components/ui";

const metricLabels: Record<EnergyRankingMetric, string> = {
  usage: "kWh",
  cost: "원",
  contribution: "%",
  per_fixture_average: "kWh/조명"
};

export function EnergyRankingList({
  items,
  unranked,
  metric,
  selectedId,
  onSelect
}: {
  items: EnergyRankingItem[];
  unranked: EnergyRankingItem[];
  metric: EnergyRankingMetric;
  selectedId: string | null;
  onSelect: (item: EnergyRankingItem) => void;
}) {
  const max = Math.max(...items.map((item) => item.metricValue ?? 0), 1);
  return (
    <Card className="grid min-w-0 gap-4 p-4 compact:p-6" aria-label="사용량 순위">
      <header className="flex items-start justify-between gap-3">
        <div className="grid gap-1"><Text variant="overline" tone="muted">순위</Text><Heading as="h3" variant="card-title">에너지 사용 비교</Heading></div>
        <Text as="span" variant="caption" tone="muted">{items.length}개 항목</Text>
      </header>
      {metric === "cost" ? <Text variant="body-sm" tone="muted">당시 적용 단가의 저장 비용</Text> : null}
      {items.length === 0 ? <Text tone="muted">순위를 계산할 수 있는 데이터가 없습니다.</Text> : (
        <ol className="grid list-none gap-2 p-0">
          {items.map((item) => (
            <li key={item.identityId}>
              <Button
                type="button"
                variant="ghost"
                className={`grid w-full grid-cols-[2rem_minmax(0,1fr)_auto] items-center gap-3 rounded-control border p-3 text-left ${selectedId === item.identityId ? "border-action-primary bg-action-primary-soft" : "border-border-default bg-surface-panel"}`}
                aria-pressed={selectedId === item.identityId}
                onClick={() => onSelect(item)}
              >
                <Text as="span" variant="body-lg" weight="bold" tone="primary" className="text-center">{item.rank}</Text>
                <span className="grid min-w-0 gap-1">
                  <Text as="strong" weight="bold" className="truncate">{item.name}</Text>
                  <Text as="small" variant="caption" tone="muted">{item.fixtureCount}개 조명 · 수집률 {formatPercent(item.coverageRate)}</Text>
                  <span className="h-1.5 overflow-hidden rounded-control bg-chart-grid" aria-hidden="true">
                    <span className="block h-full rounded-control bg-chart-ranking" style={{ width: `${Math.max(4, ((item.metricValue ?? 0) / max) * 100)}%` }} />
                  </span>
                </span>
                <span className="flex items-baseline gap-1 font-bold tabular-nums">{formatMetric(item.metricValue, metric)}<Text as="small" variant="caption" tone="muted" weight="bold">{metricLabels[metric]}</Text></span>
              </Button>
            </li>
          ))}
        </ol>
      )}
      {unranked.length > 0 ? (
        <details className="border-t border-border-default pt-3 text-body-sm text-content-muted">
          <summary className="min-h-11 cursor-pointer py-3 font-bold">순위 제외 {unranked.length}개</summary>
          <ul className="grid list-none gap-2 p-0">{unranked.map((item) => <li key={item.identityId}>{item.name} · {reason(item)}</li>)}</ul>
        </details>
      ) : null}
    </Card>
  );
}

function formatMetric(value: number | null, metric: EnergyRankingMetric) {
  if (value === null) return "—";
  if (metric === "cost") return Math.round(value).toLocaleString("ko-KR");
  if (metric === "contribution") return (value * 100).toFixed(1);
  return value.toLocaleString("ko-KR", { maximumFractionDigits: 4 });
}

function formatPercent(value: number | null) { return value === null ? "—" : `${Math.round(value * 100)}%`; }
function reason(item: EnergyRankingItem) {
  return item.unrankedReason === "legacy_structure_unknown" ? "구조 이력 부족" : "수집률 부족";
}
