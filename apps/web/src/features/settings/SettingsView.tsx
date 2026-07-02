import { useDashboard } from "../../api/queries";
import { RfPlanningPanel } from "../rf/RfPlanningPanel";

export function SettingsView() {
  const { data } = useDashboard();
  const settings = [
    { title: "현장", value: data?.site.name ?? "현장 정보를 불러오는 중", meta: "조직, 현장, 운영 기준" },
    { title: "층/도면", value: data?.floors.map((floor) => floor.name).join(", ") ?? "층 정보를 불러오는 중", meta: "도면 업로드와 좌표계" },
    { title: "그룹", value: data?.groups.map((group) => group.name).join(", ") ?? "그룹 정보를 불러오는 중", meta: "구역 제어 단위" },
    { title: "게이트웨이", value: "RPI-GW-B2", meta: "MQTT 연결과 heartbeat" },
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
      <RfPlanningPanel />
    </section>
  );
}
