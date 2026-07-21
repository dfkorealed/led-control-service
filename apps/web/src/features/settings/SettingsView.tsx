import { useDashboard } from "../../api/queries";
import { RegistrationPanel } from "../registration/RegistrationPanel";
import { InstallationPending, SetupWizard } from "../setup/SetupWizard";
import { GatewayClaimPanel } from "../setup/GatewayClaimPanel";

export function SettingsView({ userRole = "operator" }: { userRole?: "operator" | "admin" | "viewer" }) {
  const { data } = useDashboard();

  if (!data?.site.id) {
    return (
      <section className="settings-screen">
        {userRole === "operator" ? <SetupWizard /> : <InstallationPending />}
      </section>
    );
  }

  const gateway = data.gateways[0];
  const gatewayValue = gateway ? `${gateway.name} (${gateway.serialNumber})` : "미등록";
  const gatewayMeta = gateway ? statusLabel(gateway.connectionStatus) : "미등록";
  const settings = [
    { title: "현장", value: data.site.name, meta: "조직, 현장, 운영 기준" },
    { title: "층/도면", value: data.floors.map((floor) => floor.name).join(", "), meta: "도면 업로드와 좌표계" },
    { title: "그룹", value: data.groups.map((group) => group.name).join(", "), meta: "구역 제어 단위" },
    { title: "게이트웨이", value: gatewayValue, meta: gatewayMeta }
  ];

  return (
    <section className="settings-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">서비스 구성</span>
          <h2>운영 설정</h2>
        </div>
      </div>

      <div className="settings-grid">
        {settings.map((item) => (
          <div className="setting-card" key={item.title}>
            <span>{item.title}</span>
            <strong>{item.value}</strong>
            <small>{item.meta}</small>
          </div>
        ))}
      </div>
      {data.gateways.length === 0 ? <GatewayClaimPanel siteId={data.site.id} /> : <RegistrationPanel dashboard={data} />}
    </section>
  );
}

function statusLabel(status: "online" | "offline") {
  return status === "online" ? "온라인" : "오프라인";
}
