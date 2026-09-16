import { NavLink, useLocation } from "react-router-dom";
import { UnderlineNavigation, UnderlineNavigationLabel } from "../../components/ui";
import { statisticsSections } from "./statistics-sections";

export function StatisticsSubnavigation() {
  const location = useLocation();
  return (
    <UnderlineNavigation
      aria-label="통계 메뉴"
    >
      {statisticsSections.map((section) => (
        <NavLink
          end
          key={section.path}
          to={`${section.path}${location.search}${location.hash}`}
          className={({ isActive }) => `inline-flex min-h-11 shrink-0 items-center border-b-2 px-3 text-body-sm font-bold no-underline outline-none focus-visible:shadow-focus ${isActive
            ? "border-action-primary text-action-primary"
            : "border-transparent text-content-secondary hover:border-border-strong hover:text-content-primary"}`}
        >
          <UnderlineNavigationLabel>{section.label}</UnderlineNavigationLabel>
        </NavLink>
      ))}
    </UnderlineNavigation>
  );
}
