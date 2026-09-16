import { useEffect, useMemo, useRef } from "react";
import { NavLink, useLocation } from "react-router-dom";
import type { SiteCapabilities } from "../../api/queries";
import { UnderlineNavigation, UnderlineNavigationLabel } from "../../components/ui";
import { settingsSectionsFor } from "./settings-sections";

export function SettingsSubnavigation({ capabilities }: { capabilities: SiteCapabilities }) {
  const location = useLocation();
  const itemRefs = useRef(new Map<string, HTMLAnchorElement>());
  const sections = useMemo(() => settingsSectionsFor(capabilities), [capabilities]);
  const activePath = sections.find((section) => section.path === "/settings"
    ? location.pathname === section.path
    : location.pathname === section.path || location.pathname.startsWith(`${section.path}/`))?.path;

  useEffect(() => {
    const activeTab = activePath ? itemRefs.current.get(activePath) : undefined;
    if (typeof activeTab?.scrollIntoView === "function") {
      activeTab.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [activePath]);

  return (
    <UnderlineNavigation
      className="w-full"
      trackClassName="min-w-max"
      aria-label="설정 메뉴"
    >
      {sections.map((section) => (
        <NavLink
          ref={(node) => {
            if (node) itemRefs.current.set(section.path, node);
            else itemRefs.current.delete(section.path);
          }}
          end={section.path === "/settings"}
          key={section.path}
          to={{ pathname: section.path, search: location.search, hash: location.hash }}
          className={({ isActive }) => isActive
            ? "ui-underline-navigation-item active"
            : "ui-underline-navigation-item"}
        >
          <UnderlineNavigationLabel>{section.label}</UnderlineNavigationLabel>
        </NavLink>
      ))}
    </UnderlineNavigation>
  );
}
