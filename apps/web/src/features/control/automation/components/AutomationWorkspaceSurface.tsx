import type { ReactNode } from "react";
import type { AutomationSiteSummary } from "../../../../api/automation";
import { Card, Heading, Text } from "../../../../components/ui";

type SyncState = "APPLIED" | "PENDING" | "REJECTED";

export function AutomationWorkspaceSummary({ label, timeZone, total, siteSummary, loadedStatuses, state }: {
  label: string;
  timeZone?: string;
  total?: number;
  siteSummary?: AutomationSiteSummary;
  loadedStatuses: readonly SyncState[];
  state: "loading" | "error" | "ready";
}) {
  const applied = loadedStatuses.filter((status) => status === "APPLIED").length;
  const attention = loadedStatuses.length - applied;
  const siteTotal = siteSummary?.ruleCount ?? total;
  const count = state === "loading" ? "확인 중" : state === "error" ? "확인 불가" : siteTotal === undefined ? "확인 불가" : `현장 전체 규칙 ${siteTotal}건`;
  const gateway = state === "loading" ? "확인 중" : state === "error" ? "확인 불가" : siteTotal === 0 ? "적용 대상 없음"
    : siteSummary ? `적용 완료 ${siteSummary.syncRuleCounts.APPLIED}건 · 적용 대기 ${siteSummary.syncRuleCounts.PENDING}건 · 적용 실패 ${siteSummary.syncRuleCounts.REJECTED}건`
      : `적용 완료 ${applied}건 · 확인 필요 ${attention}건 · 불러온 ${loadedStatuses.length}건 기준`;
  return <Card role="group" aria-label={label} className="grid min-w-0 grid-cols-2 overflow-hidden compact:grid-cols-3" data-automation-overview="">
    <SummaryCell label="현장 시간대" value={timeZone ?? "확인 중"} />
    <SummaryCell label="반복 규칙" value={count} />
    <SummaryCell label="Gateway 상태" value={gateway} className="col-span-2 border-t border-border-default compact:col-span-1 compact:border-t-0" />
  </Card>;
}

function SummaryCell({ label, value, className = "" }: { label: string; value: string; className?: string }) {
  return <div className={`grid min-w-0 content-center gap-1 p-3.5 first:border-r first:border-border-default compact:[&:not(:last-child)]:border-r compact:[&:not(:last-child)]:border-border-default ${className}`}>
    <Text as="span" variant="caption" tone="secondary">{label}</Text>
    <Text as="strong" variant="label" className="break-words">{value}</Text>
  </div>;
}

export function AutomationRuleWorkspace({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return <section role="region" aria-label="자동화 목록" className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden rounded-panel border border-border-default bg-surface-panel max-compact:grid-rows-none max-compact:overflow-visible tablet:flex-1" data-automation-list-surface="">
    <div className="border-b border-border-default px-4 py-3"><Heading as="h4" variant="card-title">자동화 목록</Heading></div>
    <div className="min-h-0 min-w-0 overflow-y-auto overscroll-contain max-compact:overflow-visible" data-automation-list-scroll="">{children}</div>
    {footer ? <div className="flex justify-center border-t border-border-default p-2">{footer}</div> : null}
  </section>;
}
