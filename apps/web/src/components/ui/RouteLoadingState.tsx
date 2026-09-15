import { LoaderCircle } from "lucide-react";
import { FeedbackState } from "./FeedbackState";
import { forwardRef, type HTMLAttributes } from "react";
import { cva } from "class-variance-authority";
import { cn } from "./utils/cn";

export interface RouteLoadingStateProps extends HTMLAttributes<HTMLElement> { variant?: "page" | "panel" }
const loading = cva("", { variants: { variant: { page: "operator-shell min-h-screen bg-surface-canvas p-6", panel: "" } } });
export const RouteLoadingState = forwardRef<HTMLElement, RouteLoadingStateProps>(function RouteLoadingState({ variant = "panel", className, ...props }, ref) {
  const content = <FeedbackState
    {...(variant === "panel" ? props : {})}
    ref={variant === "panel" ? ref : undefined}
    className={variant === "panel" ? cn(loading({ variant }), className) : undefined}
    tone="info"
    icon={LoaderCircle}
    liveRole="status"
    livePoliteness="polite"
    title="화면을 불러오는 중입니다."
  />;

  if (variant === "page") {
    return <main {...props} ref={ref} className={cn(loading({ variant }), className)}><div className="operator-content">{content}</div></main>;
  }

  return content;
});
