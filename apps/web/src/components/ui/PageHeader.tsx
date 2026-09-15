import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cva } from "class-variance-authority";
import { Heading } from "./Typography";
import { cn } from "./utils/cn";

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface PageHeaderProps extends HTMLAttributes<HTMLElement> { variant?: "default"; title: string; description?: ReactNode; status?: ReactNode; actions?: ReactNode; headingLevel?: HeadingLevel }
const header = cva("ui-page-header flex items-start justify-between gap-4 max-compact:flex-col max-compact:items-stretch", { variants: { variant: { default: "" } } });
export const PageHeader = forwardRef<HTMLElement, PageHeaderProps>(function PageHeader({ variant = "default", title, description, status, actions, headingLevel = 2, className, ...props }, ref) {
  return <header {...props} ref={ref} className={cn(header({ variant }), className)}><div className="grid gap-2"><Heading as={`h${headingLevel}`} variant="section-title">{title}</Heading>{description ? <div className="ui-page-description text-body text-content-secondary">{description}</div> : null}</div>{status || actions ? <div className="ui-page-actions flex flex-wrap items-center gap-2 max-compact:w-full">{status}{actions}</div> : null}</header>;
});
