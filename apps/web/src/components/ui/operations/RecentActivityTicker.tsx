import { useEffect, useState, type ReactNode, type Ref } from "react";
import { Button } from "../Button";
import { Text } from "../Typography";
import { ArrowRight } from "lucide-react";

export type RecentActivityRow = { id: string; timestampLabel: string; content: ReactNode; status?: ReactNode };
export interface RecentActivityTickerProps {
  scopeKey: string;
  items: readonly RecentActivityRow[];
  emptyContent: ReactNode;
  onOpen: () => void;
  onRetry?: () => void;
  triggerRef?: Ref<HTMLButtonElement>;
  triggerHasPopup?: "dialog";
  title?: string;
}

/** Presentation only: adapters retain date/cursor/query/error and dialog ownership. */
export function RecentActivityTicker({ scopeKey, items, emptyContent, onOpen, onRetry, triggerRef, triggerHasPopup, title = "최근 이력" }: RecentActivityTickerProps) {
  const [index, setIndex] = useState(0);
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const [hidden, setHidden] = useState(() => document.visibilityState === "hidden");
  useEffect(() => {
    const changed = () => setHidden(document.visibilityState === "hidden");
    document.addEventListener("visibilitychange", changed);
    return () => document.removeEventListener("visibilitychange", changed);
  }, []);
  useEffect(() => { setIndex(0); }, [scopeKey, items]);
  useEffect(() => {
    if (items.length < 2 || hovered || focused || hidden) return;
    const timer = window.setInterval(() => setIndex(current => (current + 1) % items.length), 5000);
    return () => window.clearInterval(timer);
  }, [scopeKey, items, hovered, focused, hidden]);
  const row = items[index] ?? items[0];
  // Without a command row, narrow error/pending copy needs its own line:
  // retry/open must not consume its width down to a single glyph. Keep the
  // loaded single-line row and desktop flow, buttons, refs and clock unchanged.
  return <div role="region" aria-label={title} className={`flex min-w-0 shrink-0 items-center gap-2 rounded-panel border border-border-default bg-surface-panel px-3.5 py-2 ${row ? "" : "flex-wrap compact:flex-nowrap"}`}
    onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
    onFocusCapture={() => setFocused(true)} onBlurCapture={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false); }}>
    <Text as="span" variant="label" className="shrink-0 max-compact:sr-only">{title}</Text>
    <div className={row ? "flex min-w-0 flex-1 items-center gap-2 overflow-hidden" : "min-w-0 w-full compact:w-auto compact:flex-1"}>
      {row ? <><Text as="time" variant="body-sm" tone="secondary" className="shrink-0">{row.timestampLabel}</Text>
        <div className="min-w-0 truncate text-body-sm text-content-primary">{row.content}</div>
        {row.status != null ? <div className="shrink-0 text-body-sm">{row.status}</div> : null}</> : emptyContent}
    </div>
    {onRetry ? <Button type="button" variant="ghost" onClick={onRetry}>다시 조회</Button> : null}
    <Button ref={triggerRef} type="button" variant="ghost" aria-haspopup={triggerHasPopup} onClick={onOpen}>전체 보기<ArrowRight size={16} aria-hidden="true" /></Button>
  </div>;
}
