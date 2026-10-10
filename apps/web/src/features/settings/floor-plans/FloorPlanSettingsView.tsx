import { FileImage, LoaderCircle, LockKeyhole, TriangleAlert } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useEffect, useRef, useState } from "react";
import { useDashboard, type SiteCapabilities } from "../../../api/queries";
import { Card, FeedbackState, Text, StatusBadge } from "../../../components/ui";
import { settingsActionLinkClass } from "../settings-action-link";
import { FloorPlanPreview } from "./FloorPlanPreview";

interface FloorPlanSettingsViewProps {
  siteId?: string;
  capabilities: SiteCapabilities;
}

export function FloorPlanSettingsView({ siteId, capabilities }: FloorPlanSettingsViewProps) {
  const { data, isLoading, error } = useDashboard(siteId);
  const location = useLocation();
  const canEdit = capabilities.manage;
  const previewCards = useRef(new Map<string, HTMLElement>());
  const [visibility, setVisibility] = useState<{ siteId: string; ids: string[] }>({ siteId: "", ids: [] });
  const configuredIds = data?.floors.filter(floor => floor.mapConfigured === true).map(floor => floor.id).join(",") ?? "";
  const scope = data?.site.id ?? "";
  const validScope = capabilities.read && Boolean(scope) && (!siteId || siteId === scope);
  useEffect(() => {
    const visible = new Set<string>();
    setVisibility({ siteId: scope, ids: [] });
    // Without visibility observation, fail closed instead of eagerly creating scenes for every card.
    if (!validScope || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const id = (entry.target as HTMLElement).dataset.floorId;
        if (!id) continue;
        if (entry.isIntersecting) visible.add(id); else visible.delete(id);
      }
      setVisibility({ siteId: scope, ids: [...visible].slice(0, 2) });
    });
    previewCards.current.forEach(card => observer.observe(card));
    return () => observer.disconnect();
  }, [scope, configuredIds, validScope]);
  const editSearch = new URLSearchParams(location.search);
  editSearch.delete("editorPanel");
  const historySearch = new URLSearchParams(editSearch);
  historySearch.set("editorPanel", "details");

  return (
    <section className="grid min-w-0 gap-4">
      <Text tone="secondary">{canEdit ? "층별 맵을 확인하고 편집합니다." : "층별 맵 설정 상태를 조회합니다."}</Text>
      {isLoading && <FeedbackState icon={LoaderCircle} title="도면 목록을 불러오는 중" />}
      {error && <FeedbackState tone="danger" icon={TriangleAlert} title="도면 목록을 불러오지 못했습니다." />}
      {data && (data.floors.length === 0
        ? <FeedbackState icon={FileImage} title="등록된 층이 없습니다." description="현장 관리에서 층을 추가한 뒤 맵을 편집할 수 있습니다." />
        : <div className="grid min-w-0 gap-4 compact:grid-cols-2">
          {data.floors.map((floor) => {
            const mapStatus = floor.mapConfigured === true ? "맵 설정됨" : floor.mapConfigured === false ? "맵 미설정" : "맵 상태 확인 중";
            const actionLabel = floor.mapConfigured === true ? "맵 편집" : floor.mapConfigured === false ? "맵 설정" : "맵 열기";
            return <Card ref={floor.mapConfigured === true ? node => { if (node) previewCards.current.set(floor.id, node); else previewCards.current.delete(floor.id); } : undefined} className="flex min-h-32 min-w-0 flex-col justify-between gap-4 p-4" data-testid="floor-plan-item" data-floor-id={floor.mapConfigured === true ? floor.id : undefined} key={floor.id}>
              {floor.mapConfigured === true ? <FloorPlanPreview floorId={floor.id} siteId={scope} floorName={floor.name} active={validScope && visibility.siteId === scope && visibility.ids.includes(floor.id)} /> : <div className="grid h-44 place-items-center bg-surface-inset"><Text tone="secondary" variant="body-sm">{mapStatus}</Text></div>}
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
                <div className="flex flex-wrap gap-2"><Link
                  className={settingsActionLinkClass}
                  to={{ pathname: `/settings/floor-plans/${floor.id}/edit`, search: editSearch.toString(), hash: location.hash }}
                  aria-label={`${floor.name} ${actionLabel}`}
                >
                  {actionLabel}
                </Link><Link className={settingsActionLinkClass} aria-label={`${floor.name} 변경 기록`} to={{ pathname: `/settings/floor-plans/${floor.id}/edit`, search: historySearch.toString(), hash: location.hash }}>변경 기록</Link></div>
              ) : <StatusBadge tone="neutral" icon={LockKeyhole}>읽기 전용</StatusBadge>}
            </Card>;
          })}
        </div>
      )}
    </section>
  );
}
