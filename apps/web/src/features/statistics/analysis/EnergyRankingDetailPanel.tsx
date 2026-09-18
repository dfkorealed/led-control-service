import type { EnergyRankingItem } from "@led-control/shared/energy-analytics-contracts";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, Heading, MetricCard, Text, themeColor } from "../../../components/ui";
import { formatKwh, formatWon } from "../statistics-format";

export function EnergyRankingDetailPanel({ item }: { item: EnergyRankingItem | null }) {
  if (!item) {
    return <Card className="p-4 compact:p-6" role="complementary" aria-label="순위 상세"><Text tone="muted">순위 항목을 선택해 주세요.</Text></Card>;
  }
  const change = item.previousPeriod?.changeRatePercent ?? null;
  const ChangeIcon = change === null || change === 0 ? Minus : change < 0 ? ArrowDownRight : ArrowUpRight;
  return (
    <Card className="grid min-w-0 gap-4 p-4 compact:p-6" role="complementary" aria-label={`${item.name} 상세`}>
      <header className="flex items-start justify-between gap-3">
        <div className="grid gap-1"><Text variant="overline" tone="muted">상세 분석</Text><Heading as="h3" variant="card-title">{item.name}</Heading></div>
        <Text as="span" variant="label" tone="primary" className="rounded-control bg-action-primary-soft px-2 py-1">#{item.rank}</Text>
      </header>
      <div className="grid grid-cols-3 gap-3 max-compact:grid-cols-1">
        <MetricCard label="사용량" value={item.estimatedKwh === null ? "—" : formatKwh(item.estimatedKwh)} />
        <MetricCard label="저장 비용" value={item.estimatedCost === null ? "—" : formatWon(item.estimatedCost)} />
        <MetricCard label="현장 기여도" value={item.contributionRate === null ? "—" : `${(item.contributionRate * 100).toFixed(1)}%`} />
      </div>
      <Text className="flex items-center gap-2" variant="body-sm" weight="bold" tone={change !== null && change > 0 ? "danger" : "success"}>
        <ChangeIcon size={16} aria-hidden="true" />
        이전 동일 기간 대비 {change === null ? "비교 불가" : `${change > 0 ? "+" : ""}${change.toFixed(1)}%`}
      </Text>
      <div className="h-64 min-w-0">
        <span className="sr-only" role="img" aria-label={`${item.name} 일별 사용량 차트`} />
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={item.dailyPoints} margin={{ top: 8, right: 10, bottom: 0, left: -18 }}>
            <CartesianGrid stroke={themeColor("chart-grid")} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="period" tickFormatter={(value) => value.slice(5)} />
            <YAxis width={48} />
            <Tooltip formatter={(value) => [`${Number(value).toLocaleString("ko-KR")} kWh`, "사용량"]} />
            <Line type="monotone" dataKey="estimatedKwh" stroke={themeColor("chart-ranking")} strokeWidth={2.5} connectNulls={false} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {item.fixtures.length > 0 ? (
        <div className="grid gap-3 border-t border-border-default pt-3">
          <Heading as="h4" variant="card-title">조명별 구성</Heading>
          <ul className="grid list-none gap-2 p-0">{item.fixtures.slice(0, 8).map((fixture) => (
            <li className="flex justify-between gap-3 text-body-sm text-content-secondary" key={fixture.identityId}><span>{fixture.name}</span><strong className="text-content-primary tabular-nums">{fixture.estimatedKwh === null ? "—" : formatKwh(fixture.estimatedKwh)}</strong></li>
          ))}</ul>
        </div>
      ) : null}
    </Card>
  );
}
