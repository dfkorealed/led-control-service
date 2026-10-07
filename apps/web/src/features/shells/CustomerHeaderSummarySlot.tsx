import { type ReactElement } from "react";
import { Heading, Text } from "../../components/ui";
import { cn } from "../../components/ui/utils/cn";

export interface CustomerShellScope { principalKey: string; siteId: string; pathname: string }
export type CustomerSiteSummary = { scope: CustomerShellScope; siteName: string; state: "loading" | "error" }
  | { scope: CustomerShellScope; siteName: string; state: "ready"; counts: { totalFixtures: number | null; onlineFixtures: number | null; faultFixtures: number | null; offlineFixtures: number | null } };

export function CustomerHeaderSummarySlot({ currentScope, value, className, compact = false }: { compact?: boolean; currentScope: CustomerShellScope; value: CustomerSiteSummary | null; className?: string }): ReactElement | null {
  if (!value || value.scope.principalKey !== currentScope.principalKey || value.scope.siteId !== currentScope.siteId || value.scope.pathname !== currentScope.pathname) return null;
  return <section aria-label="현장 전체" className={cn("flex min-w-0 flex-wrap items-baseline gap-x-4 gap-y-1 border-t border-border-default", compact ? "py-0" : "py-1", className)}>
    <Heading as="h2" variant="card-title" className={compact ? "sr-only" : undefined}>현장 전체</Heading>
    <Text className="sr-only">{value.siteName}</Text>
    {value.state === "ready" ? <dl className="m-0 flex min-w-0 flex-wrap gap-x-3 gap-y-1">
      {([ ["totalFixtures", "전체"], ["onlineFixtures", "온라인"], ["faultFixtures", "장애"], ["offlineFixtures", "오프라인"] ] as const).map(([key, label]) => <div key={key} className="flex min-w-0 flex-wrap items-baseline gap-x-1 gap-y-1">
        <dt className="text-body text-content-secondary">{label}</dt><dd className="m-0 wrap-anywhere text-body-lg font-bold">{value.counts[key] === null ? "—" : `${value.counts[key]}대`}</dd>
      </div>)}
    </dl> : <Text role="status" variant="body-sm" tone="secondary">{value.state === "loading" ? "현장 집계 확인 중" : "현장 집계 확인 불가"}</Text>}
  </section>;
}
