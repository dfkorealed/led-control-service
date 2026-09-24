import type { EnergyComparisonPoint, EnergyComparisonResponse } from "@led-control/shared";
import {
  Bar,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { StatusDetailButton, Text, themeColor } from "../../components/ui";
import {
  formatComparisonPeriod,
  formatCoverage,
  formatKwh,
  formatKwhValue,
  formatPercent
} from "./statistics-format";

interface ComparisonChartPoint extends EnergyComparisonPoint {
  observedKwh: number | null;
  forecastKwh: number | null;
}

export const forecastLineStyle = {
  strokeDasharray: "4 4",
  connectNulls: false
} as const;

export function comparisonChartData(points: EnergyComparisonPoint[]): ComparisonChartPoint[] {
  return points.map((point) => ({
    ...point,
    observedKwh: point.phase === "observed" ? point.estimatedKwh : null,
    forecastKwh: point.phase === "forecast" ? point.estimatedKwh : null
  }));
}

export function EnergyComparisonChart({ comparison }: { comparison: EnergyComparisonResponse }) {
  const data = comparisonChartData(comparison.points);
  const hasUnavailablePeriod = data.some((point) => point.phase === "unavailable");

  return (
    <>
      <div className="flex flex-wrap gap-3 text-caption font-bold text-content-secondary" aria-hidden="true">
        <span className="flex items-center gap-1.5 before:h-2 before:w-2 before:rounded-control before:bg-chart-baseline">기준 사용량</span>
        <span className="flex items-center gap-1.5 before:h-2 before:w-2 before:rounded-control before:bg-chart-usage">완료 기간 추정 사용량</span>
        <span className="flex items-center gap-1.5 before:h-2 before:w-2 before:rounded-control before:bg-chart-forecast">예상 사용량</span>
      </div>
      <div className="h-80 min-w-0 max-compact:h-64" role="img" aria-label="기준 대비 에너지 사용량 비교 차트">
        <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 760, height: 320 }}>
          <ComposedChart data={data} margin={{ top: 12, right: 12, left: 0, bottom: 8 }} accessibilityLayer>
            <CartesianGrid stroke={themeColor("chart-grid")} strokeDasharray="4 4" vertical={false} />
            <XAxis dataKey="period" tickFormatter={formatAxisPeriod} tickLine={false} />
            <YAxis unit=" kWh" width={74} tickLine={false} axisLine={false} />
            <Tooltip
              content={({ active, payload }) => (
                <ComparisonTooltip
                  active={active}
                  point={payload?.[0]?.payload as ComparisonChartPoint | undefined}
                />
              )}
            />
            <Bar dataKey="baselineKwh" name="기준 사용량" fill={themeColor("chart-baseline")} radius={[5, 5, 0, 0]} />
            <Line
              type="monotone"
              dataKey="observedKwh"
              name="완료 기간 추정 사용량"
              stroke={themeColor("chart-usage")}
              strokeWidth={3}
              dot={{ r: 4, fill: themeColor("chart-point"), strokeWidth: 2 }}
              activeDot={{ r: 6 }}
              connectNulls={false}
            />
            <Line
              type="monotone"
              dataKey="forecastKwh"
              name="예상 사용량"
              stroke={themeColor("chart-forecast")}
              strokeWidth={3}
              dot={{ r: 4, fill: themeColor("chart-point"), strokeWidth: 2 }}
              activeDot={{ r: 6 }}
              {...forecastLineStyle}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <Text variant="caption" tone="muted">24시간 100% · 현재 등록 조명 기준</Text>
        {hasUnavailablePeriod ? <StatusDetailButton label="산정 불가 기간" description="선이 없는 기간은 사용량을 산정할 수 없으며 기준 사용량만 표시합니다." /> : null}
      </div>
      <ul className="sr-only" aria-label="기준 대비 에너지 비교 데이터">
        {data.map((point) => <li key={point.period}>{describeComparisonPoint(point)}</li>)}
      </ul>
    </>
  );
}

function ComparisonTooltip({ active, point }: { active?: boolean; point?: ComparisonChartPoint }) {
  if (!active || !point) return null;
  const difference = point.estimatedKwh === null ? null : point.baselineKwh - point.estimatedKwh;

  return (
    <div className="grid gap-1 rounded-control border border-border-default bg-surface-elevated p-3 text-body-sm text-content-primary shadow-popover">
      <strong>{formatComparisonPeriod(point.period)}</strong>
      <span>기준 {formatKwh(point.baselineKwh)}</span>
      <span>{point.phase === "forecast" ? "예상" : "완료 기간 추정"} {point.estimatedKwh === null ? "산정 불가" : formatKwh(point.estimatedKwh)}</span>
      {difference === null ? null : <span>{formatDifference(difference)}</span>}
      {difference === null ? null : <span>{formatDifferenceRate(point.baselineKwh, difference)}</span>}
      <span>수집률 {formatCoverage(point.coverageRate)}</span>
    </div>
  );
}

function describeComparisonPoint(point: ComparisonChartPoint) {
  const period = formatComparisonPeriod(point.period);
  if (point.estimatedKwh === null) {
    return `${period}: 기준 ${formatKwh(point.baselineKwh)}, 사용량 산정 불가, 수집률 ${formatCoverage(point.coverageRate)}`;
  }
  const measurement = point.phase === "forecast" ? "예상" : "완료 기간 추정";
  const difference = point.baselineKwh - point.estimatedKwh;
  return `${period}: 기준 ${formatKwh(point.baselineKwh)}, ${measurement} ${formatKwh(point.estimatedKwh)}, ${formatDifference(difference)}, ${formatDifferenceRate(point.baselineKwh, difference)}, 수집률 ${formatCoverage(point.coverageRate)}`;
}

function formatDifference(difference: number) {
  return difference >= 0
    ? `절감 ${formatKwh(difference)}`
    : `초과 사용 ${formatKwh(Math.abs(difference))}`;
}

function formatDifferenceRate(baselineKwh: number, difference: number) {
  if (baselineKwh === 0) return "증감률 산정 불가";
  const rate = Math.abs(difference / baselineKwh * 100);
  return difference >= 0 ? `절감률 ${formatPercent(rate)}` : `초과율 ${formatPercent(rate)}`;
}

function formatAxisPeriod(period: string) {
  const [, month, day] = period.split("-");
  return day ? `${Number(month)}/${Number(day)}` : `${Number(month)}월`;
}
