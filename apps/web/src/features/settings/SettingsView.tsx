import { useDashboard } from "../../api/queries";
import { RfPlanningPanel } from "../rf/RfPlanningPanel";

export function SettingsView() {
  const { data } = useDashboard();

  return (
    <section className="settings-grid">
      <div className="panel">
        <h2>현장 설정</h2>
        <p>{data?.site.name ?? "현장 정보를 불러오는 중"}</p>
      </div>
      <div className="panel">
        <h2>층/도면</h2>
        <p>{data?.floors.map((floor) => floor.name).join(", ") ?? "층 정보를 불러오는 중"}</p>
      </div>
      <div className="panel">
        <h2>그룹</h2>
        <p>{data?.groups.map((group) => group.name).join(", ") ?? "그룹 정보를 불러오는 중"}</p>
      </div>
      <div className="panel">
        <h2>OTA</h2>
        <p>MVP 1에서는 OTA 메뉴 구조만 노출하고 실제 배포는 MVP 2에서 구현합니다.</p>
      </div>
      <RfPlanningPanel />
    </section>
  );
}
