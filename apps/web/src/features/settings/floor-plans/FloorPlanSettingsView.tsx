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
        description={canEdit ? "층별 맵을 확인하고 편집합니다." : "층별 맵 설정 상태를 조회합니다."}
      />
      {isLoading && <FeedbackState icon={LoaderCircle} title="도면 목록을 불러오는 중" />}
      {error && <FeedbackState tone="danger" icon={TriangleAlert} title="도면 목록을 불러오지 못했습니다." />}
      {data && (data.floors.length === 0
        ? <FeedbackState icon={FileImage} title="등록된 층이 없습니다." description="현장 관리에서 층을 추가한 뒤 맵을 편집할 수 있습니다." />
        : <div className="grid min-w-0 gap-4 compact:grid-cols-2">
          {data.floors.map((floor) => {
            const mapStatus = floor.mapConfigured === true ? "맵 설정됨" : floor.mapConfigured === false ? "맵 미설정" : "맵 상태 확인 중";
            const actionLabel = floor.mapConfigured === true ? "맵 편집" : floor.mapConfigured === false ? "맵 설정" : "맵 열기";
            return <Card className="flex min-h-32 min-w-0 flex-col justify-between gap-4 p-4" data-testid="floor-plan-item" key={floor.id}>
              <div className="flex min-w-0 items-center gap-3">
                <FileImage size={20} aria-hidden="true" />
                <div className="grid min-w-0 gap-1">
                  <strong className="break-words text-label text-content-primary">{floor.name}</strong>
                  <span className="text-body-sm text-content-secondary">{mapStatus}</span>
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-body-sm text-content-secondary">
                <span>{floor.summary ? `조명 ${floor.summary.totalFixtures.toLocaleString("ko-KR")}개` : "조명 수 확인 중"}</span>
                {floor.mapRevision !== undefined ? <span>리비전 {floor.mapRevision}</span> : null}
              </div>
              {canEdit ? (
                <Link
                  className="inline-flex min-h-11 items-center justify-center gap-2 self-start rounded-control border border-border-default bg-action-secondary px-4 py-0 text-body font-bold text-action-primary focus-visible:outline-none focus-visible:shadow-focus"
                  to={`/settings/floor-plans/${floor.id}/edit${location.search}`}
                  aria-label={`${floor.name} ${actionLabel}`}
                >
                  {actionLabel}
                </Link>
              ) : <StatusBadge tone="neutral" icon={LockKeyhole}>읽기 전용</StatusBadge>}
            </Card>;
          })}
        </div>
      )}
    </section>
  );
}
