import { NavLink, Outlet, useLocation } from "react-router-dom";
import type { AuthUser } from "../../api/auth";
import { useSites } from "../../api/queries";
import { SiteSwitcher } from "../sites/SiteSwitcher";
import { settingsSectionsFor } from "./settings-sections";

interface SettingsShellProps {
  userRole: AuthUser["role"];
  selectedSiteId?: string;
}

export function SettingsShell({ userRole, selectedSiteId }: SettingsShellProps) {
  const { data: sites = [] } = useSites();
  const location = useLocation();
  const sections = settingsSectionsFor(userRole);

  return (
    <section className="settings-workspace">
      <aside className="settings-sidebar" aria-label="설정 메뉴">
        <SiteSwitcher sites={sites} selectedSiteId={selectedSiteId} />
        <nav className="settings-nav">
          {sections.map((section) => (
            <NavLink
              className={({ isActive }) => isActive ? "settings-nav-link active" : "settings-nav-link"}
              key={section.label}
              to={`${section.path}${location.search}`}
            >
              {section.label}
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="settings-content">
        <Outlet />
      </div>
    </section>
  );
}
