import type { EnergyComparisonResponse } from "@led-control/shared";
import { CircleOff, Minus, TrendingDown, TrendingUp } from "lucide-react";
import { SidePanel, StatusBadge } from "../../components/ui";
import { formatCoverage, formatKwh, formatPercent } from "./statistics-format";

type PriorComparison = EnergyComparisonResponse["priorComparisons"][number];

const comparisonKinds = [
  { kind: "previous_period", label: "직전 동기간 비교" },
  { kind: "previous_year", label: "전년 동기간 비교" }
] as const;

export function PeriodComparisonPanel({ comparisons }: { comparisons: EnergyComparisonResponse["priorComparisons"] }) {
  return (
    <SidePanel className="period-comparison-panel" aria-label="동기간 비교">
      <div>
        <span className="eyebrow">동일 조건 추세</span>
        <h3>이전 기간과 비교</h3>
      </div>
      <div className="period-comparison-list">
        {comparisonKinds.map(({ kind, label }) => (
          <ComparisonRow
            key={kind}
            label={label}
            comparison={comparisons.find((item) => item.kind === kind)}
          />
        ))}
      </div>
      <p className="statistics-baseline-note">조명 구성 변화 미보정</p>
    </SidePanel>
  );
}

function ComparisonRow({ label, comparison }: { label: string; comparison?: PriorComparison }) {
  if (!comparison || comparison.changeRatePercent === null) {
    return (
      <section className="period-comparison-row" role="group" aria-label={label}>
        <strong>{label}</strong>
        <StatusBadge tone="neutral" icon={CircleOff}>비교 불가</StatusBadge>
        <p>비교 가능한 사용량 데이터가 없습니다.</p>
        {comparison ? <Coverage comparison={comparison} /> : null}
      </section>
    );
  }

  const rate = comparison.changeRatePercent;
  const tone = rate < 0 ? "success" : rate > 0 ? "danger" : "neutral";
  const Icon = rate < 0 ? TrendingDown : rate > 0 ? TrendingUp : Minus;
  const direction = rate < 0 ? "감소" : rate > 0 ? "증가" : "동일";

  return (
    <section className="period-comparison-row" role="group" aria-label={label}>
      <strong>{label}</strong>
      <StatusBadge tone={tone} icon={Icon}>
        {rate === 0 ? direction : `${formatPercent(Math.abs(rate))} ${direction}`}
      </StatusBadge>
      <p>{formatKwh(comparison.comparisonKwh!)} → {formatKwh(comparison.currentKwh!)}</p>
      <Coverage comparison={comparison} />
    </section>
  );
}

function Coverage({ comparison }: { comparison: PriorComparison }) {
  return (
    <div className="period-comparison-coverage">
      <span>현재 수집률 {formatCoverage(comparison.currentCoverageRate)}</span>
      <span>비교 기간 수집률 {formatCoverage(comparison.comparisonCoverageRate)}</span>
    </div>
  );
}
