import type { EnergyComparisonResponse } from "@led-control/shared";
import { CircleOff, Minus, TrendingDown, TrendingUp } from "lucide-react";
import { Heading, SidePanel, StatusBadge, Text } from "../../components/ui";
import { formatCoverage, formatKwh, formatPercent } from "./statistics-format";

type PriorComparison = EnergyComparisonResponse["priorComparisons"][number];

const comparisonKinds = [
  { kind: "previous_period", label: "직전 동기간 비교" },
  { kind: "previous_year", label: "전년 동기간 비교" }
] as const;

export function PeriodComparisonPanel({ comparisons }: { comparisons: EnergyComparisonResponse["priorComparisons"] }) {
  return (
    <SidePanel className="grid min-w-0 gap-4 p-4 compact:p-6" aria-label="동기간 비교">
      <div className="grid gap-1">
        <Text variant="overline" tone="muted">동일 조건 추세</Text>
        <Heading as="h3" variant="card-title">이전 기간과 비교</Heading>
      </div>
      <div className="grid gap-3">
        {comparisonKinds.map(({ kind, label }) => (
          <ComparisonRow
            key={kind}
            label={label}
            comparison={comparisons.find((item) => item.kind === kind)}
          />
        ))}
      </div>
      <Text variant="caption" tone="muted">조명 구성 변화 미보정</Text>
    </SidePanel>
  );
}

function ComparisonRow({ label, comparison }: { label: string; comparison?: PriorComparison }) {
  if (!comparison || comparison.changeRatePercent === null) {
    return (
      <section className="grid gap-2 rounded-control border border-border-default bg-surface-inset p-3" role="group" aria-label={label}>
        <Text as="strong" variant="label">{label}</Text>
        <StatusBadge tone="neutral" icon={CircleOff}>비교 불가</StatusBadge>
        <Text variant="body-sm" tone="secondary">비교 가능한 사용량 데이터가 없습니다.</Text>
        {comparison ? <Coverage comparison={comparison} /> : null}
      </section>
    );
  }

  const rate = comparison.changeRatePercent;
  const tone = rate < 0 ? "success" : rate > 0 ? "danger" : "neutral";
  const Icon = rate < 0 ? TrendingDown : rate > 0 ? TrendingUp : Minus;
  const direction = rate < 0 ? "감소" : rate > 0 ? "증가" : "동일";

  return (
    <section className="grid gap-2 rounded-control border border-border-default bg-surface-inset p-3" role="group" aria-label={label}>
      <Text as="strong" variant="label">{label}</Text>
      <StatusBadge tone={tone} icon={Icon}>
        {rate === 0 ? direction : `${formatPercent(Math.abs(rate))} ${direction}`}
      </StatusBadge>
      <Text variant="body-sm" weight="bold" className="tabular-nums">{formatKwh(comparison.comparisonKwh!)} → {formatKwh(comparison.currentKwh!)}</Text>
      <Coverage comparison={comparison} />
    </section>
  );
}

function Coverage({ comparison }: { comparison: PriorComparison }) {
  return (
    <div className="grid gap-1 text-caption text-content-muted">
      <span>현재 수집률 {formatCoverage(comparison.currentCoverageRate)}</span>
      <span>비교 기간 수집률 {formatCoverage(comparison.comparisonCoverageRate)}</span>
    </div>
  );
}
