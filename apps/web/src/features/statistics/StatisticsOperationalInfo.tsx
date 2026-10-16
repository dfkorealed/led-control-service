import type { EnergySummary } from "@led-control/shared";
import { Card, Heading, Text, formatTimestamp } from "../../components/ui";

const qualityPeriods = [
  { key: "today", label: "오늘" },
  { key: "monthToDate", label: "이번 달 누적" },
  { key: "yearToDate", label: "올해 누적" }
] as const;

/** Quality is reported by the summary API, not inferred from chart/ranking samples.
 * generatedAt is deliberately not used as a substitute for an unknown aggregate time. */
export function StatisticsOperationalInfo({ summary }: { summary: EnergySummary }) {
  return <Card padding="regular" className="grid min-w-0 content-start gap-4" aria-label="운영 인사이트">
    <Heading as="h2" variant="customer-section-title">운영 인사이트</Heading>
    <div className="grid min-w-0 gap-3">
      {qualityPeriods.map(({ key, label }) => <dl key={key} role="group" aria-label={`${label} 수집 품질`}
        className="m-0 grid min-w-0 grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-2 border-b border-border-default pb-3">
        <dt><Text as="span" variant="label" weight="bold">{label} · 알려진 상태시간</Text></dt>
        <dd className="m-0 text-right tabular-nums"><Text as="span" weight="bold">{formatSeconds(summary[key]?.knownSeconds)}</Text></dd>
        <dt><Text as="span" variant="caption" tone="secondary">수집 공백</Text></dt>
        <dd className="m-0 text-right tabular-nums"><Text as="span">{formatSeconds(summary[key]?.unknownSeconds)}</Text></dd>
      </dl>)}
    </div>
    <dl className="m-0 grid min-w-0 gap-3 compact:grid-cols-2">
      <div className="grid min-w-0 gap-1"><dt><Text as="span" variant="label" tone="secondary">최근 집계</Text></dt>
        <dd className="m-0 [overflow-wrap:anywhere]"><Text as="span">{summary.lastAggregatedAt
          ? <time dateTime={summary.lastAggregatedAt}>{formatTimestamp(summary.lastAggregatedAt, { timeZone: summary.timeZone })}</time> : "—"}</Text></dd>
      </div>
      <div className="grid min-w-0 gap-1"><dt><Text as="span" variant="label" tone="secondary">기준 조명 수</Text></dt>
        <dd className="m-0 tabular-nums"><Text as="span">{summary.baseline24Hours.fixtureCount == null ? "—" : `${summary.baseline24Hours.fixtureCount.toLocaleString("ko-KR")}개`}</Text></dd>
      </div>
    </dl>
    <Text variant="caption" tone="secondary">현장 시간대 {summary.timeZone} · 조명 상태 기록 기준 · 실측 전력 아님</Text>
  </Card>;
}

function formatSeconds(value: number | null | undefined) {
  // A valid collected zero is meaningful; absent values are never fabricated as zero.
  return value == null ? "—" : `${value.toLocaleString("ko-KR")}초`;
}
