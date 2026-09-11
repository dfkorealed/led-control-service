import type { EnergyRankingItem, EnergyRankingMetric } from "@led-control/shared/energy-analytics-contracts";

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
    <section className="ui-card statistics-ranking-list" aria-label="사용량 순위">
      <header>
        <div><span className="eyebrow">순위</span><h3>에너지 사용 비교</h3></div>
        <span>{items.length}개 항목</span>
      </header>
      {items.length === 0 ? <p className="statistics-ranking-empty">순위를 계산할 수 있는 데이터가 없습니다.</p> : (
        <ol>
          {items.map((item) => (
            <li key={item.identityId}>
              <button
                type="button"
                className={selectedId === item.identityId ? "active" : ""}
                aria-pressed={selectedId === item.identityId}
                onClick={() => onSelect(item)}
              >
                <span className="statistics-ranking-position">{item.rank}</span>
                <span className="statistics-ranking-copy">
                  <strong>{item.name}</strong>
                  <small>{item.fixtureCount}개 조명 · 수집률 {formatPercent(item.coverageRate)}</small>
                  <span className="statistics-ranking-bar" aria-hidden="true">
                    <span style={{ width: `${Math.max(4, ((item.metricValue ?? 0) / max) * 100)}%` }} />
                  </span>
                </span>
                <span className="statistics-ranking-value">{formatMetric(item.metricValue, metric)}<small>{metricLabels[metric]}</small></span>
              </button>
            </li>
          ))}
        </ol>
      )}
      {unranked.length > 0 ? (
        <details className="statistics-unranked">
          <summary>순위 제외 {unranked.length}개</summary>
          <ul>{unranked.map((item) => <li key={item.identityId}>{item.name} · {reason(item)}</li>)}</ul>
        </details>
      ) : null}
    </section>
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
