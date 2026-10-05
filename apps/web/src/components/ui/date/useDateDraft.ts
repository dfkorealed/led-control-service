import { useCallback, useState } from "react";
import { parseIsoDate } from "./date-adapters";

export type DateSegmentDraft = Readonly<{ year: number | null; month: number | null; day: number | null }>;
export interface DateDraftController {
  draft: DateSegmentDraft;
  onDraftChange(draft: DateSegmentDraft): void;
  reset(value: string | null): void;
}
export function isEmptyDateDraft(draft: DateSegmentDraft): boolean {
  return draft.year === null && draft.month === null && draft.day === null;
}

export function dateToDraft(value: string | null): DateSegmentDraft {
  if (value === null) return { year: null, month: null, day: null };
  const { year, month, day } = parseIsoDate(value);
  return { year, month, day };
}

/** Partial/impossible raw input has no canonical date; validation remains caller-owned. */
export function draftToDate(draft: DateSegmentDraft): string | null {
  if (draft.year === null || draft.month === null || draft.day === null) return null;
  const iso = `${String(draft.year).padStart(4, "0")}-${String(draft.month).padStart(2, "0")}-${String(draft.day).padStart(2, "0")}`;
  try { return parseIsoDate(iso).toString(); } catch { return null; }
}

/** An epoch is distinct even when a scope returns A→B→A, unlike a key comparison. */
export function useScopedDateDraft<D, V>(scopeKey: string, initialValue: V, parse: (value: V) => D) {
  const [stored, setStored] = useState(() => ({ scopeKey, epoch: {}, draft: parse(initialValue) }));
  let snapshot = stored;
  if (stored.scopeKey !== scopeKey) {
    snapshot = { scopeKey, epoch: {}, draft: parse(initialValue) };
    // Render-phase adjustment prevents exposing the previous site's draft for one frame.
    setStored(snapshot);
  }
  const epoch = snapshot.epoch;
  const onDraftChange = useCallback((draft: D) => {
    setStored(current => current.epoch === epoch ? { ...current, draft } : current);
  }, [epoch]);
  const reset = useCallback((value: V) => {
    setStored(current => current.epoch === epoch ? { ...current, epoch: {}, draft: parse(value) } : current);
  }, [epoch, parse]);
  return { draft: snapshot.draft, onDraftChange, reset };
}

export function useDateDraft(scopeKey: string, initialValue: string | null): DateDraftController {
  return useScopedDateDraft(scopeKey, initialValue, dateToDraft);
}
