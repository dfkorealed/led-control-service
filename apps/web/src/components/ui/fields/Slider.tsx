import { forwardRef, useImperativeHandle, useRef } from "react";
import { Slider as AriaSlider, SliderTrack, SliderFill, SliderThumb, type SliderProps as AriaSliderProps } from "react-aria-components";
import { FormField } from "./FormField";
import { cn } from "../utils/cn";
import { fieldControl, type SelectionVisualProps } from "./field-types";

export interface SliderProps extends SelectionVisualProps, Omit<AriaSliderProps<number>, keyof SelectionVisualProps | "children" | "style" | "render" | "orientation"> {
  isInvalid?: boolean;
}
export const Slider = forwardRef<HTMLInputElement, SliderProps>(function Slider(
  { label, description, errorMessage, variant, size, className, id, isInvalid, ...props }, ref
) {
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inputRef.current!);
  return <AriaSlider {...props} className="contents">
    <FormField {...{ label, description, errorMessage, variant, size, className, id, isInvalid }} labelMode="aria" isDisabled={props.isDisabled}>
    {(attributes) => <div aria-invalid={isInvalid || undefined} className={cn(fieldControl({ variant, size }), "flex items-center")}>
      <SliderTrack className="relative flex min-h-11 w-full items-center">
        <div aria-hidden="true" className="absolute h-1 w-full rounded-pill bg-border-strong"><SliderFill className="absolute h-full rounded-pill bg-action-primary" /></div>
        <SliderThumb inputRef={inputRef} aria-describedby={attributes["aria-describedby"]} isInvalid={isInvalid} className="flex h-11 w-11 items-center justify-center rounded-pill outline-none data-focus-visible:shadow-focus data-disabled:opacity-60">
          <span aria-hidden="true" className="h-5 w-5 rounded-pill border border-action-primary bg-action-primary" />
        </SliderThumb>
      </SliderTrack>
    </div>}
    </FormField>
  </AriaSlider>;
});
