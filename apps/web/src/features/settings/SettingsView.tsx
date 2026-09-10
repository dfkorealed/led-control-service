import { Building2, CircleCheck, CircleDashed, Layers3, Network, ShieldCheck, WifiOff } from "lucide-react";
import { Link, useLocation } from "react-router-dom";
import { useDashboard } from "../../api/queries";
import { Card, PageHeader, StatusBadge } from "../../components/ui";
import { InstallationPending, SetupWizard } from "../setup/SetupWizard";
import { TestDataToolsPanel } from "./TestDataToolsPanel";

export function SettingsView({ userRole, siteId }: { userRole: "operator" | "admin" | "viewer"; siteId?: string }) {
  const { data } = useDashboard(siteId);
  const location = useLocation();

  if (!data?.site.id) {
    return (
      <section className="settings-screen">
        <InstallationPending />
      </section>
    );
  }

  if (data.site.installationStatus === "pending") {
    return (
      <section className="settings-screen">
        {userRole === "admin"
          ? <SetupWizard siteId={data.site.id} customerName={data.site.customerName} siteName={data.site.name} />
          : <InstallationPending />}
      </section>
    );
  }

  const gateway = data.gateways[0];
  const registeredPlanCount = data.floors.filter((floor) => floor.floorPlan !== null).length;

  return (
    <section className="settings-screen">
      <PageHeader
        title="설정 개요"
        description="현재 현장 구성과 게이트웨이 연결 상태를 확인합니다."
      />

      <div className="settings-overview-grid">
        <Card className="settings-summary-card" role="group" aria-label="현장 정보">
          <div className="settings-card-heading">
            <Building2 size={20} aria-hidden="true" />
            <div>
              <span>현장 정보</span>
              <strong>{data.site.name}</strong>
            </div>
          </div>
          <dl className="settings-compact-rows">
            <div>
              <dt>고객사</dt>
              <dd>{data.site.customerName}</dd>
            </div>
            <div>
              <dt>주소</dt>
              <dd>{data.site.address ?? "등록 없음"}</dd>
            </div>
            <div>
              <dt>시간대</dt>
              <dd>{data.site.timeZone}</dd>
            </div>
          </dl>
        </Card>

        <Card className="settings-summary-card" role="group" aria-label="층·도면">
          <div className="settings-card-heading">
            <Layers3 size={20} aria-hidden="true" />
            <div>
              <span>층·도면</span>
              <strong>{data.floors.length}개 층</strong>
            </div>
          </div>
          <p className="muted-text">맵 설정 {registeredPlanCount}개</p>
          <Link className="ui-button ui-button-secondary" to={{ pathname: "/settings/floor-plans", search: location.search, hash: location.hash }}>
            맵 관리 열기
          </Link>
        </Card>

        <Card className="settings-summary-card" role="group" aria-label="Gateway 상태">
          <div className="settings-card-heading">
            <Network size={20} aria-hidden="true" />
            <div>
              <span>Gateway 상태</span>
              <strong>{gateway?.name ?? "미등록"}</strong>
            </div>
          </div>
          {gateway ? (
            <div className="settings-gateway-summary">
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
          <Card className="settings-summary-card" role="group" aria-label="계정·보안">
            <div className="settings-card-heading">
              <ShieldCheck size={20} aria-hidden="true" />
              <div>
                <span>계정·보안</span>
                <strong>관리자 비밀번호</strong>
              </div>
            </div>
            <Link className="ui-button ui-button-secondary" to={{ pathname: "/settings/security", search: location.search, hash: location.hash }}>
              비밀번호 변경 열기
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
