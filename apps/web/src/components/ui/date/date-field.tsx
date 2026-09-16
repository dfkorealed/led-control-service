import { forwardRef, useContext, useImperativeHandle, useRef, type AriaAttributes, type Ref } from "react";
import { DateInput, DateSegment, DateFieldStateContext, TimeFieldStateContext, type DateInputProps, type DatePickerProps, type DateSegmentProps } from "react-aria-components";
import type { CalendarDate } from "@internationalized/date";
import type { FieldVisualProps } from "../fields/field-types";

export interface FocusableFieldHandle {
  /** No-op when disabled or read-only: there is no editable segment in those states. */
  focus(): void;
  readonly element: HTMLElement | null;
}
export interface DateFieldOptions extends FieldVisualProps, AriaAttributes, Pick<DatePickerProps<CalendarDate>,
  "id" | "isDisabled" | "isReadOnly" | "isRequired" | "isInvalid" | "validationBehavior" | "name" | "autoFocus" |
  "aria-label" | "aria-labelledby" | "aria-describedby"> {}

export function useSegmentedField(ref: Ref<FocusableFieldHandle>, isDisabled?: boolean, isReadOnly?: boolean) {
  const element = useRef<HTMLDivElement>(null);
  const firstSegment = useRef<HTMLDivElement>(null);
  useImperativeHandle(ref, () => ({
    get element() { return element.current; },
    focus() { if (!isDisabled && !isReadOnly) firstSegment.current?.focus(); }
  }), [isDisabled, isReadOnly]);
  return { element, firstSegment };
}

function RegisteredSegment({ segment, firstSegment }: { segment: DateSegmentProps["segment"]; firstSegment?: Ref<HTMLDivElement> }) {
  const dateState = useContext(DateFieldStateContext);
  const timeState = useContext(TimeFieldStateContext);
  // Derive registration from React Aria's locale segment order on every render.
  // A closure counter would lose the ref when DateInput rerenders independently.
  const firstType = (dateState ?? timeState)?.segments.find((item) => item.isEditable)?.type;
  return <DateSegment segment={segment} ref={segment.type === firstType ? firstSegment : undefined}
      className={segment.type === "literal" ? "text-content-primary" : "inline-flex min-h-13 min-w-13 items-center justify-center rounded-control tabular-nums text-content-primary outline-none focus:bg-action-primary-soft focus:shadow-focus data-disabled:opacity-60"} />;
}
export const SegmentedInput = /* @__PURE__ */ forwardRef<HTMLDivElement, Omit<DateInputProps, "children"> & { firstSegment?: Ref<HTMLDivElement> }>(function SegmentedInput({ firstSegment, ...props }, ref) {
  return <DateInput {...props} ref={ref}>{(segment) => <RegisteredSegment segment={segment} firstSegment={firstSegment} />}</DateInput>;
});
