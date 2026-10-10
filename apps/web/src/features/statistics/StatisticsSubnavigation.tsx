import { NavLink, useLocation } from "react-router-dom";
import { UnderlineNavigation, UnderlineNavigationLabel, navigationItemClass } from "../../components/ui";
import { statisticsSections } from "./statistics-sections";

export function StatisticsSubnavigation() {
  const location = useLocation();
  return (
    <UnderlineNavigation
      variant="customer"
      aria-label="통계 메뉴"
    >
      {statisticsSections.map((section) => (
        <NavLink
          end
          key={section.path}
          to={`${section.path}${location.search}${location.hash}`}
          className={({ isActive }) => `${navigationItemClass({ active: isActive, variant: "customer" })} shrink-0 no-underline`}
        >
          <UnderlineNavigationLabel>{section.label}</UnderlineNavigationLabel>
        </NavLink>
      ))}
    </UnderlineNavigation>
  );
}
