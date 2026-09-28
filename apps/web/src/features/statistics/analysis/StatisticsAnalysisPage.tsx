import type { EnergyRankingDimension, EnergyRankingMetric, EnergyRankingSort } from "@led-control/shared/energy-analytics-contracts";
import type { EnergyHeatmapMetric } from "@led-control/shared/energy-p2-contracts";
import { energyRangeComparisonQuerySchema } from "@led-control/shared/energy-range-contracts";
import { Activity, ArrowDownAZ, ArrowUpAZ, BarChart3, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useEnergyObservedMeanHeatmap, useEnergyRankings, useEnergySummary } from "../../../api/energy";
import { Button, Card, DatePicker, FeedbackState, MetricCard, SelectBox, StatusBadge, StatusDetailButton, Text } from "../../../components/ui";
import type { StatisticsOutletContext } from "../StatisticsShell";
import { EnergyRankingDetailPanel } from "./EnergyRankingDetailPanel";
import { EnergyHeatmap } from "./EnergyHeatmap";
import { EnergyRankingList } from "./EnergyRankingList";

const dimensions: Array<{ value: EnergyRankingDimension; label: string }> = [
  { value: "fixture", label: "조명" }, { value: "floor", label: "층" }, { value: "group", label: "그룹" }
];
const metricItems: Array<{ id: EnergyRankingMetric; label: string }> = [
  { id: "usage", label: "사용량" },
  { id: "cost", label: "저장 비용" },
  { id: "contribution", label: "현장 기여도" },
  { id: "per_fixture_average", label: "조명당 평균" }
];

export function StatisticsAnalysisPage() {
  const { siteId } = useOutletContext<StatisticsOutletContext>();
  const summary = useEnergySummary(siteId);
  const defaults = summary.data ? completedSiteMonth(summary.data.generatedAt, summary.data.timeZone) : null;
  const [dimension, setDimension] = useState<EnergyRankingDimension>("floor");
  const [metric, setMetric] = useState<EnergyRankingMetric>("usage");
  const [sort, setSort] = useState<EnergyRankingSort>("desc");
  const [rangeOverride, setRangeOverride] = useState<{ siteId: string; from: string; to: string } | null>(null);
  const activeOverride = rangeOverride?.siteId === siteId ? rangeOverride : null;
  const from = activeOverride?.from ?? defaults?.from ?? "";
  const to = activeOverride?.to ?? defaults?.to ?? "";
  const validRange = Boolean(defaults && to <= defaults.to && energyRangeComparisonQuerySchema.safeParse({ from, to }).success);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [heatmapMetric, setHeatmapMetric] = useState<EnergyHeatmapMetric>("energy");
  const query = useEnergyRankings({ siteId, dimension, metric, sort, from, to, limit: 20, enabled: validRange });
  const rankingResponse = query.data;
  const ranking = validRange && !query.isError && rankingResponse && rankingResponse.siteId === siteId && rankingResponse.range.from === from &&
    rankingResponse.range.to === to && rankingResponse.dimension === dimension && rankingResponse.metric === metric &&
    rankingResponse.sort === sort ? rankingResponse : null;
  const rankingMismatch = Boolean(validRange && !query.isError && query.data && !ranking);
  const selected = ranking?.ranked.find((item) => item.identityId === selectedId) ?? ranking?.ranked[0] ?? null;
  const heatmap = useEnergyObservedMeanHeatmap({
    siteId,
    scope: selected ? dimension : "site",
    identityId: selected?.identityId ?? siteId,
    metric: heatmapMetric,
    from, to,
    enabled: validRange && Boolean(ranking)
  });
  const heatmapResponse = heatmap.data;
  const matchingHeatmap = ranking && heatmapResponse && heatmapResponse.siteId === siteId && heatmapResponse.scope === (selected ? dimension : "site") &&
    heatmapResponse.identityId === (selected?.identityId ?? siteId) && heatmapResponse.metric === heatmapMetric &&
    heatmapResponse.range.from === from && heatmapResponse.range.to === to ? heatmapResponse : undefined;

  useEffect(() => {
    setSelectedId(null);
  }, [dimension, metric, from, to]);

  useEffect(() => { setRangeOverride(null); setSelectedId(null); }, [siteId]);

  if (summary.isError) {
    return <section className="grid min-w-0 gap-6"><FeedbackState tone="danger" icon={TriangleAlert}
      title="현장 기간 기준을 불러오지 못했습니다." action={<Button variant="secondary" onClick={() => summary.refetch()}>다시 시도</Button>} /></section>;
  }
  if (!siteId || summary.isLoading || !defaults) {
    return <section className="grid min-w-0 gap-6"><FeedbackState icon={Activity} title="사용량 순위를 계산하는 중" /></section>;
  }
  return (
    <section className="grid min-w-0 gap-5" aria-label="사용량 분석 결과">
      <Card className="grid min-w-0 grid-cols-1 items-end gap-3 p-4 compact:grid-cols-2 tablet:grid-cols-[minmax(0,1.2fr)_minmax(0,0.85fr)_minmax(0,1fr)_minmax(0,1fr)_auto]" aria-label="사용량 분석 조건">
        <div className="grid min-w-0 gap-2" role="group" aria-label="분석 단위">
          <Text as="span" variant="label">분석 단위</Text>
          <div className="flex min-w-0 gap-2">
          {dimensions.map((item) => <Button key={item.value} size="sm" variant={dimension === item.value ? "primary" : "secondary"}
            aria-pressed={dimension === item.value} className="min-w-0 flex-1" onClick={() => setDimension(item.value)}>{item.label}</Button>)}
          </div>
        </div>
        <SelectBox className="min-w-0" label="순위 기준" items={metricItems} selectedKey={metric}
          onSelectionChange={(value) => value && setMetric(value)} />
        <DatePicker className="min-w-0" label="시작일" value={from} maxValue={to || defaults.to}
          onChange={(value) => setRangeOverride({ siteId, from: value ?? "", to })} />
        <DatePicker className="min-w-0" label="종료일" value={to} minValue={from} maxValue={defaults.to}
          onChange={(value) => setRangeOverride({ siteId, from, to: value ?? "" })} />
        <Button variant="secondary" className="w-full whitespace-nowrap" onClick={() => setSort((value) => value === "desc" ? "asc" : "desc")}>
          {sort === "desc" ? <ArrowDownAZ size={16} /> : <ArrowUpAZ size={16} />}{sort === "desc" ? "높은 순" : "낮은 순"}
        </Button>
      </Card>
      {!validRange ? <FeedbackState tone="danger" icon={TriangleAlert} title="완료된 기간을 선택해 주세요."
        description={`시작일과 종료일을 1~400일 범위로 선택하고 종료일은 ${defaults.to} 이전이어야 합니다.`} /> : null}
      {validRange && !query.data && !query.isError ? <FeedbackState icon={Activity} title="사용량 순위를 계산하는 중" /> : null}
      {rankingMismatch ? <FeedbackState tone="danger" icon={TriangleAlert} title="선택 기간의 분석 응답이 일치하지 않습니다."
        action={<Button variant="secondary" onClick={() => query.refetch()}>다시 시도</Button>} /> : null}
      {validRange && query.isError ? <FeedbackState tone="danger" icon={TriangleAlert} title="사용량 분석을 불러오지 못했습니다."
        action={<Button variant="secondary" onClick={() => query.refetch()}>다시 시도</Button>} /> : null}
      {ranking ? <>
      <div className="grid grid-cols-3 gap-3 max-compact:grid-cols-1">
        <MetricCard label="현장 사용량" value={ranking.siteTotalKwh.toLocaleString("ko-KR")} unit="kWh" tone="primary" />
        <MetricCard label="저장 비용" value={Math.round(ranking.siteTotalCost).toLocaleString("ko-KR")} unit="원" />
        <MetricCard label="분석 대상" value={ranking.ranked.length} unit="개" />
      </div>
      <div className="flex min-w-0 flex-wrap items-center gap-2 rounded-control border border-status-info-border bg-status-info-background px-3 py-2" aria-label="분석 상태">
        <StatusBadge tone="info" icon={BarChart3}>상태 기반 추정</StatusBadge>
        <Text variant="body-sm" tone="secondary">비용 합계와 순위는 당시 적용 단가의 저장 비용입니다.</Text>
        {ranking.overlappingMemberships ? <StatusDetailButton label="그룹 중복" description="그룹 중복 소속 조명은 각 그룹에 포함됩니다. 그룹 합계는 현장 총계와 다를 수 있습니다." /> : null}
        {ranking.legacyExcludedBefore ? <StatusDetailButton label="과거 이력 제외" description={`${ranking.legacyExcludedBefore} 이전 구조 이력은 순위에서 제외하고 현장 총계에만 포함했습니다.`} /> : null}
      </div>
      <div className="grid min-w-0 grid-cols-1 gap-4 tablet:grid-cols-2">
        <EnergyRankingList items={ranking.ranked} unranked={ranking.unranked} metric={metric}
          selectedId={selected?.identityId ?? null} onSelect={(item) => setSelectedId(item.identityId)} />
        <EnergyRankingDetailPanel item={selected} />
      </div>
      <EnergyHeatmap data={matchingHeatmap} isLoading={heatmap.isLoading && !heatmap.data} isError={heatmap.isError || Boolean(heatmap.data && !matchingHeatmap)}
        metric={heatmapMetric} onMetricChange={setHeatmapMetric} onRetry={() => heatmap.refetch()} />
      </> : null}
    </section>
  );
}

function completedSiteMonth(timestamp: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const currentDay = new Date(`${values.year}-${values.month}-${values.day}T00:00:00.000Z`);
  currentDay.setUTCDate(currentDay.getUTCDate() - 1);
  const to = currentDay.toISOString().slice(0, 10);
  return { from: `${to.slice(0, 7)}-01`, to };
}
