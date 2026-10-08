import { useState, type ReactElement } from "react";
import { Button, Heading, Text } from "../../components/ui";
import { cn } from "../../components/ui/utils/cn";

export interface CustomerShellScope { principalKey: string; siteId: string; pathname: "/monitoring" }
export type CustomerSiteSummary = { scope: CustomerShellScope; siteName: string; state: "loading" | "error" }
  | { scope: CustomerShellScope; siteName: string; state: "ready"; counts: { totalFixtures: number | null; onlineFixtures: number | null; faultFixtures: number | null; offlineFixtures: number | null } };

export function CustomerHeaderSummarySlot({ currentScope, value, className, compact = false }: { compact?: boolean; currentScope: CustomerShellScope; value: CustomerSiteSummary | null; className?: string }): ReactElement | null {
  const [expanded, setExpanded] = useState(false);
  if (!value || value.scope.principalKey !== currentScope.principalKey || value.scope.siteId !== currentScope.siteId || value.scope.pathname !== currentScope.pathname) return null;
  return <section aria-label="현장 전체" className={cn("grid min-w-0 gap-2 border-t border-border-default py-2", className)}>
    {compact ? <Button type="button" variant="ghost" className="min-h-11 justify-start" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>현장 전체 {expanded ? "접기" : "보기"}</Button> : null}
    <div hidden={compact && !expanded}>
    <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
      <Heading as="h2" variant="card-title">현장 전체</Heading>
      <Text className="min-w-0 wrap-anywhere">{value.siteName}</Text>
    </div>
    {value.state === "ready" ? <dl className="m-0 flex min-w-0 flex-wrap gap-x-4 gap-y-2">
      {([ ["totalFixtures", "전체"], ["onlineFixtures", "온라인"], ["faultFixtures", "장애"], ["offlineFixtures", "오프라인"] ] as const).map(([key, label]) => <div key={key} className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-1 py-1">
        <dt className="text-body text-content-secondary">{label}</dt><dd className="m-0 wrap-anywhere text-body font-bold">{value.counts[key] === null ? "—" : `${value.counts[key]}대`}</dd>
      </div>)}
    </dl> : <Text role="status" variant="body-sm" tone="secondary">{value.state === "loading" ? "현장 집계 확인 중" : "현장 집계 확인 불가"}</Text>}
    </div>
  </section>;
}
