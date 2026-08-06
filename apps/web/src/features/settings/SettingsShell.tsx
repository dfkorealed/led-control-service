import { useCallback } from "react";
import { NavLink, Outlet, useLocation } from "react-router-dom";
import type { AuthUser } from "../../api/auth";
import { useSites } from "../../api/queries";
import { SiteSwitcher } from "../sites/SiteSwitcher";
import { useFloorEditorStore } from "../floor-editor/editor-store";
import { settingsSectionsFor } from "./settings-sections";

interface SettingsShellProps {
  userRole: AuthUser["role"];
  selectedSiteId?: string;
}

export function SettingsShell({ userRole, selectedSiteId }: SettingsShellProps) {
  const { data: sites = [] } = useSites();
  const location = useLocation();
  const sections = settingsSectionsFor(userRole);
  const isEditorDirty = useFloorEditorStore((store) => store.isDirty);
  const discardEditorChanges = useFloorEditorStore((store) => store.discardChanges);
  const canSelectSite = useCallback(() => {
    if (!isEditorDirty) return true;
    if (!window.confirm("저장하지 않은 변경사항이 있습니다. 이동하시겠습니까?")) return false;
    discardEditorChanges();
    return true;
  }, [discardEditorChanges, isEditorDirty]);

  return (
    <section className="settings-workspace">
      <aside className="settings-sidebar" aria-label="설정 메뉴">
        <SiteSwitcher
          sites={sites}
          selectedSiteId={selectedSiteId}
          canSelectSite={canSelectSite}
        />
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
