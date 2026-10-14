import { LoaderCircle, type LucideProps } from "lucide-react";
import { forwardRef, type HTMLAttributes } from "react";
import { Text } from "./Typography";
import { cn } from "./utils/cn";

/** Decorative by itself: the action or status host owns the accessible label.
 * Inherit the host foreground so inverse buttons keep a readable spinner. */
export const LoadingSpinner = forwardRef<SVGSVGElement, LucideProps>(function LoadingSpinner({ className, ...props }, ref) {
  return <LoaderCircle {...props} ref={ref} aria-hidden="true" className={cn("size-5 shrink-0 animate-spin motion-reduce:animate-none", className)} />;
});

/** Inline pending feedback, also safe inside compact lists and dialog bodies.
 * Paused requests announce connectivity without animating. Callers must not
 * mount an active indicator for a disabled/idle observer or domain waiting. */
export const LoadingIndicator = forwardRef<HTMLSpanElement, HTMLAttributes<HTMLSpanElement> & { isPaused?: boolean }>(function LoadingIndicator({ children, className, isPaused = false, ...props }, ref) {
  return <span {...props} ref={ref} role="status" aria-live="polite" aria-busy={isPaused ? undefined : true} className={cn("inline-flex min-w-0 items-center gap-2 text-content-secondary", className)}>
    {!isPaused && <LoadingSpinner />}<Text as="span" variant="body-sm" tone="secondary" className="min-w-0 break-words">{isPaused ? "네트워크 연결을 기다리고 있습니다." : children}</Text>
  </span>;
});
