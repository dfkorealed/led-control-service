import { type ReactElement } from "react";
import { Heading, Text } from "../../components/ui";
import { cn } from "../../components/ui/utils/cn";

export interface CustomerShellScope { principalKey: string; siteId: string; pathname: string }
export type CustomerSiteSummary = { scope: CustomerShellScope; siteName: string; state: "loading" | "error" }
  | { scope: CustomerShellScope; siteName: string; state: "ready"; counts: { totalFixtures: number | null; onlineFixtures: number | null; faultFixtures: number | null; offlineFixtures: number | null } };

export function CustomerHeaderSummarySlot({ currentScope, value, className, compact = false }: { compact?: boolean; currentScope: CustomerShellScope; value: CustomerSiteSummary | null; className?: string }): ReactElement | null {
  if (!value || value.scope.principalKey !== currentScope.principalKey || value.scope.siteId !== currentScope.siteId || value.scope.pathname !== currentScope.pathname) return null;
  return <section aria-label="현장 전체" className={cn("flex min-w-0 items-center justify-center", compact ? "border-t border-border-default py-1" : "py-0", className)}>
    <Heading as="h2" variant="customer-card-title" className="sr-only">현장 전체</Heading>
    <Text className="sr-only">{value.siteName}</Text>
    {value.state === "ready" ? <dl className={cn("m-0 grid min-w-0 gap-x-3", compact ? "w-full grid-cols-4" : "grid-cols-[repeat(4,max-content)]")}>
      {([ ["totalFixtures", "전체"], ["onlineFixtures", "온라인"], ["faultFixtures", "장애"], ["offlineFixtures", "오프라인"] ] as const).map(([key, label]) => <div key={key} className="grid min-w-0 justify-items-center gap-0.5">
        <dt className="row-start-2 text-caption text-content-secondary">{label}</dt><dd className={cn("m-0 row-start-1 wrap-anywhere text-body-lg font-bold tabular-nums", key === "onlineFixtures" ? "text-status-success-foreground" : key === "faultFixtures" ? "text-status-danger-foreground" : "text-content-primary")}>{value.counts[key] === null ? "—" : `${value.counts[key]}대`}</dd>
      </div>)}
    </dl> : <Text role="status" variant="body-sm" tone="secondary">{value.state === "loading" ? "현장 집계 확인 중" : "현장 집계 확인 불가"}</Text>}
  </section>;
}
