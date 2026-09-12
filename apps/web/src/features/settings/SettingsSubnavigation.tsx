import { useEffect, useRef } from "react";
import { NavLink, useLocation } from "react-router-dom";
import type { SiteCapabilities } from "../../api/queries";
import { UnderlineNavigation, UnderlineNavigationLabel } from "../../components/ui";
import { settingsSectionsFor } from "./settings-sections";

export function SettingsSubnavigation({ capabilities }: { capabilities: SiteCapabilities }) {
  const location = useLocation();
  const navigationRef = useRef<HTMLElement>(null);

  useEffect(() => {
    const activeTab = navigationRef.current?.querySelector<HTMLElement>('[aria-current="page"]');
    if (typeof activeTab?.scrollIntoView === "function") {
      activeTab.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [location.pathname]);

  return (
    <UnderlineNavigation
      ref={navigationRef}
      className="settings-subnavigation"
      trackClassName="settings-subnavigation-track"
      aria-label="설정 메뉴"
    >
      {settingsSectionsFor(capabilities).map((section) => (
        <NavLink
          end={section.path === "/settings"}
          key={section.path}
          to={{ pathname: section.path, search: location.search, hash: location.hash }}
          className={({ isActive }) => isActive
            ? "ui-underline-navigation-item settings-subnavigation-link active"
            : "ui-underline-navigation-item settings-subnavigation-link"}
        >
          <UnderlineNavigationLabel>{section.label}</UnderlineNavigationLabel>
        </NavLink>
      ))}
    </UnderlineNavigation>
  );
}
