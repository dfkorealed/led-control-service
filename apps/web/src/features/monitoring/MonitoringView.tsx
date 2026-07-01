import { useDashboard } from "../../api/queries";
import { FloorMap } from "./FloorMap";

export function MonitoringView() {
  const { data, isLoading, error } = useDashboard();

  if (isLoading) return <div className="panel">불러오는 중</div>;
  if (error || !data) return <div className="panel danger">현황 데이터를 불러오지 못했습니다.</div>;

  const floor = data.floors[0];

  return (
    <section className="screen-grid">
      <div className="summary-row">
        <div className="metric">
          전체 조명 <strong>{data.summary.totalFixtures}</strong>
        </div>
        <div className="metric">
          온라인 <strong>{data.summary.onlineFixtures}</strong>
        </div>
        <div className="metric">
          장애 <strong>{data.summary.faultFixtures}</strong>
        </div>
        <div className="metric">
          평균 밝기 <strong>{data.summary.averageBrightness}%</strong>
        </div>
      </div>
      {floor ? <FloorMap floor={floor} /> : <div className="panel">등록된 층이 없습니다.</div>}
    </section>
  );
}
