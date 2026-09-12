import { Settings } from "lucide-react";
import { NavLink, useLocation } from "react-router-dom";
import type { SiteCapabilities } from "../../api/queries";

export interface SettingsNavigationItemProps {
  capabilities: SiteCapabilities;
  search: string;
}

export function SettingsNavigationItem({ search }: SettingsNavigationItemProps) {
  const location = useLocation();

  return (
    <NavLink
      to={{ pathname: "/settings", search, hash: location.hash }}
      className={({ isActive }) => isActive ? "nav-item active" : "nav-item"}
    >
      <Settings size={18} aria-hidden="true" />
      <span>설정</span>
    </NavLink>
  );
}
