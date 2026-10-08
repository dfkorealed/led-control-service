/** Canonical date-only drafts come from DatePicker; completion is the API's site-local day. */
export function completedDateBounds(from: string, to: string, completedDate: string) {
  const maximum = completedDate || undefined;
  // A future draft must remain editable, but it cannot become an end-picker
  // minimum above the completion maximum. Cap the constraint, never the draft
  // or its sibling; each consumer still rejects empty/reversed/future periods.
  return {
    start: { maxValue: to && (!maximum || to < maximum) ? to : maximum },
    end: { minValue: from ? (maximum && from > maximum ? maximum : from) : undefined, maxValue: maximum }
  };
}
