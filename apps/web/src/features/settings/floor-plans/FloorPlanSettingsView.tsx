import { Link, useLocation } from "react-router-dom";
import type { AuthUser } from "../../../api/auth";
import { useDashboard } from "../../../api/queries";

interface FloorPlanSettingsViewProps {
  siteId?: string;
  userRole: AuthUser["role"];
}

export function FloorPlanSettingsView({ siteId, userRole }: FloorPlanSettingsViewProps) {
  const { data, isLoading, error } = useDashboard(siteId);
  const location = useLocation();
  const canEdit = userRole === "admin";

  return (
    <section className="settings-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">도면</span>
          <h2>도면 관리</h2>
        </div>
      </div>
      {isLoading && <div className="panel">도면 목록을 불러오는 중</div>}
      {error && <div className="panel danger">도면 목록을 불러오지 못했습니다.</div>}
      {data && (
        <div className="settings-grid">
          {data.floors.map((floor) => (
            <div className="setting-card" key={floor.id}>
              <span>{floor.name}</span>
              <strong>{floor.floorPlan ? "도면 등록됨" : "도면 미등록"}</strong>
              {canEdit && (
                <Link
                  className="secondary-button"
                  to={`/settings/floor-plans/${floor.id}/edit${location.search}`}
                  aria-label={`${floor.name} 도면 편집`}
                >
                  도면 편집
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
