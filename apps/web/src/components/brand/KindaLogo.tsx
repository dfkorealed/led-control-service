import { cn } from "../ui/utils/cn";

export interface KindaLogoProps {
  context?: string;
  className?: string;
  compact?: boolean;
}

export function KindaLogo({ context, className, compact = false }: KindaLogoProps) {
  const classes = cn(
    "inline-flex items-center gap-3 text-brand-navy",
    compact && "mb-6 w-full flex-col gap-0",
    className
  );
  const accessibleName = context ? `킨다 ${context}` : "킨다";

  return (
    <div className={classes} data-compact={compact || undefined} data-kinda-logo role="img" aria-label={accessibleName}>
      <img className="block size-10 shrink-0" data-kinda-logo-mark src="/brand/kinda-mark.svg" alt="" aria-hidden="true" width="42" height="42" />
      <span className={`min-w-0 gap-0.5 ${compact ? "hidden" : "grid"}`} aria-hidden="true">
        <strong className="text-card-title font-black text-brand-navy">킨다</strong>
        {context ? <span className="text-overline font-bold text-brand-blue">{context}</span> : null}
      </span>
    </div>
  );
}
