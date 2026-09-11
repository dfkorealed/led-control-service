import { createElement, type HTMLAttributes, type ReactNode } from "react";

export interface UnderlineNavigationProps extends HTMLAttributes<HTMLElement> {
  as?: "div" | "nav";
  trackClassName?: string;
}

export function UnderlineNavigation({
  as = "nav",
  children,
  className,
  trackClassName,
  ...props
}: UnderlineNavigationProps) {
  return createElement(
    as,
    { ...props, className: classNames("ui-underline-navigation", className) },
    <div className={classNames("ui-underline-navigation-track", trackClassName)}>{children}</div>
  );
}

export function UnderlineNavigationLabel({
  children,
  icon
}: {
  children: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <span className="ui-underline-navigation-label">
      {icon ? <span className="ui-underline-navigation-icon" aria-hidden="true">{icon}</span> : null}
      <span>{children}</span>
    </span>
  );
}

function classNames(...values: Array<string | undefined>) {
  return values.filter(Boolean).join(" ");
}
