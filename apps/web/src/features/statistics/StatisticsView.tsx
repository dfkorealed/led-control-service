import type { EnergySeriesPoint, EnergySummary } from "@led-control/shared";
import { Activity, CircleCheck, CircleOff, TriangleAlert } from "lucide-react";
import { useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { useEnergySeries, useEnergySummary } from "../../api/energy";
import { Button, FeedbackState, MetricCard, PageHeader, StatusBadge } from "../../components/ui";
import { getEnergySeriesRanges } from "./statistics-periods";

type Granularity = "day" | "month";

type EnergyDataStatus = EnergySummary["today"]["dataStatus"];

const statusLabels: Record<EnergyDataStatus, string> = {
  available: "수집 완료",
  partial: "수집 공백 있음",
  no_data: "수집 데이터 없음"
};

const statusPresentation = {
  available: { tone: "success", icon: CircleCheck },
  partial: { tone: "warning", icon: TriangleAlert },
  no_data: { tone: "neutral", icon: CircleOff }
} as const;

export function StatisticsView({ siteId }: { siteId?: string }) {
  const [granularity, setGranularity] = useState<Granularity>("day");
  const summaryQuery = useEnergySummary(siteId);
  const ranges = summaryQuery.data
    ? getEnergySeriesRanges(summaryQuery.data.generatedAt, summaryQuery.data.timeZone)
    : null;
  const dayQuery = useEnergySeries({
    siteId,
    granularity: "day",
    from: ranges?.day.from ?? "",
    to: ranges?.day.to ?? "",
    enabled: Boolean(ranges)
  });
  const monthQuery = useEnergySeries({
    siteId,
    granularity: "month",
    from: ranges?.month.from ?? "",
    to: ranges?.month.to ?? "",
    enabled: Boolean(ranges)
  });

  if (!siteId || summaryQuery.isLoading) {
    return (
      <section className="statistics-screen">
        <FeedbackState
          icon={Activity}
          title="전력 통계를 불러오는 중"
          description="선택한 현장의 상태 기반 사용량을 집계하고 있습니다."
        />
      </section>
    );
  }
  if (summaryQuery.isError || !summaryQuery.data) {
    return (
      <section className="statistics-screen">
        <FeedbackState
          tone="danger"
          icon={TriangleAlert}
          title="전력 통계를 불러오지 못했습니다."
          action={<Button variant="secondary" onClick={() => summaryQuery.refetch()}>전력 통계 다시 시도</Button>}
        />
      </section>
    );
  }

  const summary = summaryQuery.data;
  const hasNoKnownData = summary.today.knownSeconds + summary.monthToDate.knownSeconds + summary.yearToDate.knownSeconds === 0;
  const hasPartialData = [summary.today, summary.monthToDate, summary.yearToDate]
    .some((period) => period.dataStatus === "partial");
  const activeSeries = granularity === "day" ? dayQuery : monthQuery;

  return (
    <section className="statistics-screen">
      <PageHeader
        title="에너지 리포트"
        description={(
          <p className="statistics-updated">
            {summary.timeZone} · 마지막 집계 {formatTimestamp(summary.lastAggregatedAt ?? summary.generatedAt, summary.timeZone)}
          </p>
        )}
        status={<StatusBadge tone="info" icon={Activity}>상태 기반 추정</StatusBadge>}
      />

      {hasNoKnownData ? (
        <FeedbackState
          icon={Activity}
          title="아직 상태 기반 사용량을 표시할 수 없습니다."
          description="조명 상태가 수집되면 통계가 표시됩니다."
        />
      ) : (
        <>
          {hasPartialData ? (
            <p className="statistics-coverage-notice" role="status">
              수집 공백이 있어 일부 기간은 추정값이 불완전할 수 있습니다.
            </p>
          ) : null}

          <div className="summary-row statistics-summary">
            <EnergyMetric label="오늘" period={summary.today} />
            <EnergyMetric label="이번 달 누적" period={summary.monthToDate} />
            <EnergyMetric label="올해 누적" period={summary.yearToDate} />
          </div>

          <div className="report-layout">
            <section className="panel chart-panel">
              <div className="panel-title-row statistics-chart-heading">
                <div>
                  <span className="eyebrow">사용량 추이</span>
                  <h3>상태 기반 추정 사용량</h3>
                </div>
                <div className="segmented-control" aria-label="사용량 조회 단위">
                  {(["day", "month"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={granularity === value ? "active" : ""}
                      aria-pressed={granularity === value}
                      onClick={() => setGranularity(value)}
                    >
                      {value === "day" ? "일별" : "월별"}
                    </button>
                  ))}
                </div>
              </div>
              <EnergyChartState granularity={granularity} query={activeSeries} />
            </section>

            <CostPanel summary={summary} />
          </div>
        </>
      )}
    </section>
  );
}

function EnergyMetric({ label, period }: { label: string; period: EnergySummary["today"] }) {
  const presentation = statusPresentation[period.dataStatus];

  return (
    <div className="statistics-metric">
      <MetricCard
        label={`${label} 전력 사용량`}
        value={formatKwhValue(period.estimatedKwh)}
        unit="kWh"
        helper={`${formatWon(period.estimatedCost)} · 상태 기반 추정`}
        tone={period.dataStatus === "available" ? "primary" : "neutral"}
        status={(
          <StatusBadge tone={presentation.tone} icon={presentation.icon}>
            {statusLabels[period.dataStatus]}
          </StatusBadge>
        )}
      />
    </div>
  );
}

function EnergyChartState({
  granularity,
  query
}: {
  granularity: Granularity;
  query: ReturnType<typeof useEnergySeries>;
}) {
  if (query.isLoading) {
    return (
      <div className="statistics-chart-state">
        <FeedbackState icon={Activity} title="사용량 추이를 불러오는 중" />
      </div>
    );
  }
  if (query.isError || !query.data) {
    return (
      <div className="statistics-chart-state">
        <FeedbackState
          tone="danger"
          icon={TriangleAlert}
          title="사용량 추이를 불러오지 못했습니다."
          action={<Button variant="secondary" onClick={() => query.refetch()}>사용량 추이 다시 시도</Button>}
        />
      </div>
    );
  }

  const points = query.data.points;
  if (!points.some((point) => point.estimatedKwh !== null)) {
    return (
      <div className="statistics-chart-state">
        <FeedbackState
          icon={CircleOff}
          title="선택한 기간의 사용량 데이터가 없습니다."
          description="수집 데이터가 있는 기간을 선택해 주세요."
        />
      </div>
    );
  }

  return (
    <>
      <div
        className="energy-line-chart"
        role="img"
        aria-label={`${granularity === "day" ? "일별" : "월별"} 상태 기반 추정 전력 사용량 꺾은선 차트`}
      >
        <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 760, height: 300 }}>
          <LineChart data={points} margin={{ top: 12, right: 12, left: 0, bottom: 8 }} accessibilityLayer>
            <CartesianGrid stroke="var(--border)" strokeDasharray="4 4" vertical={false} />
            <XAxis dataKey="period" tickFormatter={(value: string) => formatAxisPeriod(value, granularity)} tickLine={false} />
            <YAxis unit=" kWh" width={74} tickLine={false} axisLine={false} />
            <Tooltip
              content={({ active, payload }) => (
                <EnergyTooltip
                  active={active}
                  point={payload?.[0]?.payload as EnergySeriesPoint | undefined}
                  granularity={granularity}
                />
              )}
            />
            <Line
              type="monotone"
              dataKey="estimatedKwh"
              name="사용량"
              stroke="var(--primary)"
              strokeWidth={3}
              dot={{ r: 4, fill: "#ffffff", strokeWidth: 2 }}
              activeDot={{ r: 6 }}
              connectNulls={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <ul className="sr-only" aria-label="차트 데이터 및 수집 상태">
        {points.map((point) => <li key={point.period}>{describePoint(point, granularity)}</li>)}
      </ul>
      {points.some((point) => point.dataStatus !== "available") ? (
        <p className="chart-coverage-summary">
          선이 끊긴 기간은 수집 데이터가 없으며, 수집 공백이 있는 기간은 추정값이 불완전할 수 있습니다.
        </p>
      ) : null}
    </>
  );
}

function EnergyTooltip({
  active,
  point,
  granularity
}: {
  active?: boolean;
  point?: EnergySeriesPoint;
  granularity: Granularity;
}) {
  if (!active || !point) return null;
  return (
    <div className="energy-tooltip">
      <strong>{formatPeriod(point.period, granularity)}</strong>
      <span>{point.estimatedKwh === null ? "사용량 데이터 없음" : formatKwh(point.estimatedKwh)}</span>
      <span>{point.estimatedCost === null ? "비용 데이터 없음" : formatWon(point.estimatedCost)}</span>
      <span>{statusLabels[point.dataStatus]}</span>
      {point.unknownSeconds > 0 ? <span>수집 공백 {formatDuration(point.unknownSeconds)}</span> : null}
    </div>
  );
}

function CostPanel({ summary }: { summary: EnergySummary }) {
  const unavailableMessage = summary.monthForecast.reason === "no_registered_fixture"
    ? "등록된 조명이 없어 예상 비용과 절감액을 계산할 수 없습니다."
    : "상태 수집 시간이 부족하여 예상 비용과 절감액을 계산할 수 없습니다.";

  return (
    <aside className="panel insight-panel statistics-cost-panel">
      <div>
        <span className="eyebrow">예상 요금</span>
        <h3>이번 달 비용 비교</h3>
      </div>
      {summary.monthForecast.reason === "available"
        && summary.monthForecast.estimatedKwh !== null
        && summary.monthForecast.estimatedCost !== null
        && summary.estimatedSavings.kwh !== null
        && summary.estimatedSavings.cost !== null ? (
          <dl className="statistics-cost-list">
            <div className="statistics-cost-item">
              <dt>이번 달 예상 비용</dt>
              <dd>{formatWon(summary.monthForecast.estimatedCost)}</dd>
              <small>{formatKwh(summary.monthForecast.estimatedKwh)}</small>
            </div>
            <div className="statistics-cost-item">
              <dt>24시간 100% 기준 비용</dt>
              <dd>{formatWon(summary.baseline24Hours.estimatedCost)}</dd>
              <small>{formatKwh(summary.baseline24Hours.estimatedKwh)}</small>
            </div>
            <div
              className="statistics-cost-item statistics-savings"
              data-tone={summary.estimatedSavings.cost < 0 ? "danger" : "neutral"}
            >
              <dt>예상 절감</dt>
              <dd>{formatWon(summary.estimatedSavings.cost)}</dd>
              <small>{formatKwh(summary.estimatedSavings.kwh)}</small>
            </div>
          </dl>
        ) : <p className="statistics-unavailable">{unavailableMessage}</p>}
      <p className="statistics-baseline-note">
        현재 등록 조명 {summary.baseline24Hours.fixtureCount}개 · 해당 월 {summary.baseline24Hours.daysInMonth}일 전체 · 24시간 · 100% 밝기 · 현재 단가 기준
      </p>
    </aside>
  );
}

function describePoint(point: EnergySeriesPoint, granularity: Granularity) {
  const period = formatPeriod(point.period, granularity);
  if (point.estimatedKwh === null) return `${period}: 수집 데이터 없음`;
  const gap = point.unknownSeconds > 0 ? `, 수집 공백 ${formatDuration(point.unknownSeconds)}` : "";
  return `${period}: ${formatKwh(point.estimatedKwh)}, ${formatWon(point.estimatedCost ?? 0)}${gap}`;
}

function formatPeriod(period: string, granularity: Granularity) {
  const [year, month, day] = period.split("-").map(Number);
  return granularity === "day" ? `${year}년 ${month}월 ${day}일` : `${year}년 ${month}월`;
}

function formatAxisPeriod(period: string, granularity: Granularity) {
  const [, month, day] = period.split("-");
  return granularity === "day" ? `${Number(month)}/${Number(day)}` : `${Number(month)}월`;
}

function formatTimestamp(timestamp: string, timeZone: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit"
  }).format(new Date(timestamp));
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}

function formatKwh(value: number) {
  return `${formatKwhValue(value)} kWh`;
}

function formatKwhValue(value: number) {
  return new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 3 }).format(value);
}

function formatWon(value: number) {
  return `${new Intl.NumberFormat("ko-KR", { maximumFractionDigits: 0 }).format(value)}원`;
}
