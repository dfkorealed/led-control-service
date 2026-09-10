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
import { formatComparisonPeriod, formatCoverage, formatKwh, formatKwhValue } from "./statistics-format";

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

  return (
    <>
      <div className="comparison-chart-legend" aria-hidden="true">
        <span data-series="baseline">기준 사용량</span>
        <span data-series="observed">실제 사용량</span>
        <span data-series="forecast">예상 사용량</span>
      </div>
      <div className="energy-comparison-chart" role="img" aria-label="기준 대비 에너지 사용량 비교 차트">
        <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 760, height: 320 }}>
          <ComposedChart data={data} margin={{ top: 12, right: 12, left: 0, bottom: 8 }} accessibilityLayer>
            <CartesianGrid stroke="var(--border)" strokeDasharray="4 4" vertical={false} />
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
            <Bar dataKey="baselineKwh" name="기준 사용량" fill="var(--primary-soft)" radius={[5, 5, 0, 0]} />
            <Line
              type="monotone"
              dataKey="observedKwh"
              name="실제 사용량"
              stroke="var(--primary)"
              strokeWidth={3}
              dot={{ r: 4, fill: "#ffffff", strokeWidth: 2 }}
              activeDot={{ r: 6 }}
              connectNulls={false}
            />
            <Line
              type="monotone"
              dataKey="forecastKwh"
              name="예상 사용량"
              stroke="var(--warning)"
              strokeWidth={3}
              dot={{ r: 4, fill: "#ffffff", strokeWidth: 2 }}
              activeDot={{ r: 6 }}
              {...forecastLineStyle}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <ul className="sr-only" aria-label="기준 대비 에너지 비교 데이터">
        {data.map((point) => <li key={point.period}>{describeComparisonPoint(point)}</li>)}
      </ul>
      {data.some((point) => point.phase === "unavailable") ? (
        <p className="chart-coverage-summary">
          선이 없는 기간은 사용량을 산정할 수 없으며 기준 사용량만 표시합니다.
        </p>
      ) : null}
    </>
  );
}

function ComparisonTooltip({ active, point }: { active?: boolean; point?: ComparisonChartPoint }) {
  if (!active || !point) return null;
  const difference = point.estimatedKwh === null ? null : point.baselineKwh - point.estimatedKwh;

  return (
    <div className="energy-tooltip">
      <strong>{formatComparisonPeriod(point.period)}</strong>
      <span>기준 {formatKwh(point.baselineKwh)}</span>
      <span>{point.phase === "forecast" ? "예상" : "실제"} {point.estimatedKwh === null ? "산정 불가" : formatKwh(point.estimatedKwh)}</span>
      {difference === null ? null : <span>{formatDifference(difference)}</span>}
      <span>수집률 {formatCoverage(point.coverageRate)}</span>
    </div>
  );
}

function describeComparisonPoint(point: ComparisonChartPoint) {
  const period = formatComparisonPeriod(point.period);
  if (point.estimatedKwh === null) {
    return `${period}: 기준 ${formatKwh(point.baselineKwh)}, 사용량 산정 불가, 수집률 ${formatCoverage(point.coverageRate)}`;
  }
  const measurement = point.phase === "forecast" ? "예상" : "실제";
  return `${period}: 기준 ${formatKwh(point.baselineKwh)}, ${measurement} ${formatKwh(point.estimatedKwh)}, ${formatDifference(point.baselineKwh - point.estimatedKwh)}, 수집률 ${formatCoverage(point.coverageRate)}`;
}

function formatDifference(difference: number) {
  return difference >= 0
    ? `절감 ${formatKwh(difference)}`
    : `초과 사용 ${formatKwh(Math.abs(difference))}`;
}

function formatAxisPeriod(period: string) {
  const [, month, day] = period.split("-");
  return day ? `${Number(month)}/${Number(day)}` : `${Number(month)}월`;
}
