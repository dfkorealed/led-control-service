import { NavLink, useLocation } from "react-router-dom";
import { UnderlineNavigation, UnderlineNavigationLabel } from "../../components/ui";
import { statisticsSections } from "./statistics-sections";

export function StatisticsSubnavigation() {
  const location = useLocation();
  return (
    <UnderlineNavigation
      className="statistics-subnavigation"
      trackClassName="statistics-subnavigation-track"
      aria-label="통계 메뉴"
    >
      {statisticsSections.map((section) => (
        <NavLink
          end
          key={section.path}
          to={`${section.path}${location.search}${location.hash}`}
          className={({ isActive }) => isActive
            ? "ui-underline-navigation-item statistics-subnavigation-link active"
            : "ui-underline-navigation-item statistics-subnavigation-link"}
        >
          <UnderlineNavigationLabel>{section.label}</UnderlineNavigationLabel>
        </NavLink>
      ))}
    </UnderlineNavigation>
  );
}
