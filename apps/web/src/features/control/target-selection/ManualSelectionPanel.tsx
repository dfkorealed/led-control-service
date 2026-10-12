import { useId, useRef, useState } from "react";
import type { DashboardFixture } from "../../../api/queries";
import { Button, Heading, Text } from "../../../components/ui";

/** Presentation of the existing resolved selection; never owns targets or queries. */
export function ManualSelectionPanel({ fixtures, compact, locked, onClear }: {
  fixtures: readonly DashboardFixture[];
  compact: boolean;
  locked: boolean;
  onClear: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const listId = useId();
  const opener = useRef<HTMLButtonElement>(null);
  return <section aria-label="선택 대상 목록" data-manual-selection-panel=""
    className={compact ? "grid min-h-0 min-w-0 gap-1" : "grid h-full min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)] gap-3 rounded-panel border border-border-default bg-surface-panel p-3"}>
    <div className="grid min-w-0 gap-1">
      <Heading as="h3" variant="customer-card-title" className={compact ? "text-caption" : undefined}
        aria-live={compact ? "polite" : undefined} aria-atomic="true">선택 조명 {fixtures.length}개</Heading>
      <Button ref={opener} hidden={!compact} type="button" variant="secondary" className={compact ? "min-h-11! w-full" : "hidden"}
        aria-expanded={expanded} aria-controls={listId} onClick={() => setExpanded(value => !value)}>{expanded ? "접기" : "전체 보기"}</Button>
    </div>
    <div id={listId} hidden={compact && !expanded}
      className={`${compact && !expanded ? "hidden" : "grid"} min-h-0 min-w-0 content-start gap-2 overflow-y-auto overscroll-contain ${compact ? "max-h-[15dvh]" : ""}`}
      onKeyDown={event => {
        if (compact && event.key === "Escape") { event.stopPropagation(); setExpanded(false); opener.current?.focus({ preventScroll: true }); }
      }}>
      <Button type="button" variant="ghost" disabled={locked || fixtures.length === 0} onClick={onClear}>선택 해제</Button>
      {fixtures.length ? <ul aria-label="선택 조명" className="m-0 grid min-h-0 list-none gap-1 p-0">
        {fixtures.map(fixture => <li key={fixture.id} className="rounded-control bg-surface-inset px-2 py-1 text-body-sm wrap-anywhere" title={fixture.id}>{fixture.name}</li>)}
      </ul> : <Text variant="caption" tone="secondary">도면에서 조명을 선택하세요.</Text>}
    </div>
  </section>;
}
