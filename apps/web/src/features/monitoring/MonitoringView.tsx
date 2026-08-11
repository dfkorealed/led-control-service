import { useEffect, useMemo, useState } from "react";
import { useDashboard, useFloorFixtures, type Dashboard } from "../../api/queries";
import { RegistrationPanel } from "../registration/RegistrationPanel";
import { InstallationPending, SetupWizard } from "../setup/SetupWizard";
import { GatewayClaimPanel } from "../setup/GatewayClaimPanel";
import { FloorMap } from "./FloorMap";

const statusLabels = {
  online: "정상",
  offline: "오프라인",
  fault: "장애"
} as const;

export function MonitoringView({ userRole = "operator", siteId }: { userRole?: "operator" | "admin" | "viewer"; siteId?: string }) {
  const { data, isLoading, error } = useDashboard(siteId);

  if (isLoading) return <div className="panel">불러오는 중</div>;
  if (error || !data) return <div className="panel danger">현황 데이터를 불러오지 못했습니다.</div>;

  return <MonitoringDashboard data={data} userRole={userRole} siteId={siteId} />;
}

function MonitoringDashboard({ data, userRole, siteId }: { data: Dashboard; userRole: "operator" | "admin" | "viewer"; siteId?: string }) {
  const [selectedFloorId, setSelectedFloorId] = useState<string | null>(null);
  const [selectedFixtureId, setSelectedFixtureId] = useState<string | null>(null);
  const floor = data.floors.find((item) => item.id === selectedFloorId) ?? data.floors[0];
  const fixtureQuery = useFloorFixtures(floor?.id, siteId ?? data.site.id);
  const fixtures = fixtureQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const selectedFixture = fixtures.find((fixture) => fixture.id === selectedFixtureId) ?? fixtures[0];
  const firstFaultFixture = fixtures.find((fixture) => fixture.status === "fault");
  const firstOfflineFixture = fixtures.find((fixture) => fixture.status === "offline");
  const offlineCount = fixtures.filter((fixture) => fixture.status === "offline").length;
  const floorSummary = useMemo(
    () => ({
      totalFixtures: fixtures.length,
      onlineFixtures: fixtures.filter((fixture) => fixture.status === "online").length,
      faultFixtures: fixtures.filter((fixture) => fixture.status === "fault").length,
      averageBrightness: fixtures.length
        ? Math.round(fixtures.reduce((sum, fixture) => sum + fixture.brightness, 0) / fixtures.length)
        : 0
    }),
    [fixtures]
  );
  useEffect(() => {
    if (fixtureQuery.hasNextPage && !fixtureQuery.isFetchingNextPage) void fixtureQuery.fetchNextPage();
  }, [fixtureQuery.hasNextPage, fixtureQuery.isFetchingNextPage, fixtureQuery.fetchNextPage]);

  useEffect(() => {
    if (!floor) return;
    setSelectedFloorId((current) => current ?? floor.id);
    setSelectedFixtureId((current) => {
      if (current && fixtures.some((fixture) => fixture.id === current)) return current;
      return fixtures.find((fixture) => fixture.status === "fault")?.id ?? fixtures[0]?.id ?? null;
    });
  }, [floor?.id, fixtures]);

  if (!data.site.id) {
    return (
      <section className="screen-grid monitoring-screen">
        {userRole === "operator" ? <SetupWizard /> : <InstallationPending />}
      </section>
    );
  }

  if (data.summary.totalFixtures === 0) {
    return (
      <section className="screen-grid monitoring-screen">
        <div className="screen-heading">
          <div>
            <span className="eyebrow">초기 설정</span>
            <h2>등록된 조명이 없습니다</h2>
          </div>
        </div>
        {userRole === "operator" ? (
          data.gateways.length === 0 ? <GatewayClaimPanel siteId={data.site.id} /> : <RegistrationPanel dashboard={data} />
        ) : (
          <InstallationPending />
        )}
      </section>
    );
  }

  function handleSelectFloor(floorId: string) {
    const nextFloor = data.floors.find((item) => item.id === floorId);
    setSelectedFloorId(floorId);
    setSelectedFixtureId(nextFloor?.fixtures.find((fixture) => fixture.status === "fault")?.id ?? nextFloor?.fixtures[0]?.id ?? null);
  }

  return (
    <section className="screen-grid monitoring-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">실시간 모니터링</span>
          <h2>{floor?.name ?? "층 미등록"} 운영 현황</h2>
        </div>
        <div className="monitoring-heading-actions">
          <div className="segmented-control" aria-label="층 선택">
            {data.floors.map((item) => (
              <button
                key={item.id}
                className={item.id === floor?.id ? "active" : ""}
                onClick={() => handleSelectFloor(item.id)}
              >
                {item.name}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="summary-row">
        <div className="metric primary">
          <span>전체 조명</span>
          <strong>{floorSummary.totalFixtures}</strong>
          <small>선택 층 기준</small>
        </div>
        <div className="metric success">
          <span>온라인</span>
          <strong>{floorSummary.onlineFixtures}</strong>
          <small>최근 수신 정상</small>
        </div>
        <div className="metric danger">
          <span>장애</span>
          <strong>{floorSummary.faultFixtures}</strong>
          <small>우선 점검 대상</small>
        </div>
        <div className="metric">
          <span>평균 밝기</span>
          <strong>{floorSummary.averageBrightness}%</strong>
          <small>현재 디밍</small>
        </div>
      </div>

      <div className="operations-layout">
        <div className="map-panel">
          {floor ? (
            <FloorMap floor={{ ...floor, fixtures }} selectedFixtureId={selectedFixture?.id ?? null} onSelectFixture={setSelectedFixtureId} />
          ) : (
            <div className="panel">등록된 층이 없습니다.</div>
          )}
        </div>
        <aside className="detail-panel" aria-label="상세 패널">
          <div className="panel-title-row">
            <div>
              <span className="eyebrow">상세 패널</span>
              <h3>{selectedFixture?.name ?? "조명 선택"}</h3>
            </div>
            <span className={`status-pill ${selectedFixture?.status ?? "offline"}`}>
              {selectedFixture?.statusReason === "provisioning_waiting_state"
                ? "상태 확인 대기"
                : selectedFixture ? statusLabels[selectedFixture.status] : "대기"}
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
                  <dd>{formatLastSeen(selectedFixture.lastSeenAt)}</dd>
                </div>
                <div>
                  <dt>게이트웨이</dt>
                  <dd>
                    {selectedFixture.gateway
                      ? `${selectedFixture.gateway.name} (${selectedFixture.gateway.connectionStatus === "online" ? "정상" : "오프라인"})`
                      : "미매핑"}
                  </dd>
                </div>
                <div>
                  <dt>RSSI</dt>
                  <dd>{formatRssi(selectedFixture.rssi)}</dd>
                </div>
                <div>
                  <dt>Hop</dt>
                  <dd>{selectedFixture.hopCount ?? "수집 전"}</dd>
                </div>
                <div>
                  <dt>명령 성공률</dt>
                  <dd>{formatSuccessRate(selectedFixture.commandSuccessRate)}</dd>
                </div>
              </dl>
            </div>
          ) : (
            <p className="muted-text">지도에서 조명을 선택하면 상태와 제어 정보를 확인할 수 있습니다.</p>
          )}

          <div className="device-list-panel">
            <h4>점검 큐</h4>
            <button className="device-row" disabled={!firstFaultFixture} onClick={() => firstFaultFixture && setSelectedFixtureId(firstFaultFixture.id)}>
              <span className="device-state danger" />
              <div>
                <strong>장애 조명</strong>
                <span>{floorSummary.faultFixtures}대</span>
              </div>
            </button>
            <button className="device-row" disabled={!firstOfflineFixture} onClick={() => firstOfflineFixture && setSelectedFixtureId(firstOfflineFixture.id)}>
              <span className="device-state muted" />
              <div>
                <strong>오프라인</strong>
                <span>{offlineCount}대</span>
              </div>
            </button>
          </div>
        </aside>
      </div>
    </section>
  );
}

function formatRssi(value: number | null) {
  return value === null ? "수집 전" : `${value} dBm`;
}

function formatSuccessRate(value: number | null) {
  return value === null ? "수집 전" : `${Math.round(value * 100)}%`;
}

function formatLastSeen(value: string | null) {
  if (!value) return "수신 없음";
  const diffMs = Date.now() - new Date(value).getTime();
  if (diffMs < 60_000) return "방금 전";
  if (diffMs < 3_600_000) return `${Math.floor(diffMs / 60_000)}분 전`;
  if (diffMs < 86_400_000) return `${Math.floor(diffMs / 3_600_000)}시간 전`;
  return `${Math.floor(diffMs / 86_400_000)}일 전`;
}
