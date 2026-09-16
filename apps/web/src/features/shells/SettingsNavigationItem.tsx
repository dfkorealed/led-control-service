import { Settings } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import type { SiteCapabilities } from "../../api/queries";

export interface SettingsNavigationItemProps {
  capabilities: SiteCapabilities;
  search: string;
}

export function primaryNavigationClass(isActive: boolean) {
  const base = "nav-item flex min-h-16 w-full flex-col items-center justify-center gap-1 rounded-control border p-1 text-center text-overline font-bold no-underline";
  return isActive
    ? `${base} active border-action-primary bg-action-primary-soft text-action-primary`
    : `${base} border-transparent bg-transparent text-content-muted hover:bg-action-primary-soft hover:text-action-primary`;
}

export function SettingsNavigationItem({ search }: SettingsNavigationItemProps) {
  const location = useLocation();

  return (
    <NavLink
      to={{ pathname: "/settings", search, hash: location.hash }}
      className={({ isActive }) => primaryNavigationClass(isActive)}
    >
      <Settings size={18} aria-hidden="true" />
      <span>설정</span>
    </NavLink>
  );
}
