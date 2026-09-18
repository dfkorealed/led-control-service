import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Button, Card, Text } from "../../../components/ui";
import type { ResolvedControlSelection } from "../control-selection";

export function SelectionSummaryPanel({ resolved, compactSummary, compactDetails, onCompactSheetHeightChange }: { resolved: ResolvedControlSelection; compactSummary?: ReactNode; compactDetails?: ReactNode; onCompactSheetHeightChange?: (height: number) => void }) {
  const [expanded, setExpanded] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const [compactHeight, setCompactHeight] = useState(0);
  useLayoutEffect(() => {
    if (!compactSummary || !cardRef.current) return;
    const card = cardRef.current;
    const measure = () => {
      const height = card.getBoundingClientRect().height;
      setCompactHeight(height);
      onCompactSheetHeightChange?.(height);
    };
    measure();
    window.addEventListener("resize", measure);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(card);
    return () => { observer?.disconnect(); window.removeEventListener("resize", measure); };
  }, [compactSummary, expanded, onCompactSheetHeightChange]);
  return <>
    {/* The measured placeholder preserves access to map/list content behind the fixed compact sheet. */}
    {compactSummary && !onCompactSheetHeightChange ? <div className="compact:hidden" aria-hidden="true" style={{ height: compactHeight }} /> : null}
    <div ref={cardRef} className={compactSummary ? "max-compact:pointer-events-none max-compact:fixed max-compact:inset-x-0 max-compact:bottom-0 max-compact:z-10 max-compact:pb-shell-navigation-safe" : undefined}>
      <div className="pointer-events-auto">
        <Card className="grid gap-2 p-3" role="complementary" aria-label="선택 대상 요약">
          <Text as="strong" aria-live="polite" aria-atomic="true">{resolved.fixtureIds.length}개 선택</Text>
          {resolved.unavailableReason ? <Text tone="danger">{resolved.unavailableReason}</Text> : <Text variant="caption" tone="secondary">게이트웨이 {resolved.gatewayIds.length}개</Text>}
          {compactSummary || compactDetails ? <div className="compact:hidden" data-testid="summary-compact-control">
            {compactDetails ? <Button type="button" variant="ghost" className="min-h-13 w-full justify-between" aria-expanded={expanded}
              onClick={() => setExpanded((value) => !value)}>{expanded ? "선택 대상 접기" : "선택 대상 펼치기"}</Button> : null}
            <div className="grid gap-3" data-testid="compact-summary-execution">
              {expanded && compactDetails ? <div className="max-h-[15dvh] overflow-y-auto overscroll-contain" data-compact-selection-details="">{compactDetails}</div> : null}
              {compactSummary}
            </div>
          </div> : null}
        </Card>
      </div>
    </div>
  </>;
}
