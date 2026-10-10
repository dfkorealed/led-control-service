import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cva } from "class-variance-authority";
import { Heading, Text } from "./Typography";
import { cn } from "./utils/cn";

type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

export interface PageHeaderProps extends HTMLAttributes<HTMLElement> { variant?: "default" | "customer"; title: string; eyebrow?: ReactNode; description?: ReactNode; status?: ReactNode; actions?: ReactNode; headingLevel?: HeadingLevel }
const header = cva("flex items-start justify-between gap-4 max-compact:flex-col max-compact:items-stretch", { variants: { variant: { default: "", customer: "gap-5 max-compact:gap-3" } } });
export const PageHeader = forwardRef<HTMLElement, PageHeaderProps>(function PageHeader({ variant = "default", title, eyebrow, description, status, actions, headingLevel = 2, className, ...props }, ref) {
  return <header {...props} ref={ref} className={cn(header({ variant }), className)}>
    <div className="grid min-w-0 gap-2">
      {eyebrow != null ? <Text as="div" variant="overline" tone="secondary">{eyebrow}</Text> : null}
      <Heading as={`h${headingLevel}`} variant={variant === "customer" ? "customer-page-title" : "section-title"}>{title}</Heading>
      {description ? <div className="text-body text-content-secondary">{description}</div> : null}
    </div>
    {status || actions ? <div className="flex flex-wrap items-center gap-2 max-compact:w-full">{status}{actions}</div> : null}
  </header>;
});
