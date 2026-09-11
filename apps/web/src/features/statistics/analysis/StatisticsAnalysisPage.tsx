import type { EnergyRankingDimension, EnergyRankingMetric, EnergyRankingSort } from "@led-control/shared/energy-analytics-contracts";
import { Activity, ArrowDownAZ, ArrowUpAZ, BarChart3, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useOutletContext } from "react-router-dom";
import { useEnergyRankings } from "../../../api/energy";
import { Button, Card, FeedbackState, PageHeader, StatusBadge } from "../../../components/ui";
import type { StatisticsOutletContext } from "../StatisticsShell";
import { EnergyRankingDetailPanel } from "./EnergyRankingDetailPanel";
import { EnergyRankingList } from "./EnergyRankingList";

const dimensions: Array<{ value: EnergyRankingDimension; label: string }> = [
  { value: "fixture", label: "조명" }, { value: "floor", label: "층" }, { value: "group", label: "그룹" }
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
  const query = useEnergyRankings({ siteId, dimension, metric, sort, from, to, limit: 20 });
  const selected = query.data?.ranked.find((item) => item.identityId === selectedId) ?? query.data?.ranked[0] ?? null;

  useEffect(() => {
    setSelectedId(null);
  }, [dimension, metric, from, to]);

  if (!siteId || query.isLoading) {
    return <section className="statistics-screen"><FeedbackState icon={Activity} title="사용량 순위를 계산하는 중" /></section>;
  }
  if (query.isError || !query.data) {
    return (
      <section className="statistics-screen">
        <FeedbackState tone="danger" icon={TriangleAlert} title="사용량 분석을 불러오지 못했습니다."
          action={<Button variant="secondary" onClick={() => query.refetch()}>다시 시도</Button>} />
      </section>
    );
  }

  return (
    <section className="statistics-screen statistics-analysis-screen">
      <PageHeader
        title="사용량 분석"
        description="조명·층·그룹별 에너지 사용량을 비교하고 변화 원인을 확인합니다."
        status={<StatusBadge tone="info" icon={BarChart3}>상태 기반 추정</StatusBadge>}
      />
      <Card className="statistics-analysis-filters" aria-label="사용량 분석 조건">
        <div className="segmented-control" aria-label="분석 단위">
          {dimensions.map((item) => <button key={item.value} type="button" aria-pressed={dimension === item.value}
            className={dimension === item.value ? "active" : ""} onClick={() => setDimension(item.value)}>{item.label}</button>)}
        </div>
        <label>순위 기준<select value={metric} onChange={(event) => setMetric(event.target.value as EnergyRankingMetric)}>
          <option value="usage">사용량</option><option value="cost">예상 비용</option>
          <option value="contribution">현장 기여도</option><option value="per_fixture_average">조명당 평균</option>
        </select></label>
        <label>시작일<input type="date" value={from} max={to} onChange={(event) => setFrom(event.target.value)} /></label>
        <label>종료일<input type="date" value={to} min={from} onChange={(event) => setTo(event.target.value)} /></label>
        <Button variant="secondary" onClick={() => setSort((value) => value === "desc" ? "asc" : "desc")}>
          {sort === "desc" ? <ArrowDownAZ size={16} /> : <ArrowUpAZ size={16} />}{sort === "desc" ? "높은 순" : "낮은 순"}
        </Button>
      </Card>
      {query.data.overlappingMemberships ? <p className="statistics-coverage-notice">그룹 중복 소속 조명은 각 그룹에 포함됩니다. 그룹 합계는 현장 총계와 다를 수 있습니다.</p> : null}
      {query.data.legacyExcludedBefore ? <p className="statistics-coverage-notice">{query.data.legacyExcludedBefore} 이전 구조 이력은 순위에서 제외하고 현장 총계에만 포함했습니다.</p> : null}
      <div className="statistics-analysis-summary">
        <div><span>현장 사용량</span><strong>{query.data.siteTotalKwh.toLocaleString("ko-KR")} kWh</strong></div>
        <div><span>예상 비용</span><strong>{Math.round(query.data.siteTotalCost).toLocaleString("ko-KR")}원</strong></div>
        <div><span>분석 대상</span><strong>{query.data.ranked.length}개</strong></div>
      </div>
      <div className="statistics-analysis-layout">
        <EnergyRankingList items={query.data.ranked} unranked={query.data.unranked} metric={metric}
          selectedId={selected?.identityId ?? null} onSelect={(item) => setSelectedId(item.identityId)} />
        <EnergyRankingDetailPanel item={selected} />
      </div>
    </section>
  );
}

function defaultRange() {
  const to = new Date();
  const from = new Date(to);
  from.setDate(from.getDate() - 29);
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}
