export interface KindaLogoProps {
  context?: string;
  className?: string;
  compact?: boolean;
}

export function KindaLogo({ context, className, compact = false }: KindaLogoProps) {
  const classes = ["kinda-logo", className].filter(Boolean).join(" ");
  const accessibleName = context ? `킨다 ${context}` : "킨다";

  return (
    <div className={classes} data-compact={compact || undefined} role="img" aria-label={accessibleName}>
      <img className="kinda-logo-mark" src="/brand/kinda-mark.svg" alt="" aria-hidden="true" width="42" height="42" />
      <span className="kinda-logo-copy" aria-hidden="true">
        <strong>킨다</strong>
        {context ? <span>{context}</span> : null}
      </span>
    </div>
  );
}
