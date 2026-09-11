import type { EnergyRankingItem } from "@led-control/shared/energy-analytics-contracts";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatKwh, formatWon } from "../statistics-format";

export function EnergyRankingDetailPanel({ item }: { item: EnergyRankingItem | null }) {
  if (!item) {
    return <aside className="ui-card statistics-ranking-detail" aria-label="순위 상세"><p>순위 항목을 선택해 주세요.</p></aside>;
  }
  const change = item.previousPeriod?.changeRatePercent ?? null;
  const ChangeIcon = change === null || change === 0 ? Minus : change < 0 ? ArrowDownRight : ArrowUpRight;
  return (
    <aside className="ui-card statistics-ranking-detail" aria-label={`${item.name} 상세`}>
      <header>
        <div><span className="eyebrow">상세 분석</span><h3>{item.name}</h3></div>
        <span className="statistics-ranking-rank">#{item.rank}</span>
      </header>
      <div className="statistics-detail-metrics">
        <div><span>사용량</span><strong>{item.estimatedKwh === null ? "—" : formatKwh(item.estimatedKwh)}</strong></div>
        <div><span>예상 비용</span><strong>{item.estimatedCost === null ? "—" : formatWon(item.estimatedCost)}</strong></div>
        <div><span>현장 기여도</span><strong>{item.contributionRate === null ? "—" : `${(item.contributionRate * 100).toFixed(1)}%`}</strong></div>
      </div>
      <p className="statistics-ranking-change" data-tone={change !== null && change > 0 ? "danger" : "success"}>
        <ChangeIcon size={16} aria-hidden="true" />
        이전 동일 기간 대비 {change === null ? "비교 불가" : `${change > 0 ? "+" : ""}${change.toFixed(1)}%`}
      </p>
      <div className="statistics-ranking-chart">
        <span className="sr-only" role="img" aria-label={`${item.name} 일별 사용량 차트`} />
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={item.dailyPoints} margin={{ top: 8, right: 10, bottom: 0, left: -18 }}>
            <CartesianGrid strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="period" tickFormatter={(value) => value.slice(5)} />
            <YAxis width={48} />
            <Tooltip formatter={(value) => [`${Number(value).toLocaleString("ko-KR")} kWh`, "사용량"]} />
            <Line type="monotone" dataKey="estimatedKwh" stroke="#2563eb" strokeWidth={2.5} connectNulls={false} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {item.fixtures.length > 0 ? (
        <div className="statistics-fixture-breakdown">
          <h4>조명별 구성</h4>
          <ul>{item.fixtures.slice(0, 8).map((fixture) => (
            <li key={fixture.identityId}><span>{fixture.name}</span><strong>{fixture.estimatedKwh === null ? "—" : formatKwh(fixture.estimatedKwh)}</strong></li>
          ))}</ul>
        </div>
      ) : null}
    </aside>
  );
}
