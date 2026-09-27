import { Building2, CircleCheck, CircleDashed, Layers3, Network, ShieldCheck, WifiOff } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useDashboard } from "../../api/queries";
import { Card, PageHeader, StatusBadge } from "../../components/ui";
import { InstallationPending, SetupWizard } from "../setup/SetupWizard";
import { TestDataToolsPanel } from "./TestDataToolsPanel";
import { settingsActionLinkClass } from "./settings-action-link";

export function SettingsView({ userRole, siteId }: { userRole: "operator" | "admin" | "viewer"; siteId?: string }) {
  const { data } = useDashboard(siteId);
  const location = useLocation();

  if (!data?.site.id) {
    return (
      <section className="grid gap-5">
        <InstallationPending />
      </section>
    );
  }

  if (data.site.installationStatus === "pending") {
    return (
      <section className="grid gap-5">
        {userRole === "admin"
          ? <SetupWizard siteId={data.site.id} customerName={data.site.customerName} siteName={data.site.name} />
          : <InstallationPending />}
      </section>
    );
  }

  const gateway = data.gateways[0];
  const registeredPlanCount = data.floors.filter((floor) => floor.mapConfigured === true).length;
  const nextStepSearch = new URLSearchParams(location.search);
  nextStepSearch.set("siteId", data.site.id);
  const nextStep = data.gateways.length === 0
    ? { title: "게이트웨이 연결", description: "조명을 검색하기 전에 현장의 게이트웨이를 등록합니다.", label: "게이트웨이 연결하기", path: "/settings/registration" }
    : data.summary.totalFixtures === 0
      ? { title: "조명 등록", description: "연결된 게이트웨이에서 조명을 검색하고 등록합니다.", label: "조명 등록하기", path: "/settings/registration" }
      : { title: "조명 위치 배치", description: "등록한 조명의 위치를 층별 맵에서 확인하고 배치합니다.", label: "조명 위치 배치하기", path: "/settings/floor-plans" };

  return (
    <section className="grid gap-5">
      <PageHeader
        title="설정 개요"
        description="현재 현장 구성과 게이트웨이 연결 상태를 확인합니다."
      />

      {userRole === "admin" ? (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-panel border border-border-default bg-action-secondary p-4" aria-label="설치 이어가기">
          <div className="grid gap-1">
            <span className="text-overline font-bold text-content-secondary">설치 이어가기</span>
            <strong className="text-card-title text-content-primary">{nextStep.title}</strong>
            <p className="m-0 text-body-sm text-content-secondary">{nextStep.description}</p>
          </div>
          <Link className={settingsActionLinkClass} to={{ pathname: nextStep.path, search: nextStepSearch.toString() }}>
            {nextStep.label}
          </Link>
        </section>
      ) : null}

      <div className="grid gap-4 compact:grid-cols-2">
        <Card className="grid min-h-48 gap-4 p-5" role="group" aria-label="현장 정보">
          <div className="flex items-start gap-3 text-action-primary">
            <Building2 size={20} aria-hidden="true" />
            <div>
              <span className="block text-caption text-content-secondary">현장 정보</span>
              <strong className="block text-card-title text-content-primary">{data.site.name}</strong>
            </div>
          </div>
          <dl className="grid gap-2 text-body-sm">
            <div className="grid grid-cols-[6rem_1fr] gap-3">
              <dt className="text-content-secondary">고객사</dt>
              <dd className="m-0 font-semibold">{data.site.customerName}</dd>
            </div>
            <div className="grid grid-cols-[6rem_1fr] gap-3">
              <dt className="text-content-secondary">주소</dt>
              <dd className="m-0 font-semibold">{data.site.address ?? "등록 없음"}</dd>
            </div>
            <div className="grid grid-cols-[6rem_1fr] gap-3">
              <dt className="text-content-secondary">시간대</dt>
              <dd className="m-0 font-semibold">{data.site.timeZone}</dd>
            </div>
          </dl>
        </Card>

        <Card className="grid min-h-48 gap-4 p-5" role="group" aria-label="층·도면">
          <div className="flex items-start gap-3 text-action-primary">
            <Layers3 size={20} aria-hidden="true" />
            <div>
              <span className="block text-caption text-content-secondary">층·도면</span>
              <strong className="block text-card-title text-content-primary">{data.floors.length}개 층</strong>
            </div>
          </div>
          <p className="m-0 text-body text-content-secondary">맵 설정 {registeredPlanCount}개</p>
          <Link className={settingsActionLinkClass} to={{ pathname: "/settings/floor-plans", search: location.search, hash: location.hash }}>
            맵 관리 열기
          </Link>
        </Card>

        <Card className="grid min-h-48 gap-4 p-5" role="group" aria-label="Gateway 상태">
          <div className="flex items-start gap-3 text-action-primary">
            <Network size={20} aria-hidden="true" />
            <div>
              <span className="block text-caption text-content-secondary">Gateway 상태</span>
              <strong className="block text-card-title text-content-primary">{gateway?.name ?? "미등록"}</strong>
            </div>
          </div>
          {gateway ? (
            <div className="grid gap-2 text-body-sm text-content-secondary">
              <StatusBadge
                tone={gateway.connectionStatus === "online" ? "success" : "neutral"}
                icon={gateway.connectionStatus === "online" ? CircleCheck : WifiOff}
              >
                {statusLabel(gateway.connectionStatus)}
              </StatusBadge>
              <span>시리얼 {gateway.serialNumber}</span>
            </div>
          ) : (
            <StatusBadge tone="neutral" icon={CircleDashed}>미등록</StatusBadge>
          )}
        </Card>

        {userRole === "admin" ? (
          <Card className="grid min-h-48 gap-4 p-5" role="group" aria-label="계정·보안">
            <div className="flex items-start gap-3 text-action-primary">
              <ShieldCheck size={20} aria-hidden="true" />
              <div>
                <span className="block text-caption text-content-secondary">계정·보안</span>
                <strong className="block text-card-title text-content-primary">비밀번호 · MFA · 세션</strong>
              </div>
            </div>
            <Link className={settingsActionLinkClass} to={{ pathname: "/settings/security", search: location.search, hash: location.hash }}>
              계정 보안 열기
            </Link>
          </Card>
        ) : null}
      </div>
      <TestDataToolsPanel userRole={userRole} dashboard={data} />
    </section>
  );
}

function statusLabel(status: "online" | "offline") {
  return status === "online" ? "정상" : "오프라인";
}
