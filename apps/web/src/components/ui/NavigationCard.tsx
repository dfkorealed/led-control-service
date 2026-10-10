import { forwardRef, type ReactNode } from "react";
import { Link, type LinkProps, type To } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { Heading, Text } from "./Typography";
import { cn } from "./utils/cn";

export interface NavigationCardProps extends Omit<LinkProps, "to" | "title" | "children"> {
  to: To;
  icon: ReactNode;
  title: string;
  description?: ReactNode;
  summary?: ReactNode;
}

/** The whole card is one link; description/summary slots contain informational content. */
export const NavigationCard = forwardRef<HTMLAnchorElement, NavigationCardProps>(function NavigationCard(
  { to, icon, title, description, summary, className, ...props }, ref
) {
  return <Link {...props} ref={ref} to={to} className={cn("flex min-w-0 items-center gap-4 rounded-panel border border-border-default bg-surface-panel p-5 outline-none focus-visible:shadow-focus hover:bg-surface-inset max-compact:p-4", className)}>
    <span aria-hidden="true" className="inline-flex size-12 shrink-0 items-center justify-center rounded-control bg-surface-inset text-action-primary">{icon}</span>
    <div className="grid min-w-0 flex-1 gap-1">
      <Heading as="h2" variant="customer-card-title">{title}</Heading>
      {description != null ? <Text as="span" variant="body-sm" tone="secondary">{description}</Text> : null}
      {summary != null ? <span className="text-body-sm text-content-secondary">{summary}</span> : null}
    </div>
    <ArrowRight size={18} aria-hidden="true" className="shrink-0 text-content-muted" />
  </Link>;
});
