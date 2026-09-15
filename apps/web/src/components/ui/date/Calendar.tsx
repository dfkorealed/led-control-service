import { forwardRef, type AriaAttributes } from "react";
import { Calendar as AriaCalendar, CalendarCell, CalendarGrid, CalendarGridBody, CalendarGridHeader, CalendarHeaderCell, Button, Heading, I18nProvider, type CalendarProps as AriaCalendarProps } from "react-aria-components";
import type { CalendarDate } from "@internationalized/date";
import { FormField, fieldAria } from "../fields/FormField";
import type { SelectionVisualProps } from "../fields/field-types";
import { cn } from "../utils/cn";
import { formatIsoDate, parseBounds, parseIsoDate } from "./date-adapters";

export interface CalendarProps extends SelectionVisualProps, AriaAttributes, Pick<AriaCalendarProps<CalendarDate>, "id" | "isDisabled" | "isReadOnly" | "isInvalid" | "aria-label" | "aria-labelledby" | "aria-describedby"> {
  value: string | null;
  minValue?: string;
  maxValue?: string;
  onChange(value: string | null): void;
}

export function CalendarContent() {
  return <>
    <header className="flex items-center justify-between gap-1">
      <Button slot="previous" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-border-strong bg-surface-panel p-0 text-content-primary outline-none data-focus-visible:shadow-focus data-disabled:opacity-60">‹</Button>
      <Heading className="m-0 text-body font-semibold text-content-primary" />
      <Button slot="next" className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control border border-border-strong bg-surface-panel p-0 text-content-primary outline-none data-focus-visible:shadow-focus data-disabled:opacity-60">›</Button>
    </header>
    <CalendarGrid className="border-collapse">
      <CalendarGridHeader>{(day) => <CalendarHeaderCell className="p-0 text-caption font-semibold text-content-primary">{day}</CalendarHeaderCell>}</CalendarGridHeader>
      <CalendarGridBody>{(date) => <CalendarCell date={date} className="flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-control text-content-primary outline-none hover:bg-action-primary-soft data-focus-visible:shadow-focus data-selected:bg-action-primary data-selected:text-content-inverse data-disabled:cursor-not-allowed data-disabled:text-content-disabled data-outside-month:invisible" />}</CalendarGridBody>
    </CalendarGrid>
  </>;
}

export const Calendar = forwardRef<HTMLDivElement, CalendarProps>(function Calendar(
  { value, onChange, minValue, maxValue, label, description, errorMessage, variant, size, className, id, ...props }, ref
) {
  return <I18nProvider locale="ko-KR"><FormField {...{ label, description, errorMessage, variant, size, className, id }} isGroup isDisabled={props.isDisabled} isInvalid={props.isInvalid}>
    {(attributes) => <AriaCalendar {...props} {...fieldAria(attributes, props)} id={attributes.id} ref={ref}
      value={value === null ? null : parseIsoDate(value)} onChange={(next) => onChange(formatIsoDate(next))}
      {...parseBounds(minValue, maxValue, parseIsoDate)}
      className={cn(attributes.className, "flex w-fit max-w-full flex-col gap-2 p-0")}><CalendarContent /></AriaCalendar>}
  </FormField></I18nProvider>;
});
