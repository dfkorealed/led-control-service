import { FileImage, LoaderCircle, LockKeyhole, TriangleAlert } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import type { AuthUser } from "../../../api/auth";
import { useDashboard } from "../../../api/queries";
import { Card, FeedbackState, PageHeader, StatusBadge } from "../../../components/ui";

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
      <PageHeader
        title="맵 관리"
        description={canEdit ? "층별 도면을 확인하고 편집합니다." : "층별 맵 설정 상태를 조회합니다."}
      />
      {isLoading && <FeedbackState icon={LoaderCircle} title="도면 목록을 불러오는 중" />}
      {error && <FeedbackState tone="danger" icon={TriangleAlert} title="도면 목록을 불러오지 못했습니다." />}
      {data && (
        <div className="settings-card-list">
          {data.floors.map((floor) => (
            <Card className="floor-plan-card" key={floor.id}>
              <div className="floor-plan-card-summary">
                <FileImage size={20} aria-hidden="true" />
                <div>
                  <strong>{floor.name}</strong>
                  <span>{floor.floorPlan ? "맵 설정됨" : "맵 미설정"}</span>
                </div>
              </div>
              {canEdit ? (
                <Link
                  className="ui-button ui-button-secondary floor-plan-edit-link"
                  to={`/settings/floor-plans/${floor.id}/edit${location.search}`}
                  aria-label={`${floor.name} ${floor.floorPlan ? "맵 편집" : "맵 설정"}`}
                >
                  {floor.floorPlan ? "맵 편집" : "맵 설정"}
                </Link>
              ) : <StatusBadge tone="neutral" icon={LockKeyhole}>읽기 전용</StatusBadge>}
            </Card>
          ))}
        </div>
      )}
    </section>
  );
}
