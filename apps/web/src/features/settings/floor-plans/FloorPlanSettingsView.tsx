import { FileImage, LoaderCircle, LockKeyhole, TriangleAlert } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useDashboard, type SiteCapabilities } from "../../../api/queries";
import { Card, FeedbackState, PageHeader, StatusBadge } from "../../../components/ui";

interface FloorPlanSettingsViewProps {
  siteId?: string;
  capabilities: SiteCapabilities;
}

export function FloorPlanSettingsView({ siteId, capabilities }: FloorPlanSettingsViewProps) {
  const { data, isLoading, error } = useDashboard(siteId);
  const location = useLocation();
  const canEdit = capabilities.manage;

  return (
    <section className="grid min-w-0 gap-4">
      <PageHeader
        title="맵 관리"
        description={canEdit ? "층별 도면을 확인하고 편집합니다." : "층별 맵 설정 상태를 조회합니다."}
      />
      {isLoading && <FeedbackState icon={LoaderCircle} title="도면 목록을 불러오는 중" />}
      {error && <FeedbackState tone="danger" icon={TriangleAlert} title="도면 목록을 불러오지 못했습니다." />}
      {data && (
        <div className="grid gap-3">
          {data.floors.map((floor) => (
            <Card className="flex min-h-16 items-center justify-between gap-3 p-4 max-compact:items-start max-compact:flex-col" data-testid="floor-plan-item" key={floor.id}>
              <div className="flex min-w-0 items-center gap-3">
                <FileImage size={20} aria-hidden="true" />
                <div className="grid min-w-0 gap-1">
                  <strong className="break-words text-label text-content-primary">{floor.name}</strong>
                  <span className="text-body-sm text-content-secondary">{floor.floorPlan ? "맵 설정됨" : "맵 미설정"}</span>
                </div>
              </div>
              {canEdit ? (
                <Link
                  className="inline-flex min-h-11 items-center justify-center gap-2 rounded-control border border-border-default bg-action-secondary px-4 py-0 text-body font-bold text-action-primary focus-visible:outline-none focus-visible:shadow-focus"
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
