import { useDashboard } from "../../api/queries";
import { RegistrationPanel } from "../registration/RegistrationPanel";
import { RfPlanningPanel } from "../rf/RfPlanningPanel";
import { SetupWizard } from "../setup/SetupWizard";

export function SettingsView() {
  const { data } = useDashboard();

  if (!data?.site.id) {
    return (
      <section className="settings-screen">
        <SetupWizard />
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
    { title: "게이트웨이", value: gatewayValue, meta: gatewayMeta },
    { title: "OTA", value: "MVP 2 준비", meta: "배포, 중단, 롤백" },
    { title: "사용자 권한", value: "운영자", meta: "역할 기반 접근" }
  ];

  return (
    <section className="settings-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">서비스 구성</span>
          <h2>운영 설정</h2>
        </div>
        <span className="status-pill online">설정 동기화됨</span>
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
      <RegistrationPanel dashboard={data} />
      <RfPlanningPanel />
    </section>
  );
}

function statusLabel(status: "online" | "offline") {
  return status === "online" ? "온라인" : "오프라인";
}
