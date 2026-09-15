import { forwardRef } from "react";
import { Button, DateRangePicker as AriaDateRangePicker, Dialog, Group, I18nProvider, Popover, RangeCalendar } from "react-aria-components";
import { FormField, fieldAria } from "../fields/FormField";
import { cn } from "../utils/cn";
import { CalendarContent } from "./Calendar";
import { calendarTriggerClass, datePopoverClass } from "./DatePicker";
import { formatIsoDate, parseBounds, parseDateRange, parseIsoDate, type DateRangeValue } from "./date-adapters";
import { SegmentedInput, useSegmentedField, type DateFieldOptions, type FocusableFieldHandle } from "./date-field";

export interface DateRangePickerProps extends Omit<DateFieldOptions, "name"> {
  value: DateRangeValue | null;
  minValue?: string;
  maxValue?: string;
  onChange(value: DateRangeValue | null): void;
}
export const DateRangePicker = forwardRef<FocusableFieldHandle, DateRangePickerProps>(function DateRangePicker(
  { value, onChange, minValue, maxValue, label, description, errorMessage, variant, size, className, id, ...props }, ref
) {
  const focus = useSegmentedField(ref, props.isDisabled, props.isReadOnly);
  return <I18nProvider locale="ko-KR"><FormField {...{ label, description, errorMessage, variant, size, className, id }} isGroup isDisabled={props.isDisabled} isInvalid={props.isInvalid}>
    {(attributes) => <AriaDateRangePicker {...props} {...fieldAria(attributes, props)} className="contents"
      value={parseDateRange(value)}
      onChange={(next) => onChange(next === null ? null : { start: formatIsoDate(next.start), end: formatIsoDate(next.end) })}
      {...parseBounds(minValue, maxValue, parseIsoDate)}>
      <Group id={attributes.id} ref={focus.element} aria-controls={props["aria-controls"]} className={cn(attributes.className, "flex min-w-0 items-center justify-between gap-1 px-1 py-0")}>
        <div className="flex min-w-0 flex-wrap items-center gap-1">
          <SegmentedInput slot="start" firstSegment={focus.firstSegment} className="flex min-w-0 items-center" />
          <span aria-hidden="true">–</span>
          <SegmentedInput slot="end" className="flex min-w-0 items-center" />
        </div>
        <Button className={calendarTriggerClass}><span aria-hidden="true">▦</span></Button>
      </Group>
      {/* Match DatePicker's 4px viewport inset so seven 44px cells fit at 320px. */}
      <Popover containerPadding={4} className={datePopoverClass}><Dialog className="outline-none"><RangeCalendar className="flex flex-col gap-2"><CalendarContent /></RangeCalendar></Dialog></Popover>
    </AriaDateRangePicker>}
  </FormField></I18nProvider>;
});
