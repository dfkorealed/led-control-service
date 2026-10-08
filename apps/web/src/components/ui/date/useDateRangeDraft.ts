import type { DateRangeValue } from "./date-adapters";
import { dateToDraft, useScopedDateDraft, type DateSegmentDraft } from "./useDateDraft";

export type DateRangeDraft = Readonly<{ start: DateSegmentDraft; end: DateSegmentDraft }>;
export interface DateRangeDraftController {
  draft: DateRangeDraft;
  onDraftChange(draft: DateRangeDraft): void;
  reset(value: DateRangeValue | null): void;
}
function rangeToDraft(value: DateRangeValue | null): DateRangeDraft {
  return { start: dateToDraft(value?.start ?? null), end: dateToDraft(value?.end ?? null) };
}
export function useDateRangeDraft(scopeKey: string, initialValue: DateRangeValue | null): DateRangeDraftController {
  return useScopedDateDraft(scopeKey, initialValue, rangeToDraft);
}
