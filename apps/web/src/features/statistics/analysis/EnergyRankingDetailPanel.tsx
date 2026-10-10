import type { EnergyRankingItem } from "@led-control/shared/energy-analytics-contracts";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Card, Heading, MetricCard, Text, useThemeColors } from "../../../components/ui";
import { formatKwh, formatWon } from "../statistics-format";

export function EnergyRankingDetailPanel({ item }: { item: EnergyRankingItem | null }) {
  const palette = useThemeColors();
  if (!item) {
    return <Card className="p-4 compact:p-6" role="complementary" aria-label="순위 상세"><Text tone="muted">순위 항목을 선택해 주세요.</Text></Card>;
  }
  const change = item.previousPeriod?.changeRatePercent ?? null;
  const ChangeIcon = change === null || change === 0 ? Minus : change < 0 ? ArrowDownRight : ArrowUpRight;
  return (
    <Card className="grid min-w-0 grid-cols-1 gap-2 p-4 compact:p-5" role="complementary" aria-label={`${item.name} 상세`}>
      <header className="flex min-w-0 items-start justify-between gap-3">
        <div className="grid min-w-0 flex-1 gap-2"><Text variant="caption" tone="secondary">선택 대상 상세</Text><Heading as="h2" variant="customer-section-title" className="[overflow-wrap:anywhere]">{item.name}</Heading></div>
        <Text as="span" variant="label" tone="primary" className="shrink-0 rounded-control bg-action-primary-soft px-2 py-1">#{item.rank}</Text>
      </header>
      <div className="grid grid-cols-2 gap-3 max-compact:grid-cols-1">
        <MetricCard className="min-w-0 gap-1 p-2.5" label="사용량" value={item.estimatedKwh === null ? "—" : formatKwh(item.estimatedKwh)} />
        <MetricCard className="min-w-0 gap-1 p-2.5" label="저장 비용" value={item.estimatedCost === null ? "—" : formatWon(item.estimatedCost)} />
      </div>
      <dl className="m-0 grid gap-3 py-3 text-body-sm">
        <div className="flex flex-wrap justify-between gap-2 border-b border-border-default pb-3"><dt className="text-content-secondary">현장 기여도</dt><dd className="m-0 font-bold tabular-nums">{item.contributionRate === null ? "—" : `${(item.contributionRate * 100).toFixed(1)}%`}</dd></div>
        <div className="border-b border-border-default pb-3"><dt className="sr-only">이전 동일 기간 비교</dt><dd className="m-0">
          <Text className="flex items-center gap-2" variant="body-sm" weight="bold" tone={change === null || change === 0 ? "primary" : change > 0 ? "danger" : "success"}>
            <ChangeIcon size={16} aria-hidden="true" />
            이전 동일 기간 대비 {change === null ? "비교 불가" : `${change > 0 ? "+" : ""}${change.toFixed(1)}%`}
          </Text>
        </dd></div>
        <div className="flex flex-wrap justify-between gap-2"><dt className="text-content-secondary">수집률</dt><dd className="m-0 font-bold tabular-nums">{item.coverageRate === null ? "—" : `${Math.round(item.coverageRate * 100)}%`}</dd></div>
      </dl>
      <Text variant="caption" tone="secondary">일별 사용량 · 세로축 kWh</Text>
      <div className="h-36 min-w-0 compact:h-32">
        <span className="sr-only" role="img" aria-label={`${item.name} 일별 사용량 차트`} />
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={item.dailyPoints} margin={{ top: 8, right: 10, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={palette["chart-grid"]} strokeDasharray="3 3" vertical={false} />
            <XAxis dataKey="period" tickFormatter={(value) => value.slice(5)} tick={{ fill: palette["content-secondary"] }}
              tickLine={false} axisLine={{ stroke: palette["border-strong"] }} />
            <YAxis width={96} tickMargin={8} tickFormatter={(value: number) => Number(value).toLocaleString("ko-KR")}
              tick={{ fill: palette["content-secondary"] }} tickLine={false} axisLine={false} />
            <Tooltip formatter={(value) => [`${Number(value).toLocaleString("ko-KR")} kWh`, "사용량"]}
              cursor={{ stroke: palette["border-strong"] }}
              contentStyle={{ backgroundColor: palette["surface-elevated"], borderColor: palette["border-strong"], color: palette["content-primary"] }}
              itemStyle={{ color: palette["content-primary"] }} labelStyle={{ color: palette["content-secondary"] }} />
            <Line type="monotone" dataKey="estimatedKwh" stroke={palette["chart-ranking"]} strokeWidth={2.5}
              connectNulls={false} dot={false} activeDot={{ fill: palette["chart-ranking"], stroke: palette["chart-point"] }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {item.fixtures.length > 0 ? (
        <div className="grid min-w-0 gap-3 border-t border-border-default pt-3">
          <Heading as="h4" variant="card-title">조명별 구성</Heading>
          <ul className="grid min-w-0 list-none gap-1 p-0">{item.fixtures.slice(0, 8).map((fixture) => (
            <li className="flex min-w-0 justify-between gap-3 text-body-sm text-content-secondary" key={fixture.identityId}><span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{fixture.name}</span><strong className="shrink-0 whitespace-nowrap text-content-primary tabular-nums">{fixture.estimatedKwh === null ? "—" : formatKwh(fixture.estimatedKwh)}</strong></li>
          ))}</ul>
        </div>
      ) : null}
    </Card>
  );
}
