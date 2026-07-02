import { useDashboard } from "../../api/queries";
import { FloorMap } from "./FloorMap";

const statusLabels = {
  online: "정상",
  offline: "오프라인",
  fault: "장애"
} as const;

export function MonitoringView() {
  const { data, isLoading, error } = useDashboard();

  if (isLoading) return <div className="panel">불러오는 중</div>;
  if (error || !data) return <div className="panel danger">현황 데이터를 불러오지 못했습니다.</div>;

  const floor = data.floors[0];
  const fixtures = floor?.fixtures ?? [];
  const selectedFixture = fixtures.find((fixture) => fixture.status === "fault") ?? fixtures[0];
  const offlineCount = fixtures.filter((fixture) => fixture.status === "offline").length;
  const gatewayState = data.summary.faultFixtures > 0 ? "점검 필요" : "정상";

  return (
    <section className="screen-grid monitoring-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">실시간 모니터링</span>
          <h2>{floor?.name ?? "층 미등록"} 운영 현황</h2>
        </div>
        <div className="segmented-control" aria-label="층 선택">
          <button className="active">B2</button>
          <button>B1</button>
          <button>1F</button>
        </div>
      </div>

      <div className="summary-row">
        <div className="metric primary">
          <span>전체 조명</span>
          <strong>{data.summary.totalFixtures}</strong>
          <small>설치 기준</small>
        </div>
        <div className="metric success">
          <span>온라인</span>
          <strong>{data.summary.onlineFixtures}</strong>
          <small>최근 수신 정상</small>
        </div>
        <div className="metric danger">
          <span>장애</span>
          <strong>{data.summary.faultFixtures}</strong>
          <small>우선 점검 대상</small>
        </div>
        <div className="metric">
          <span>평균 밝기</span>
          <strong>{data.summary.averageBrightness}%</strong>
          <small>현재 디밍</small>
        </div>
      </div>

      <div className="operations-layout">
        <div className="map-panel">
          {floor ? <FloorMap floor={floor} /> : <div className="panel">등록된 층이 없습니다.</div>}
        </div>
        <aside className="detail-panel" aria-label="상세 패널">
          <div className="panel-title-row">
            <div>
              <span className="eyebrow">상세 패널</span>
              <h3>{selectedFixture?.name ?? "조명 선택"}</h3>
            </div>
            <span className={`status-pill ${selectedFixture?.status ?? "offline"}`}>
              {selectedFixture ? statusLabels[selectedFixture.status] : "대기"}
            </span>
          </div>

          {selectedFixture ? (
            <div className="detail-stack">
              <div className="brightness-card">
                <span>현재 밝기</span>
                <strong>{selectedFixture.brightness}%</strong>
                <div className="progress-track">
                  <span style={{ width: `${selectedFixture.brightness}%` }} />
                </div>
              </div>
              <dl className="info-list">
                <div>
                  <dt>정격 전력</dt>
                  <dd>{selectedFixture.ratedWatt} W</dd>
                </div>
                <div>
                  <dt>마지막 수신</dt>
                  <dd>{selectedFixture.lastSeenAt ? "방금 전" : "수신 없음"}</dd>
                </div>
                <div>
                  <dt>게이트웨이</dt>
                  <dd>{gatewayState}</dd>
                </div>
              </dl>
            </div>
          ) : (
            <p className="muted-text">지도에서 조명을 선택하면 상태와 제어 정보를 확인할 수 있습니다.</p>
          )}

          <div className="device-list-panel">
            <h4>점검 큐</h4>
            <div className="device-row">
              <span className="device-state danger" />
              <div>
                <strong>장애 조명</strong>
                <span>{data.summary.faultFixtures}대</span>
              </div>
            </div>
            <div className="device-row">
              <span className="device-state muted" />
              <div>
                <strong>오프라인</strong>
                <span>{offlineCount}대</span>
              </div>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
