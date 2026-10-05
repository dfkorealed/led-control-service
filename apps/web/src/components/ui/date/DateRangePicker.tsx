import { forwardRef, useRef } from "react";
import { Button, DateRangePicker as AriaDateRangePicker, Dialog, Group, I18nProvider, Popover, RangeCalendar } from "react-aria-components";
import { FormField, fieldAria } from "../fields/FormField";
import { RegisteredPopoverContent } from "../overlays/RegisteredPopoverContent";
import { cn } from "../utils/cn";
import { CalendarContent } from "./Calendar";
import { calendarTriggerClass, datePopoverClass } from "./DatePicker";
import { formatIsoDate, parseBounds, parseDateRange, parseIsoDate, type DateRangeValue } from "./date-adapters";
import { SegmentedInput, useSegmentedField, type DateFieldOptions, type FocusableFieldHandle, type RangeDraftEdit } from "./date-field";
import { dateToDraft, draftToDate, isEmptyDateDraft, type DateSegmentDraft } from "./useDateDraft";
import type { DateRangeDraftController } from "./useDateRangeDraft";

export interface DateRangePickerProps extends Omit<DateFieldOptions, "name"> {
  value: DateRangeValue | null;
  minValue?: string;
  maxValue?: string;
  onChange(value: DateRangeValue | null): void;
  draftController?: DateRangeDraftController;
}
export const DateRangePicker = /* @__PURE__ */ forwardRef<FocusableFieldHandle, DateRangePickerProps>(function DateRangePicker(
  { value, onChange, draftController, minValue, maxValue, label, description, errorMessage, variant, size, className, id, ...props }, ref
) {
  const focus = useSegmentedField(ref, props.isDisabled, props.isReadOnly);
  const startRestoring = useRef(!!draftController);
  const endRestoring = useRef(!!draftController);
  const latestDraft = useRef(draftController?.draft);
  latestDraft.current = draftController?.draft;
  const empty = dateToDraft(null);
  const startEdit = useRef<RangeDraftEdit>({ accepted: draftController?.draft.start ?? empty, pending: null, restoreRequested: true });
  const endEdit = useRef<RangeDraftEdit>({ accepted: draftController?.draft.end ?? empty, pending: null, restoreRequested: true });
  const acceptEndpoint = (endpoint: "start" | "end", draft: DateSegmentDraft) => {
    const edit = endpoint === "start" ? startEdit : endEdit;
    edit.current.accepted = draft;
    edit.current.pending = null;
    edit.current.restoreRequested = true;
    (endpoint === "start" ? startRestoring : endRestoring).current = true;
  };
  const start = draftController ? draftToDate(draftController.draft.start) : null;
  const end = draftController ? draftToDate(draftController.draft.end) : null;
  const canonical = draftController ? (start && end ? { start, end } : null) : value;
  // Clearing the canonical range resets both RAC field states, including the
  // untouched endpoint. Both bridges restore raw input for that transition.
  const valueKey = canonical ? `${canonical.start}/${canonical.end}` : "empty";
  const changeEndpoint = (endpoint: "start" | "end", draft: DateSegmentDraft) => {
    if (!draftController || !latestDraft.current) return;
    // Sibling field effects may publish in one commit; merge against the latest
    // synchronous draft rather than losing the first endpoint's edit.
    const wasEmpty = isEmptyDateDraft(latestDraft.current.start) && isEmptyDateDraft(latestDraft.current.end);
    latestDraft.current = { ...latestDraft.current, [endpoint]: draft };
    acceptEndpoint(endpoint, draft);
    draftController.onDraftChange(latestDraft.current);
    // As with the single picker, a fully cleared raw range must notify even
    // though its incomplete predecessor already had canonical value null.
    if (!wasEmpty && isEmptyDateDraft(latestDraft.current.start) && isEmptyDateDraft(latestDraft.current.end)) onChange(null);
  };
  return <I18nProvider locale="ko-KR"><FormField {...{ label, description, errorMessage, variant, size, className, id }} isGroup isDisabled={props.isDisabled} isInvalid={props.isInvalid}>
    {(attributes) => <AriaDateRangePicker {...props} {...fieldAria(attributes, props)} className="contents"
      value={parseDateRange(canonical)}
      onChange={(next) => {
        if (draftController && (startRestoring.current || endRestoring.current)) return;
        const iso = next === null ? null : { start: formatIsoDate(next.start), end: formatIsoDate(next.end) };
        if (draftController) {
          const nextDraft = { start: dateToDraft(iso?.start ?? null), end: dateToDraft(iso?.end ?? null) };
          // RAC accepts complete edits/calendar selection synchronously, before
          // input auto-advance. Retire the same pending edit used by raw input
          // before a later blur can normalize an older display snapshot.
          latestDraft.current = nextDraft;
          acceptEndpoint("start", nextDraft.start);
          acceptEndpoint("end", nextDraft.end);
          draftController.onDraftChange(nextDraft);
        }
        onChange(iso);
      }}
      {...parseBounds(minValue, maxValue, parseIsoDate)}>
      {({ isOpen, state }) => <><Group id={attributes.id} ref={focus.element} aria-controls={props["aria-controls"]} className={cn(attributes.className, "flex min-w-0 items-center justify-between gap-1 px-1 py-0")}>
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <SegmentedInput slot="start" firstSegment={focus.firstSegment} className="flex min-w-0 items-center"
            draftBinding={draftController && { draft: draftController.draft.start, onDraftChange: draft => changeEndpoint("start", draft), restoring: startRestoring, valueKey, preserveUnedited: true, rangeEdit: startEdit }} />
          <span aria-hidden="true">–</span>
          <SegmentedInput slot="end" className="flex min-w-0 items-center"
            draftBinding={draftController && { draft: draftController.draft.end, onDraftChange: draft => changeEndpoint("end", draft), restoring: endRestoring, valueKey, preserveUnedited: true, rangeEdit: endEdit }} />
        </div>
        <Button className={calendarTriggerClass}><span aria-hidden="true">▦</span></Button>
      </Group>
      {/* Match DatePicker's 4px viewport inset so seven 44px cells fit at 320px. */}
      <Popover containerPadding={4} className={datePopoverClass}><RegisteredPopoverContent isActive={isOpen} onBack={() => state.close()}><Dialog className="outline-none"><RangeCalendar className="flex flex-col gap-2"><CalendarContent /></RangeCalendar></Dialog></RegisteredPopoverContent></Popover></>}
    </AriaDateRangePicker>}
  </FormField></I18nProvider>;
});
