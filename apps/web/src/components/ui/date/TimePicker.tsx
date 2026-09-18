import { forwardRef } from "react";
import { I18nProvider, TimeField } from "react-aria-components";
import { FormField, fieldAria } from "../fields/FormField";
import { cn } from "../utils/cn";
import { formatLocalTime, parseBounds, parseLocalTime } from "./date-adapters";
import { SegmentedInput, useSegmentedField, type DateFieldOptions, type FocusableFieldHandle } from "./date-field";

export interface TimePickerProps extends DateFieldOptions {
  value: string | null;
  minValue?: string;
  maxValue?: string;
  onChange(value: string | null): void;
}
export const TimePicker = /* @__PURE__ */ forwardRef<FocusableFieldHandle, TimePickerProps>(function TimePicker(
  { value, onChange, minValue, maxValue, label, description, errorMessage, variant, size, className, id, ...props }, ref
) {
  const focus = useSegmentedField(ref, props.isDisabled, props.isReadOnly);
  return <I18nProvider locale="ko-KR"><FormField {...{ label, description, errorMessage, variant, size, className, id }} isGroup isDisabled={props.isDisabled} isInvalid={props.isInvalid}>
    {(attributes) => <TimeField {...props} {...fieldAria(attributes, props)} hourCycle={24} granularity="minute"
      value={value === null ? null : parseLocalTime(value)} onChange={(next) => onChange(next === null ? null : formatLocalTime(next))}
      {...parseBounds(minValue, maxValue, parseLocalTime)}
      className="contents">
      {/* Read React Aria's actual validation state, including min/max and native
          submit errors, while the caller id/ref stays on the styled DOM root. */}
      {({ isInvalid, isDisabled }) => <div id={attributes.id} ref={focus.element} aria-controls={props["aria-controls"]} data-invalid={isInvalid || undefined} data-disabled={isDisabled || undefined} className={cn(attributes.className, "flex min-w-0 items-center px-1 py-0")}>
        <SegmentedInput firstSegment={focus.firstSegment} className="flex items-center" />
      </div>}
    </TimeField>}
  </FormField></I18nProvider>;
});
