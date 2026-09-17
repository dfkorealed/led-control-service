import { useState, type ReactNode } from "react";
import { Button, Card, Text } from "../../../components/ui";
import type { ResolvedControlSelection } from "../control-selection";

export function SelectionSummaryPanel({ resolved, compactSummary }: { resolved: ResolvedControlSelection; compactSummary?: ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const details = <div className="grid gap-1"><Text as="strong">{resolved.fixtureIds.length}개 선택</Text>
    {resolved.unavailableReason ? <Text tone="danger">{resolved.unavailableReason}</Text> : <Text variant="caption" tone="secondary">게이트웨이 {resolved.gatewayIds.length}개</Text>}</div>;
  return <Card className="grid gap-2 p-3" role="complementary" aria-label="선택 대상 요약">
    <div className="hidden compact:block" data-testid="summary-normal-content">{details}</div>
    <div className="compact:hidden" data-testid="summary-compact-control"><Button type="button" variant="ghost" className="w-full justify-between" aria-expanded={expanded}
      onClick={() => setExpanded((value) => !value)}>{expanded ? "선택 대상 접기" : "선택 대상 펼치기"}</Button>{expanded ? <div className="grid gap-3 pt-2">{details}{compactSummary ? <div data-testid="compact-summary-execution">{compactSummary}</div> : null}</div> : null}</div>
  </Card>;
}
