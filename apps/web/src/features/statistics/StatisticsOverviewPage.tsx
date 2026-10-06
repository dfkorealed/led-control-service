import type { EnergyComparisonPreset, EnergySeriesPoint, EnergySummary } from "@led-control/shared";
import { energyRangeComparisonQuerySchema } from "@led-control/shared/energy-range-contracts";
import { Activity, CircleCheck, CircleOff, TriangleAlert, TrendingDown, TrendingUp } from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useOutletContext } from "react-router-dom";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from "recharts";
import { useEnergyComparison, useEnergyRangeComparison, useEnergySeries, useEnergySummary } from "../../api/energy";
import { Button, Card, DateRangePicker, FeedbackState, FilterPanel, formatTimestamp, Heading, MetricCard, SidePanel, StatusBadge, Text, themeColor, useDateRangeDraft } from "../../components/ui";
import { draftToDate } from "../../components/ui/date/useDateDraft";
import { EnergyComparisonChart } from "./EnergyComparisonChart";
import { PeriodComparisonPanel } from "./PeriodComparisonPanel";
import { comparisonPresentation } from "./statistics-comparison";
import { formatKwh, formatKwhValue, formatWon } from "./statistics-format";
import { getEnergySeriesRanges } from "./statistics-periods";
import type { StatisticsOutletContext } from "./StatisticsShell";

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

export function StatisticsOverviewPage() {
  const { siteId } = useOutletContext<StatisticsOutletContext>();
  const [granularity, setGranularity] = useState<Granularity>("day");
  const [comparisonPreset, setComparisonPreset] = useState<EnergyComparisonPreset>("current_month");
  const [customRange, setCustomRange] = useState<{ siteId: string; from: string; to: string } | null>(null);
  const [customActive, setCustomActive] = useState(false);
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const isCustomActive = customActive && customRange?.siteId === siteId;
  const summaryQuery = useEnergySummary(siteId);
  const lastCompletedDate = summaryQuery.data ? shiftDate(formatSiteDate(summaryQuery.data.generatedAt, summaryQuery.data.timeZone), -1) : "";
  const initialRange = lastCompletedDate ? draftForPreset("current_month", lastCompletedDate) : null;
  const rangeDraft = useDateRangeDraft(`${siteId}|${lastCompletedDate}`, initialRange ? { start: initialRange.from, end: initialRange.to } : null);
  const draftRange = { from: draftToDate(rangeDraft.draft.start) ?? "", to: draftToDate(rangeDraft.draft.end) ?? "" };
  const presetComparisonQuery = useEnergyComparison(siteId, comparisonPreset, !isCustomActive);
  const customComparisonQuery = useEnergyRangeComparison(siteId, customRange?.from ?? "", customRange?.to ?? "", isCustomActive);
  const comparisonQuery = isCustomActive ? customComparisonQuery : presetComparisonQuery;
  useEffect(() => { setCustomActive(false); setShowCustomPicker(false); }, [siteId]);
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
      <section className="grid min-w-0 gap-6">
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
      <section className="grid min-w-0 gap-6">
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
  const siteDate = formatSiteDate(summary.generatedAt, summary.timeZone);
  const validDraftRange = draftRange.to <= lastCompletedDate &&
    energyRangeComparisonQuerySchema.safeParse(draftRange).success;
  const currentRangeLabel = comparisonQuery.data
    ? `${comparisonQuery.data.range.from} ~ ${comparisonQuery.data.range.to}`
    : isCustomActive && customRange ? `${customRange.from} ~ ${customRange.to}`
      : comparisonPresetOptions.find((option) => option.value === comparisonPreset)?.label ?? "선택 전";
  const customPicker = (
      <div className="grid gap-4">
        <Button variant="primary" isDisabled={!validDraftRange} onClick={() => {
          setCustomRange({ ...draftRange, siteId });
          setCustomActive(true);
          setShowCustomPicker(false);
        }}>선택 기간 적용</Button>
        <Text variant="body-sm" tone="secondary">완료된 날짜만 절감 비교에 포함합니다. 오늘 진행 중인 집계와 이번 달 비용 전망은 아래 별도 영역에 유지됩니다.</Text>
        <div className="flex flex-wrap gap-2" role="group" aria-label="빠른 기간 선택">
          {comparisonPresetOptions.map((option) => {
            const range = draftForPreset(option.value, lastCompletedDate);
            return <Button key={option.value} size="sm" variant="secondary"
              aria-pressed={draftRange.from === range.from && draftRange.to === range.to}
              onClick={() => rangeDraft.reset({ start: range.from, end: range.to })}>{option.label}</Button>;
          })}
        </div>
        <DateRangePicker label="완료 기간 시작일과 종료일" draftController={rangeDraft} autoFocus
          value={draftRange.from && draftRange.to ? { start: draftRange.from, end: draftRange.to } : null}
          maxValue={lastCompletedDate} onChange={() => {}} />
        <Text variant="caption" tone="secondary">현장 시간대 {summary.timeZone} · 마지막 완료일 {lastCompletedDate} · 1~400일</Text>
        {!validDraftRange ? <p role="alert" className="m-0 text-body-sm text-status-danger-foreground">시작일과 종료일을 완료된 1~400일 범위로 선택해 주세요.</p> : null}
      </div>
  );
  const todayRangeLabel = formatTodayRangeLabel(summary, siteDate);
  const hasNoKnownData = summary.today.knownSeconds + summary.monthToDate.knownSeconds + summary.yearToDate.knownSeconds === 0;
  const activeSeries = granularity === "day" ? dayQuery : monthQuery;
  const seriesHasMissing = activeSeries.data?.points.some((point) => point.dataStatus === "no_data") ?? false;
  const seriesHasPartial = activeSeries.data?.points.some((point) => point.dataStatus === "partial") ?? false;
  const seriesGapLabel = seriesHasMissing && seriesHasPartial ? "결측·수집 공백"
    : seriesHasMissing ? "결측 포함" : seriesHasPartial ? "수집 공백" : null;
  const seriesGapExplanation = seriesHasMissing && seriesHasPartial
    ? "선이 끊긴 기간은 수집 데이터가 없으며, 수집 공백이 있는 기간은 추정값이 불완전할 수 있습니다."
    : seriesHasMissing ? "선이 끊긴 기간은 수집 데이터가 없습니다."
      : "수집 공백이 있는 기간은 추정값이 불완전할 수 있습니다.";
  const retrySeriesButton = (
    <Button variant="secondary" onClick={() => activeSeries.refetch()}>
      사용량 추이 다시 시도
    </Button>
  );
  const chart = activeSeries.isLoading ? (
    <div className="grid min-h-64 place-items-center">
      <FeedbackState icon={Activity} title="사용량 추이를 불러오는 중" />
    </div>
  ) : activeSeries.isError || !activeSeries.data ? (
    <div className="grid min-h-64 place-items-center">
      <FeedbackState
        tone="danger"
        icon={TriangleAlert}
        title="사용량 추이를 불러오지 못했습니다."
        action={retrySeriesButton}
      />
    </div>
  ) : !activeSeries.data.points.some((point) => point.dataStatus !== "no_data" && point.estimatedKwh !== null) ? (
    <div className="grid min-h-64 place-items-center">
      <FeedbackState
        icon={CircleOff}
        title="선택한 기간의 사용량 데이터가 없습니다."
        description="수집 데이터가 있는 기간을 선택해 주세요."
      />
    </div>
  ) : (
    <EnergyChart granularity={granularity} points={activeSeries.data.points} />
  );
  const unavailableMessage = summary.monthForecast.reason === "no_registered_fixture"
    ? "등록된 조명이 없어 예상 비용과 절감액을 계산할 수 없습니다."
    : "상태 수집 시간이 부족하여 예상 비용과 절감액을 계산할 수 없습니다.";
  const costRows = summary.monthForecast.reason === "available"
    && summary.monthForecast.estimatedKwh !== null
    && summary.monthForecast.estimatedCost !== null
    && summary.estimatedSavings.kwh !== null
    && summary.estimatedSavings.cost !== null ? (
      <dl className="grid gap-3">
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 rounded-control bg-surface-inset p-3">
          <dt className="text-body-sm font-bold text-content-secondary">이번 달 예상 비용</dt>
          <dd className="m-0 text-card-title font-bold text-content-primary tabular-nums">{formatWon(summary.monthForecast.estimatedCost)}</dd>
          <small className="col-span-full text-caption text-content-muted tabular-nums">{formatKwh(summary.monthForecast.estimatedKwh)}</small>
        </div>
        <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 rounded-control bg-surface-inset p-3">
          <dt className="text-body-sm font-bold text-content-secondary">24시간 100% 기준 비용</dt>
          <dd className="m-0 text-card-title font-bold text-content-primary tabular-nums">{formatWon(summary.baseline24Hours.estimatedCost)}</dd>
          <small className="col-span-full text-caption text-content-muted tabular-nums">{formatKwh(summary.baseline24Hours.estimatedKwh)}</small>
        </div>
        <div
          className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 rounded-control bg-surface-inset p-3 data-[tone=danger]:text-status-danger-foreground"
          data-tone={summary.estimatedSavings.cost < 0 ? "danger" : "neutral"}
        >
          <dt className="text-body-sm font-bold text-content-secondary">예상 절감</dt>
          <dd className="m-0 text-card-title font-bold tabular-nums">{formatWon(summary.estimatedSavings.cost)}</dd>
          <small className="col-span-full text-caption tabular-nums">{formatKwh(summary.estimatedSavings.kwh)}</small>
        </div>
      </dl>
    ) : <Text variant="body-sm" tone="muted">{unavailableMessage}</Text>;

  return (
    <section className="grid min-w-0 gap-5" aria-label="에너지 통계">
      <ComparisonSection
        preset={comparisonPreset}
        onPresetChange={(preset) => { setComparisonPreset(preset); setCustomActive(false); setShowCustomPicker(false); }}
        customActive={isCustomActive}
        currentRangeLabel={currentRangeLabel}
        isOpen={showCustomPicker}
        onOpenChange={setShowCustomPicker}
        onReset={() => { setComparisonPreset("current_month"); setCustomActive(false); rangeDraft.reset(initialRange ? { start: initialRange.from, end: initialRange.to } : null); }}
        customPicker={customPicker}
        query={comparisonQuery}
      />

      <section className="grid min-w-0 gap-4 border-t border-border-default pt-5" aria-labelledby="statistics-current-title">
        <div className="flex min-w-0 flex-wrap items-start justify-between gap-3">
          <div className="grid min-w-0 gap-1">
            <Heading as="h3" variant="section-title" id="statistics-current-title">오늘 사용량과 비용</Heading>
            <Text variant="body-sm" tone="secondary">
              {summary.timeZone} · {summary.lastAggregatedAt
                ? `마지막 집계 ${formatTimestamp(summary.lastAggregatedAt, { timeZone: summary.timeZone })}`
                : `마지막 집계 확인 불가 · 조회 ${formatTimestamp(summary.generatedAt, { timeZone: summary.timeZone })}`}
            </Text>
          </div>
        </div>
      {hasNoKnownData ? (
        <FeedbackState
          icon={Activity}
          title="아직 상태 기반 사용량을 표시할 수 없습니다."
          description="조명 상태가 수집되면 통계가 표시됩니다."
        />
      ) : (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-4" role="group" aria-label="에너지 요약">
            <EnergyMetric label="오늘" period={summary.today} periodLabel={todayRangeLabel} />
            <EnergyMetric label="이번 달 누적" period={summary.monthToDate} periodLabel={`${siteDate.slice(0, 7)}-01 ~ ${siteDate}`} />
            <EnergyMetric label="올해 누적" period={summary.yearToDate} periodLabel={`${siteDate.slice(0, 4)}-01-01 ~ ${siteDate}`} />
          </div>
          <Text variant="body-sm" tone="muted">누적·일별·월별 비용은 당시 적용 단가의 저장 비용입니다.</Text>

          <div className="grid min-w-0 grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)] gap-4 max-compact:grid-cols-1" role="group" aria-label="사용량 및 비용">
            <Card className="grid min-w-0 gap-4 p-4 compact:p-6" aria-label="상태 기반 추정 사용량">
              <div className="flex items-start justify-between gap-4 max-compact:flex-col max-compact:items-stretch">
                <div className="grid gap-1">
                  <Text variant="overline" tone="muted">사용량 추이</Text>
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <Heading as="h3" variant="card-title">상태 기반 추정 사용량</Heading>
                    {seriesGapLabel && !activeSeries.isLoading && !activeSeries.isError ? (
                      <StatusBadge tone="warning" icon={TriangleAlert} title={seriesGapExplanation} aria-label={`${seriesGapLabel}: ${seriesGapExplanation}`}>
                        {seriesGapLabel}
                      </StatusBadge>
                    ) : null}
                  </div>
                  <Text variant="caption" tone="secondary">
                    {activeSeries.data?.from ?? ranges?.[granularity].from} ~ {activeSeries.data?.to ?? ranges?.[granularity].to}
                  </Text>
                </div>
                <FilterPanel label="사용량 조회 단위" mode="popover" activeFilterCount={Number(granularity !== "day")}
                  summary={<Text variant="caption">{granularity === "day" ? "일별" : "월별"}</Text>}
                  filterReset={<Button size="sm" variant="secondary" onClick={() => setGranularity("day")}>필터 초기화</Button>}>
                <div className="flex gap-2" aria-label="사용량 조회 단위 선택">
                  {(["day", "month"] as const).map((value) => (
                    <Button
                      key={value}
                      type="button"
                      size="sm"
                      variant={granularity === value ? "primary" : "secondary"}
                      className="max-compact:flex-1"
                      aria-pressed={granularity === value}
                      onClick={() => setGranularity(value)}
                    >
                      {value === "day" ? "일별" : "월별"}
                    </Button>
                  ))}
                </div>
                </FilterPanel>
              </div>
              {chart}
            </Card>

            <SidePanel className="grid min-w-0 gap-4 p-4 compact:p-6" aria-label="비용 비교">
              <div className="grid gap-1">
                <Text variant="overline" tone="muted">예상 요금</Text>
                <Heading as="h3" variant="card-title">이번 달 비용 비교</Heading>
              </div>
              {costRows}
              <Text variant="body-sm" tone="muted">예상·기준·절감 비용은 현재 설정 단가 기준입니다.</Text>
              <Text variant="caption" tone="muted">
                현재 등록 조명 {summary.baseline24Hours.fixtureCount}개 · 해당 월 {summary.baseline24Hours.daysInMonth}일 전체 · 24시간 · 100% 밝기 · 현재 단가 기준
              </Text>
            </SidePanel>
          </div>
        </>
      )}
      </section>
    </section>
  );
}

const comparisonPresetOptions: Array<{ value: EnergyComparisonPreset; label: string }> = [
  { value: "last_7_days", label: "최근 7일" },
  { value: "current_month", label: "이번 달" },
  { value: "current_year", label: "올해" }
];

function ComparisonSection({
  preset,
  onPresetChange,
  customActive,
  currentRangeLabel,
  isOpen,
  onOpenChange,
  onReset,
  customPicker,
  query
}: {
  preset: EnergyComparisonPreset;
  onPresetChange: (preset: EnergyComparisonPreset) => void;
  customActive: boolean;
  currentRangeLabel: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onReset: () => void;
  customPicker: ReactNode;
  query: ReturnType<typeof useEnergyComparison> | ReturnType<typeof useEnergyRangeComparison>;
}) {
  let content;
  if (query.isLoading) {
    content = <FeedbackState icon={Activity} title="절감 비교를 불러오는 중" />;
  } else if (query.isError || !query.data) {
    content = (
      <FeedbackState
        tone="danger"
        icon={TriangleAlert}
        title="절감 비교를 불러오지 못했습니다."
        action={<Button variant="secondary" onClick={() => query.refetch()}>절감 비교 다시 시도</Button>}
      />
    );
  } else {
    const presentation = comparisonPresentation(query.data.summary);
    const isAvailable = presentation.ratePercent !== null
      && presentation.savingsKwh !== null
      && presentation.savingsCost !== null
      && query.data.summary.estimatedKwh !== null;
    const SavingsIcon = presentation.tone === "danger" ? TrendingUp : TrendingDown;
    const savingsPrefix = presentation.tone === "danger" ? "기준 초과" : "예상 절감";

    content = (
      <div className="grid min-w-0 gap-4 max-compact:gap-2">
        <Text variant="caption" tone="secondary" className="compact:hidden">상태 기반 추정 {query.data.summary.estimatedKwh === null ? "산정 대기" : formatKwh(query.data.summary.estimatedKwh)} · 기준 {formatKwh(query.data.summary.baselineKwh)} · {presentation.label}{query.data.points.some(point => point.dataStatus === "partial") ? " · 수집 공백 있음" : query.data.points.some(point => point.dataStatus === "no_data") ? " · 수집 데이터 없음" : ""}</Text>
        {isAvailable ? (
          <div className="grid grid-cols-4 gap-3 tablet:grid-cols-4 max-compact:grid-cols-1 max-compact:order-2">
            <div className="min-w-0">
              <MetricCard
                label={presentation.label}
                value={formatKwhValue(presentation.ratePercent!)}
                unit="%"
                helper={presentation.description}
                tone={presentation.tone}
                status={(
                  <StatusBadge tone={presentation.tone} icon={SavingsIcon}>
                    {presentation.tone === "danger" ? "초과 사용" : "절감 중"}
                  </StatusBadge>
                )}
              />
            </div>
            <div className="min-w-0">
              <MetricCard
                label="예상 사용량"
                value={formatKwhValue(query.data.summary.estimatedKwh!)}
                unit="kWh"
                helper={`기준 ${formatKwh(query.data.summary.baselineKwh)}`}
                tone="primary"
              />
            </div>
            <div className="min-w-0">
              <MetricCard
                label={`${savingsPrefix} 전력`}
                value={formatKwhValue(Math.abs(presentation.savingsKwh!))}
                unit="kWh"
                helper="24시간 100% 운전 기준"
                tone={presentation.tone}
              />
            </div>
            <div className="min-w-0">
              <MetricCard
                label={`${savingsPrefix} 비용`}
                value={formatWon(Math.abs(presentation.savingsCost!))}
                helper="현재 설정 단가 기준"
                tone={presentation.tone}
              />
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-2 gap-3 max-compact:grid-cols-1 max-compact:order-2">
            <div className="min-w-0">
              <MetricCard
                label="기준 사용량"
                value={formatKwhValue(query.data.summary.baselineKwh)}
                unit="kWh"
                helper="24시간 100% 운전 기준"
              />
            </div>
            <FeedbackState icon={CircleOff} title="절감률 산정 대기" description={presentation.description} />
          </div>
        )}
        <div className="grid min-w-0 grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)] gap-4 max-compact:grid-cols-1" role="group" aria-label="기준 및 동기간 비교">
          <Card className="grid min-w-0 gap-4 p-4 compact:p-6" aria-label="기준 대비 사용량 비교">
            <div className="grid gap-1">
              <Text variant="overline" tone="muted" className="max-compact:hidden">기준 대비 추세</Text>
              <Heading as="h3" variant="card-title">완료 기간 추정·예상 사용량 비교</Heading>
            </div>
            <EnergyComparisonChart comparison={query.data} />
          </Card>
          <PeriodComparisonPanel comparisons={query.data.priorComparisons} />
        </div>
      </div>
    );
  }

  return (
    <section className="grid min-w-0 gap-4 max-compact:gap-2" aria-labelledby="statistics-comparison-title">
      <div className="flex min-w-0 items-start justify-between gap-4">
        <div className="grid gap-1 max-compact:sr-only">
          <Heading as="h3" variant="section-title" id="statistics-comparison-title">기준 대비 에너지 절감</Heading>
          {query.data && !query.isError ? <Text variant="caption" tone="secondary">
            {query.data.range.from} ~ {query.data.range.to}
          </Text> : null}
        </div>
        <FilterPanel label="절감 비교 기간" mode="popover" className="max-compact:w-full max-compact:flex-row max-compact:items-center max-compact:[&>div:first-child]:shrink-0 max-compact:[&>div:nth-child(2)]:flex-1" isOpen={isOpen} onOpenChange={onOpenChange}
          activeFilterCount={Number(customActive || preset !== "current_month")} summary={<Text variant="caption">{currentRangeLabel}</Text>}
          >
        <div className="flex flex-wrap gap-2" role="group" aria-label="절감 비교 프리셋">
          {comparisonPresetOptions.map((option) => (
            <Button
              key={option.value}
              type="button"
              size="sm"
              variant={!customActive && preset === option.value ? "primary" : "secondary"}
              className="max-compact:flex-1"
              aria-pressed={!customActive && preset === option.value}
              onClick={() => onPresetChange(option.value)}
            >
              {option.label}
            </Button>
          ))}
        </div>
        {customPicker}
        <Button size="sm" variant="secondary" onClick={onReset}>필터 초기화</Button>
        </FilterPanel>
      </div>
      {content}
    </section>
  );
}

function EnergyMetric({ label, period, periodLabel }: { label: string; period: EnergySummary["today"]; periodLabel: string }) {
  const presentation = statusPresentation[period.dataStatus];

  return (
    <div className="min-w-0">
      <MetricCard
        label={`${label} 전력 사용량`}
        value={period.dataStatus === "no_data" ? "—" : formatKwhValue(period.estimatedKwh)}
        unit={period.dataStatus === "no_data" ? undefined : "kWh"}
        helper={period.dataStatus === "no_data" ? periodLabel : `${formatWon(period.estimatedCost)} · 상태 기반 추정 · ${periodLabel}`}
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

function EnergyChart({
  granularity,
  points
}: {
  granularity: Granularity;
  points: EnergySeriesPoint[];
}) {
  // A no-data status must never draw a zero-valued point, even if a payload includes numeric zero.
  const chartPoints = points.map((point) => point.dataStatus === "no_data"
    ? { ...point, estimatedKwh: null, estimatedCost: null }
    : point);
  return (
    <>
      <div
        className="h-72 min-w-0 max-compact:h-64"
        role="img"
        aria-label={`${granularity === "day" ? "일별" : "월별"} 상태 기반 추정 전력 사용량 꺾은선 차트`}
      >
        <ResponsiveContainer width="100%" height="100%" minWidth={0} initialDimension={{ width: 760, height: 300 }}>
          <LineChart data={chartPoints} margin={{ top: 12, right: 12, left: 0, bottom: 8 }} accessibilityLayer>
            <CartesianGrid stroke={themeColor("chart-grid")} strokeDasharray="4 4" vertical={false} />
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
              stroke={themeColor("chart-usage")}
              strokeWidth={3}
              dot={{ r: 4, fill: themeColor("chart-point"), strokeWidth: 2 }}
              activeDot={{ r: 6 }}
              connectNulls={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <ul className="sr-only" aria-label="차트 데이터 및 수집 상태">
        {chartPoints.map((point) => <li key={point.period}>{describePoint(point, granularity)}</li>)}
      </ul>
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
    <div className="grid gap-1 rounded-control border border-border-default bg-surface-elevated p-3 text-body-sm text-content-primary shadow-popover">
      <strong>{formatPeriod(point.period, granularity)}</strong>
      <span>{point.estimatedKwh === null ? "사용량 데이터 없음" : formatKwh(point.estimatedKwh)}</span>
      <span>{point.estimatedCost === null ? "비용 데이터 없음" : formatWon(point.estimatedCost)}</span>
      <span>{statusLabels[point.dataStatus]}</span>
      {point.unknownSeconds > 0 ? <span>수집 공백 {formatDuration(point.unknownSeconds)}</span> : null}
    </div>
  );
}

function describePoint(point: EnergySeriesPoint, granularity: Granularity) {
  const period = formatPeriod(point.period, granularity);
  if (point.dataStatus === "no_data" || point.estimatedKwh === null) return `${period}: 수집 데이터 없음`;
  const gap = point.unknownSeconds > 0 ? `, 수집 공백 ${formatDuration(point.unknownSeconds)}` : "";
  return `${period}: ${formatKwh(point.estimatedKwh)}, ${point.estimatedCost === null ? "비용 데이터 없음" : formatWon(point.estimatedCost)}${gap}`;
}

function formatPeriod(period: string, granularity: Granularity) {
  const [year, month, day] = period.split("-").map(Number);
  return granularity === "day" ? `${year}년 ${month}월 ${day}일` : `${year}년 ${month}월`;
}

function formatAxisPeriod(period: string, granularity: Granularity) {
  const [, month, day] = period.split("-");
  return granularity === "day" ? `${Number(month)}/${Number(day)}` : `${Number(month)}월`;
}

function formatSiteDate(timestamp: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function shiftDate(date: string, days: number) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function draftForPreset(preset: EnergyComparisonPreset, lastCompletedDate: string) {
  const from = preset === "last_7_days" ? shiftDate(lastCompletedDate, -6)
    : preset === "current_month" ? `${lastCompletedDate.slice(0, 7)}-01`
      : `${lastCompletedDate.slice(0, 4)}-01-01`;
  return { from, to: lastCompletedDate };
}

function formatSiteClock(timestamp: string, timeZone: string) {
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).format(new Date(timestamp));
}

function formatTodayRangeLabel(summary: EnergySummary, siteDate: string) {
  if (!summary.lastAggregatedAt) return "오늘 00:00~집계 시각 확인 불가 · 진행 중";
  if (formatSiteDate(summary.lastAggregatedAt, summary.timeZone) !== siteDate) {
    return "오늘 00:00~오늘 집계 시각 확인 불가 · 진행 중";
  }
  return `오늘 00:00~${formatSiteClock(summary.lastAggregatedAt, summary.timeZone)} · 진행 중`;
}

function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${Math.floor(minutes / 60)}시간 ${minutes % 60}분`;
}
