import { forwardRef, useRef } from "react";
import { Button, Calendar, DatePicker as AriaDatePicker, Dialog, Group, I18nProvider, Popover } from "react-aria-components";
import { FormField, fieldAria } from "../fields/FormField";
import { RegisteredPopoverContent } from "../overlays/RegisteredPopoverContent";
import { cn } from "../utils/cn";
import { CalendarContent } from "./Calendar";
import { formatIsoDate, parseBounds, parseIsoDate } from "./date-adapters";
import { SegmentedInput, useSegmentedField, type DateFieldOptions, type FocusableFieldHandle } from "./date-field";
import { dateToDraft, draftToDate, isEmptyDateDraft, type DateDraftController, type DateSegmentDraft } from "./useDateDraft";

export interface DatePickerProps extends DateFieldOptions {
  value: string | null;
  minValue?: string;
  maxValue?: string;
  onChange(value: string | null): void;
  draftController?: DateDraftController;
}
export const datePopoverClass = "max-w-full rounded-popover border border-border-strong bg-surface-panel shadow-popover";
export const calendarTriggerClass = "inline-flex min-h-13 min-w-13 shrink-0 items-center justify-center rounded-control border border-border-strong bg-surface-panel p-0 text-content-primary outline-none data-focus-visible:shadow-focus data-disabled:opacity-60";

export const DatePicker = /* @__PURE__ */ forwardRef<FocusableFieldHandle, DatePickerProps>(function DatePicker(
  { value, onChange, draftController, minValue, maxValue, label, description, errorMessage, variant, size, className, id, ...props }, ref
) {
  const focus = useSegmentedField(ref, props.isDisabled, props.isReadOnly);
  const restoring = useRef(!!draftController);
  const canonical = draftController ? draftToDate(draftController.draft) : value;
  const changeDraft = (draft: DateSegmentDraft) => {
    if (!draftController) return;
    const cleared = isEmptyDateDraft(draft) && !isEmptyDateDraft(draftController.draft);
    draftController.onDraftChange(draft);
    // Partial input already maps to canonical null, so RAC suppresses the final
    // null notification. Publish a genuine user clear, never a restoration.
    if (cleared) onChange(null);
  };
  return <I18nProvider locale="ko-KR"><FormField {...{ label, description, errorMessage, variant, size, className, id }} isGroup isDisabled={props.isDisabled} isInvalid={props.isInvalid}>
    {(attributes) => <AriaDatePicker {...props} {...fieldAria(attributes, props)} className="contents"
      value={canonical === null ? null : parseIsoDate(canonical)} onChange={(next) => {
        if (draftController && restoring.current) return;
        const iso = next === null ? null : formatIsoDate(next);
        draftController?.onDraftChange(dateToDraft(iso));
        onChange(iso);
      }}
      {...parseBounds(minValue, maxValue, parseIsoDate)}>
      {({ isOpen, state }) => <><Group id={attributes.id} ref={focus.element} aria-controls={props["aria-controls"]} className={cn(attributes.className, "flex min-w-0 items-center justify-between gap-1 px-1 py-0")}>
        <SegmentedInput firstSegment={focus.firstSegment} className="flex min-w-0 items-center"
          draftBinding={draftController && { draft: draftController.draft, onDraftChange: changeDraft, restoring, valueKey: canonical ?? "empty" }} />
        <Button className={calendarTriggerClass}><span aria-hidden="true">▦</span></Button>
      </Group>
      {/* Seven 44px cells plus borders need 310px. The default 12px viewport
          inset would push the calendar beyond 320px; use the approved 4px inset. */}
      <Popover containerPadding={4} className={datePopoverClass}><RegisteredPopoverContent isActive={isOpen} onBack={() => state.close()}><Dialog className="outline-none"><Calendar className="flex flex-col gap-2"><CalendarContent /></Calendar></Dialog></RegisteredPopoverContent></Popover></>}
    </AriaDatePicker>}
  </FormField></I18nProvider>;
});
