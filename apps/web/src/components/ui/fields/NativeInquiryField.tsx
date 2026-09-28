import { forwardRef, useId, type InputHTMLAttributes, type SelectHTMLAttributes, type TextareaHTMLAttributes, type ReactNode } from "react";
import { cn } from "../utils/cn";

type Field = { label: string; errorMessage?: string; optional?: boolean; className?: string };
const control = "block w-full min-h-11 rounded-landing-compact-control border border-border-strong bg-surface-panel px-3 py-2.5 font-normal text-brand-navy outline-offset-2 focus-visible:outline-offset-2! focus-visible:outline-3 focus-visible:outline-solid focus-visible:outline-brand-navy aria-invalid:border-status-inquiry-danger-foreground! disabled:opacity-65 disabled:cursor-wait";
function Frame({ label, id, errorMessage, optional, required, className, children }: Field & { id: string; required?: boolean; children: ReactNode }) {
  return <div className={cn("inquiry-field grid min-w-0 content-start gap-landing-concept-inquiry-field-gap", className)}>
    <label htmlFor={id} className="text-landing-concept-inquiry-label font-extrabold">{label}{required && <> <span aria-hidden="true" className="text-status-inquiry-danger-foreground">*</span></>}{optional && <> <span className="text-landing-concept-inquiry-optional font-medium text-content-secondary">선택</span></>}</label>
    {children}
    {errorMessage && <p id={`${id}-error`} className="m-0 text-landing-concept-inquiry-error text-status-inquiry-danger-foreground">{errorMessage}</p>}
  </div>;
}
export const NativeInquiryInput = forwardRef<HTMLInputElement, Field & InputHTMLAttributes<HTMLInputElement>>(function NativeInquiryInput({ label, errorMessage, optional, className, id: givenId, ...props }, ref) {
  const generatedId = useId(); const id = givenId ?? generatedId;
  return <Frame {...{ label, errorMessage, optional, className, id }} required={props.required}><input {...props} ref={ref} id={id} aria-invalid={!!errorMessage || undefined} aria-describedby={errorMessage ? `${id}-error` : undefined} className={control} /></Frame>;
});
export const NativeInquiryTextArea = forwardRef<HTMLTextAreaElement, Field & TextareaHTMLAttributes<HTMLTextAreaElement>>(function NativeInquiryTextArea({ label, errorMessage, optional, className, id: givenId, ...props }, ref) {
  const generatedId = useId(); const id = givenId ?? generatedId;
  return <Frame {...{ label, errorMessage, optional, className, id }} required={props.required}><textarea {...props} ref={ref} id={id} aria-invalid={!!errorMessage || undefined} aria-describedby={errorMessage ? `${id}-error` : undefined} className={cn(control, "min-h-[114px] resize-y leading-landing-concept-inquiry-message")} /></Frame>;
});
export const NativeInquirySelect = forwardRef<HTMLSelectElement, Field & SelectHTMLAttributes<HTMLSelectElement>>(function NativeInquirySelect({ label, errorMessage, optional, className, id: givenId, children, ...props }, ref) {
  const generatedId = useId(); const id = givenId ?? generatedId;
  return <Frame {...{ label, errorMessage, optional, className, id }} required={props.required}><select {...props} ref={ref} id={id} aria-invalid={!!errorMessage || undefined} aria-describedby={errorMessage ? `${id}-error` : undefined} className={control}>{children}</select></Frame>;
});
export const NativeInquiryCheckbox = forwardRef<HTMLInputElement, Field & InputHTMLAttributes<HTMLInputElement>>(function NativeInquiryCheckbox({ label, errorMessage, className, id: givenId, ...props }, ref) {
  const generatedId = useId(); const id = givenId ?? generatedId;
  return <div className={cn("inquiry-consent grid min-w-0 content-start gap-landing-concept-inquiry-field-gap", className)}><label htmlFor={id} className="inline-flex w-fit items-start gap-landing-concept-inquiry-consent-gap text-landing-concept-inquiry-label font-extrabold cursor-pointer"><input {...props} ref={ref} id={id} type="checkbox" aria-invalid={!!errorMessage || undefined} aria-describedby={errorMessage ? `${id}-error` : undefined} className="m-0 size-4.5 flex-none accent-brand-blue focus-visible:outline-3 focus-visible:outline-solid focus-visible:outline-brand-navy focus-visible:outline-offset-4 disabled:opacity-65 disabled:cursor-wait" /><span>{label} <span aria-hidden="true" className="text-status-inquiry-danger-foreground">*</span></span></label>{errorMessage && <p id={`${id}-error`} className="m-0 text-landing-concept-inquiry-error text-status-inquiry-danger-foreground">{errorMessage}</p>}</div>;
});
