import type { EnergyRankingDimension, EnergyRankingMetric, EnergyRankingSort } from "@led-control/shared/energy-analytics-contracts";
import type { EnergyHeatmapMetric } from "@led-control/shared/energy-p2-contracts";
import { getLocalTimeZone, today } from "@internationalized/date";
import { Activity, ArrowDownAZ, ArrowUpAZ, BarChart3, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useEnergyHeatmap, useEnergyRankings } from "../../../api/energy";
import { Button, Card, DatePicker, FeedbackState, formatIsoDate, MetricCard, PageHeader, SelectBox, StatusBadge, StatusDetailButton, Text } from "../../../components/ui";
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
  const defaults = useMemo(defaultRange, []);
  const [dimension, setDimension] = useState<EnergyRankingDimension>("floor");
  const [metric, setMetric] = useState<EnergyRankingMetric>("usage");
  const [sort, setSort] = useState<EnergyRankingSort>("desc");
  const [from, setFrom] = useState(defaults.from);
  const [to, setTo] = useState(defaults.to);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [heatmapMetric, setHeatmapMetric] = useState<EnergyHeatmapMetric>("energy");
  const query = useEnergyRankings({ siteId, dimension, metric, sort, from, to, limit: 20 });
  const selected = query.data?.ranked.find((item) => item.identityId === selectedId) ?? query.data?.ranked[0] ?? null;
  // The timezone exists only on the ranking response. Keep the heatmap query disabled until it is known.
  const heatmapRange = query.data ? completedSiteRange(query.data.generatedAt, query.data.timeZone) : null;
  const heatmap = useEnergyHeatmap({
    siteId,
    scope: selected ? dimension : "site",
    identityId: selected?.identityId ?? siteId,
    metric: heatmapMetric,
    from: heatmapRange?.from,
    to: heatmapRange?.to,
    enabled: Boolean(heatmapRange)
  });

  useEffect(() => {
    setSelectedId(null);
  }, [dimension, metric, from, to]);

  if (!siteId || query.isLoading) {
    return <section className="grid min-w-0 gap-6"><FeedbackState icon={Activity} title="사용량 순위를 계산하는 중" /></section>;
  }
  if (query.isError || !query.data) {
    return (
      <section className="grid min-w-0 gap-6">
        <FeedbackState tone="danger" icon={TriangleAlert} title="사용량 분석을 불러오지 못했습니다."
          action={<Button variant="secondary" onClick={() => query.refetch()}>다시 시도</Button>} />
      </section>
    );
  }

  return (
    <section className="grid min-w-0 gap-6" aria-label="사용량 분석 결과">
      <PageHeader
        title="사용량 분석"
        description={<Text variant="body-sm" tone="secondary">
          분석 선택 기간 {query.data.range.from} ~ {query.data.range.to} · {query.data.timeZone} · 순위·상세에 적용. 히트맵은 별도 완료 기간입니다.
        </Text>}
        status={<>
          <StatusBadge tone="info" icon={BarChart3}>상태 기반 추정</StatusBadge>
          {query.data.overlappingMemberships ? <StatusDetailButton label="그룹 중복" description="그룹 중복 소속 조명은 각 그룹에 포함됩니다. 그룹 합계는 현장 총계와 다를 수 있습니다." /> : null}
          {query.data.legacyExcludedBefore ? <StatusDetailButton label="과거 이력 제외" description={`${query.data.legacyExcludedBefore} 이전 구조 이력은 순위에서 제외하고 현장 총계에만 포함했습니다.`} /> : null}
        </>}
      />
      <Card className="flex min-w-0 flex-wrap items-end gap-3 p-4 max-compact:items-stretch" aria-label="사용량 분석 조건">
        <div className="flex flex-wrap gap-2 max-compact:w-full" aria-label="분석 단위">
          {dimensions.map((item) => <Button key={item.value} size="sm" variant={dimension === item.value ? "primary" : "secondary"}
            aria-pressed={dimension === item.value} className="max-compact:flex-1" onClick={() => setDimension(item.value)}>{item.label}</Button>)}
        </div>
        <SelectBox className="min-w-40 max-compact:w-full" label="순위 기준" items={metricItems} selectedKey={metric}
          onSelectionChange={(value) => value && setMetric(value)} />
        <DatePicker className="min-w-40 max-compact:w-full" label="시작일" value={from} maxValue={to}
          onChange={(value) => value && setFrom(value)} />
        <DatePicker className="min-w-40 max-compact:w-full" label="종료일" value={to} minValue={from}
          onChange={(value) => value && setTo(value)} />
        <Button variant="secondary" onClick={() => setSort((value) => value === "desc" ? "asc" : "desc")}>
          {sort === "desc" ? <ArrowDownAZ size={16} /> : <ArrowUpAZ size={16} />}{sort === "desc" ? "높은 순" : "낮은 순"}
        </Button>
      </Card>
      <div className="grid grid-cols-3 gap-3 max-compact:grid-cols-1">
        <MetricCard label="현장 사용량" value={query.data.siteTotalKwh.toLocaleString("ko-KR")} unit="kWh" tone="primary" />
        <MetricCard label="저장 비용" value={Math.round(query.data.siteTotalCost).toLocaleString("ko-KR")} unit="원" />
        <MetricCard label="분석 대상" value={query.data.ranked.length} unit="개" />
      </div>
      <Text variant="body-sm" tone="muted">비용 합계와 순위는 당시 적용 단가의 저장 비용입니다.</Text>
      <div className="grid min-w-0 grid-cols-1 gap-4 tablet:grid-cols-2">
        <EnergyRankingList items={query.data.ranked} unranked={query.data.unranked} metric={metric}
          selectedId={selected?.identityId ?? null} onSelect={(item) => setSelectedId(item.identityId)} />
        <EnergyRankingDetailPanel item={selected} />
      </div>
      <EnergyHeatmap data={heatmap.data} isLoading={!heatmapRange || heatmap.isLoading} isError={heatmap.isError}
        metric={heatmapMetric} onMetricChange={setHeatmapMetric} onRetry={() => heatmap.refetch()} />
    </section>
  );
}

function completedSiteRange(timestamp: string, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(new Date(timestamp));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  const currentDay = new Date(`${values.year}-${values.month}-${values.day}T00:00:00.000Z`);
  currentDay.setUTCDate(currentDay.getUTCDate() - 1);
  const to = currentDay.toISOString().slice(0, 10);
  currentDay.setUTCDate(currentDay.getUTCDate() - 27);
  return { from: currentDay.toISOString().slice(0, 10), to };
}

function defaultRange() {
  const to = today(getLocalTimeZone());
  return { from: formatIsoDate(to.subtract({ days: 29 })), to: formatIsoDate(to) };
}
