import { Building2, CircleCheck, CircleDashed, Layers3, Network, WifiOff } from "lucide-react";
import { useDashboard } from "../../api/queries";
import { Card, PageHeader, StatusBadge } from "../../components/ui";
import { RegistrationPanel } from "../registration/RegistrationPanel";
import { InstallationPending, SetupWizard } from "../setup/SetupWizard";
import { GatewayClaimPanel } from "../setup/GatewayClaimPanel";

export function SettingsView({ userRole, siteId }: { userRole: "operator" | "admin" | "viewer"; siteId?: string }) {
  const { data } = useDashboard(siteId);

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
              <dt><Layers3 size={15} aria-hidden="true" /> 층/도면</dt>
              <dd>{listNames(data.floors)}</dd>
            </div>
            <div>
              <dt>그룹</dt>
              <dd>{listNames(data.groups)}</dd>
            </div>
          </dl>
        </Card>

        <Card className="settings-summary-card" role="group" aria-label="게이트웨이 상태">
          <div className="settings-card-heading">
            <Network size={20} aria-hidden="true" />
            <div>
              <span>게이트웨이 상태</span>
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
      </div>
      {userRole === "admin" ? (
        data.gateways.length === 0
          ? <GatewayClaimPanel siteId={data.site.id} />
          : <RegistrationPanel dashboard={data} dashboardQuerySiteId={siteId} />
      ) : null}
    </section>
  );
}

function statusLabel(status: "online" | "offline") {
  return status === "online" ? "정상" : "오프라인";
}

function listNames(items: Array<{ name: string }>) {
  return items.length > 0 ? items.map((item) => item.name).join(", ") : "등록 없음";
}
