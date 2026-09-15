import { forwardRef, useContext, useImperativeHandle, useRef, type AriaAttributes, type RefObject } from "react";
import { Slider as AriaSlider, SliderTrack, SliderFill, SliderStateContext, SliderTrackContext, LabelContext, useSlottedContext, type SliderProps as AriaSliderProps } from "react-aria-components";
import { mergeProps, useFocusRing, useSliderThumb, VisuallyHidden } from "react-aria";
import { FormField, type FormFieldProps } from "./FormField";
import { cn } from "../utils/cn";
import { fieldControl, type SelectionVisualProps } from "./field-types";

export interface SliderProps extends SelectionVisualProps, Pick<AriaAttributes, "aria-controls">, Omit<AriaSliderProps<number>, keyof SelectionVisualProps | "children" | "style" | "render" | "orientation"> {
  isInvalid?: boolean;
}

function SliderField(props: FormFieldProps) {
  const state = useContext(SliderStateContext)!;
  const labelProps = useSlottedContext(LabelContext);
  // The upstream label focuses a generated ID. Our native ID is caller-owned,
  // so focus through the shared state and the thumb's real input ref instead.
  return <LabelContext.Provider value={{ ...labelProps, onClick: () => state.setFocusedThumb(0) }}><FormField {...props} /></LabelContext.Provider>;
}

function SliderInputThumb({ inputRef, id, ...props }: Pick<SliderProps, "id" | "aria-controls" | "aria-describedby" | "isInvalid"> & { inputRef: RefObject<HTMLInputElement> }) {
  const state = useContext(SliderStateContext)!;
  // Use the context's mounted track ref, not a new ref for this thumb component.
  const trackRef = useSlottedContext(SliderTrackContext)!.ref as RefObject<HTMLDivElement>;
  const { thumbProps, inputProps, isDisabled } = useSliderThumb({ ...props, index: 0, inputRef, trackRef }, state);
  const { focusProps, isFocusVisible } = useFocusRing();
  // RAC SliderThumb generates its input ID and omits aria-controls. Public hooks
  // retain its state/drag/keyboard behavior while we own the native input props.
  // Anchor the hook's translateY(-50%) at the track center, not its static position.
  return <div {...thumbProps} data-focus-visible={isFocusVisible || undefined} data-disabled={isDisabled || undefined} className="top-1/2 flex h-11 w-11 items-center justify-center rounded-pill outline-none data-focus-visible:shadow-focus data-disabled:opacity-60">
    <VisuallyHidden><input {...mergeProps(inputProps, focusProps)} id={id} aria-controls={props["aria-controls"]} ref={inputRef} /></VisuallyHidden>
    <span aria-hidden="true" className="h-5 w-5 rounded-pill border border-action-primary bg-action-primary" />
  </div>;
}
export const Slider = forwardRef<HTMLInputElement, SliderProps>(function Slider(
  { label, description, errorMessage, variant, size, className, id, isInvalid, ...props }, ref
) {
  const inputRef = useRef<HTMLInputElement>(null);
  useImperativeHandle(ref, () => inputRef.current!);
  return <AriaSlider {...props} className="contents">
    <SliderField {...{ label, description, errorMessage, variant, size, className, id, isInvalid }} labelMode="aria" isDisabled={props.isDisabled}>
    {(attributes) => <div aria-invalid={isInvalid || undefined} className={cn(fieldControl({ variant, size }), "flex items-center")}>
      <SliderTrack className="relative flex min-h-11 w-full items-center">
        <div aria-hidden="true" className="absolute h-1 w-full rounded-pill bg-border-strong"><SliderFill className="absolute h-full rounded-pill bg-action-primary" /></div>
        <SliderInputThumb id={attributes.id} inputRef={inputRef} aria-controls={props["aria-controls"]} aria-describedby={attributes["aria-describedby"]} isInvalid={isInvalid} />
      </SliderTrack>
    </div>}
    </SliderField>
  </AriaSlider>;
});
