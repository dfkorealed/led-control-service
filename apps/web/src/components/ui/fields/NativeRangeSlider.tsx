import { forwardRef, type CSSProperties, type InputHTMLAttributes } from "react";
import { cn } from "../utils/cn";

export type NativeRangeSliderProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type"> & { fillPercentage: number };

// The public demo retains the native range's DOM, ref, keyboard and touch
// behavior. Coincident native Tailwind stops preserve the original single-paint
// hard edge. Set positions on the input: registered Tailwind properties do not
// inherit, and a root theme gradient would resolve runtime stops too early.
export const NativeRangeSlider = forwardRef<HTMLInputElement, NativeRangeSliderProps>(function NativeRangeSlider({ className, fillPercentage, style, ...props }, ref) {
  const fill = `${fillPercentage}%`;
  const fillStyle = { ...style, "--tw-gradient-from-position": fill, "--tw-gradient-to-position": fill } as CSSProperties;
  return <input {...props} ref={ref} type="range" style={fillStyle} className={cn(
    "w-full h-[7px] m-landing-control-slider-margin rounded-pill outline-none appearance-none cursor-pointer bg-linear-to-r/srgb from-brand-blue to-border-default focus-visible:outline-3 focus-visible:outline-solid focus-visible:outline-brand-navy focus-visible:outline-offset-9",
    "[&::-webkit-slider-thumb]:size-5 [&::-webkit-slider-thumb]:border-4 [&::-webkit-slider-thumb]:border-surface-panel [&::-webkit-slider-thumb]:rounded-landing-ellipse [&::-webkit-slider-thumb]:bg-brand-blue [&::-webkit-slider-thumb]:ring-2 [&::-webkit-slider-thumb]:ring-brand-blue [&::-webkit-slider-thumb]:appearance-none",
    "[&::-moz-range-thumb]:size-3.5 [&::-moz-range-thumb]:border-4 [&::-moz-range-thumb]:border-surface-panel [&::-moz-range-thumb]:rounded-landing-ellipse [&::-moz-range-thumb]:bg-brand-blue [&::-moz-range-thumb]:ring-2 [&::-moz-range-thumb]:ring-brand-blue",
    className
  )} />;
});
