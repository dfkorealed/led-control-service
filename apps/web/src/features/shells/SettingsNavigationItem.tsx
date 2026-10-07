import { Settings, type LucideIcon } from "lucide-react";
import { useId, useState } from "react";
import { NavLink, useLocation, type To } from "react-router-dom";
import type { SiteCapabilities } from "../../api/queries";

export interface SettingsNavigationItemProps {
  capabilities: SiteCapabilities;
  search: string;
  layout?: NavigationLayout;
}
export type NavigationLayout = "mobile" | "rail" | "expanded";

export function primaryNavigationClass(isActive: boolean, layout: NavigationLayout = "mobile") {
  const base = `flex w-full items-center rounded-control border text-body-sm font-bold no-underline focus-visible:outline-none focus-visible:shadow-focus ${layout === "expanded" ? "min-h-11 justify-start gap-3 px-3 py-2" : "min-h-12 flex-col justify-center gap-1 p-1 text-center"}`;
  return isActive
    ? `${base} border-action-primary bg-action-primary-soft text-action-primary`
    : `${base} border-transparent bg-transparent text-content-muted hover:bg-action-primary-soft hover:text-action-primary`;
}

/** A single link owner keeps rail and full navigation destinations identical. */
export function PrimaryNavigationLink({ to, label, icon: Icon, layout = "mobile", active = false }: { to: To; label: string; icon: LucideIcon; layout?: NavigationLayout; active?: boolean }) {
  const tooltipId = useId();
  const [tooltipOpen, setTooltipOpen] = useState(false);
  return <span className="relative block min-w-0" onMouseEnter={() => setTooltipOpen(true)} onMouseLeave={() => setTooltipOpen(false)}>
    <NavLink to={to} aria-label={label} aria-current={active ? "page" : undefined} data-shell-navigation-item
      aria-describedby={layout === "rail" && tooltipOpen ? tooltipId : undefined}
      className={({ isActive }) => primaryNavigationClass(active || isActive, layout)}
      onFocus={() => setTooltipOpen(true)} onBlur={() => setTooltipOpen(false)} onKeyDown={event => { if (event.key === "Escape") setTooltipOpen(false); }}>
      <Icon size={20} aria-hidden="true" /><span className={layout === "rail" ? "sr-only" : undefined}>{label}</span>
    </NavLink>
    {layout === "rail" && tooltipOpen ? <span id={tooltipId} role="tooltip" className="absolute top-0 left-full z-60 ml-2 rounded-control bg-surface-inverse px-2 py-1.5 text-caption font-bold whitespace-nowrap text-content-inverse shadow-popover">{label}</span> : null}
  </span>;
}

export function SettingsNavigationItem({ search, layout }: SettingsNavigationItemProps) {
  const location = useLocation();

  return (
    <PrimaryNavigationLink
      to={{ pathname: "/settings", search, hash: location.hash }}
      label="설정" icon={Settings} layout={layout}
    />
  );
}
