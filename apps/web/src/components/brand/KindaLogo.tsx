import { cn } from "../ui/utils/cn";
import { useContext } from "react";
import { CustomerThemeContext } from "../ui/theme/CustomerThemeProvider";

export interface KindaLogoProps {
  context?: string;
  className?: string;
  compact?: boolean;
  presentation?: "default" | "landing" | "concept" | "header" | "workspace";
}

export function KindaLogo({ context, className, compact = false, presentation = "default" }: KindaLogoProps) {
  const customerTheme = useContext(CustomerThemeContext);
  const isCustomerPresentation = presentation === "header" || presentation === "workspace";
  const accessibleName = context ? `킨다 ${context}` : "킨다";
  if (isCustomerPresentation) return <div role="img" aria-label={accessibleName} data-kinda-logo data-compact={compact || undefined} className={cn("inline-flex shrink-0 items-center gap-2 text-content-primary", className)}>
    <img data-kinda-logo-mark src={customerTheme?.theme === "dark" ? "/brand/kinda-mark-reversed.svg" : "/brand/kinda-mark.svg"} alt="" aria-hidden="true" className="block size-8 shrink-0" width="32" height="32" />
    <strong aria-hidden="true" className={cn("text-card-title font-black text-content-primary", (presentation === "header" || compact) && "sr-only")}>킨다</strong>
    {context ? <span className="sr-only" aria-hidden="true">{context}</span> : null}
  </div>;
  if (presentation === "concept") return <span className="inline-flex items-center gap-2.5"><img className="size-[33px] rounded-landing-brand-mark bg-surface-panel p-landing-brand-mark-inset landing-narrow:size-[30px]" src="/brand/kinda-mark.svg" alt="" /><span>킨다</span></span>;
  const classes = cn(
    "inline-flex items-center gap-3 text-brand-navy",
    compact && "mb-6 w-full flex-col gap-0",
    className
  );

  return (
    <div className={classes} data-compact={compact || undefined} data-kinda-logo role="img" aria-label={accessibleName}>
      <img className={cn("block size-10 shrink-0", presentation === "landing" && "size-[33px] rounded-landing-brand-mark bg-surface-panel p-landing-brand-mark-inset landing-wide:landing-stack:landing-narrow:size-[30px]")} data-kinda-logo-mark src="/brand/kinda-mark.svg" alt="" aria-hidden="true" width="42" height="42" />
      <span className={`min-w-0 gap-0.5 ${compact ? "hidden" : "grid"}`} aria-hidden="true">
        <strong className={cn("text-card-title font-black", presentation === "landing" ? "text-content-inverse" : "text-brand-navy")}>킨다</strong>
        {context ? <span className="text-overline font-bold text-brand-blue">{context}</span> : null}
      </span>
    </div>
  );
}
