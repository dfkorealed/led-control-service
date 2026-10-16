import { LoadingState } from "./LoadingState";
import { forwardRef, type HTMLAttributes } from "react";
import { cva } from "class-variance-authority";
import { cn } from "./utils/cn";
import { PageStack } from "./FunctionalLayout";

export interface RouteLoadingStateProps extends HTMLAttributes<HTMLElement> { variant?: "page" | "panel" }
const loading = cva("", { variants: { variant: { page: "min-h-screen bg-surface-canvas", panel: "" } } });
export const RouteLoadingState = forwardRef<HTMLElement, RouteLoadingStateProps>(function RouteLoadingState({ variant = "panel", className, ...props }, ref) {
  const content = <LoadingState
    {...(variant === "panel" ? props : {})}
    ref={variant === "panel" ? ref : undefined}
    className={variant === "panel" ? cn(loading({ variant }), className) : undefined}
    tone="info"
    title="화면을 불러오는 중입니다."
  />;

  if (variant === "page") {
    return <main {...props} ref={ref} className={cn(loading({ variant }), className)}><PageStack className="mx-auto w-full max-w-6xl px-7 py-6 max-compact:px-3.5 max-compact:py-4.5">{content}</PageStack></main>;
  }

  return content;
});
