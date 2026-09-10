import { NavLink, useLocation } from "react-router-dom";
import { statisticsSections } from "./statistics-sections";

export function StatisticsSubnavigation() {
  const location = useLocation();
  return (
    <nav className="statistics-subnavigation" aria-label="통계 메뉴">
      <div className="statistics-subnavigation-track">
        {statisticsSections.map((section) => (
          <NavLink
            end
            key={section.path}
            to={`${section.path}${location.search}${location.hash}`}
            className={({ isActive }) => isActive ? "statistics-subnavigation-link active" : "statistics-subnavigation-link"}
          >
            {section.label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
