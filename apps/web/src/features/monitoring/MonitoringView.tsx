import { CircleCheck, CircleX, Clock3, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useDashboard, useFloorFixtures, useFloorMapSnapshot, type Dashboard } from "../../api/queries";
import { FeedbackState, MetricCard, PageHeader, StatusBadge } from "../../components/ui";
import { RegistrationPanel } from "../registration/RegistrationPanel";
import { InstallationPending } from "../setup/SetupWizard";
import { GatewayClaimPanel } from "../setup/GatewayClaimPanel";
import { FloorMap } from "./FloorMap";

const statusLabels = {
  online: "정상",
  offline: "오프라인",
  fault: "장애"
} as const;

export function MonitoringView({ userRole = "admin", siteId }: { userRole?: "operator" | "admin" | "viewer"; siteId?: string }) {
  const dashboardQuery = useDashboard(siteId);
  const { data, isLoading, error } = dashboardQuery;

  if (isLoading) return <div className="panel">불러오는 중</div>;
  if (error || !data) return <div className="panel danger">현황 데이터를 불러오지 못했습니다.</div>;

  return (
    <MonitoringDashboard
      data={data}
      userRole={userRole}
      siteId={siteId}
      dashboardUpdatedAt={dashboardQuery.dataUpdatedAt}
      refreshDashboard={() => dashboardQuery.refetch({ throwOnError: true })}
    />
  );
}

interface MonitoringDashboardProps {
  data: Dashboard;
  userRole: "operator" | "admin" | "viewer";
  siteId?: string;
  dashboardUpdatedAt: number;
  refreshDashboard: () => Promise<unknown>;
}

function MonitoringDashboard({ data, userRole, siteId, dashboardUpdatedAt, refreshDashboard }: MonitoringDashboardProps) {
  const [selectedFloorId, setSelectedFloorId] = useState<string | null>(null);
  const [selectedFixtureId, setSelectedFixtureId] = useState<string | null>(null);
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [mapRefreshFailedFloorId, setMapRefreshFailedFloorId] = useState<string | null>(null);
  const [lastRefreshedAt, setLastRefreshedAt] = useState(dashboardUpdatedAt);
  const floor = data.floors.find((item) => item.id === selectedFloorId) ?? data.floors[0];
  const fixtureQuery = useFloorFixtures(floor?.id, siteId ?? data.site.id);
  const mapQuery = useFloorMapSnapshot(floor?.id, siteId ?? data.site.id);
  const fixtures = fixtureQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const mapSnapshot = mapQuery.data;
  const mapRefreshFailed = mapRefreshFailedFloorId === floor?.id;
  const selectedFixture = fixtures.find((fixture) => fixture.id === selectedFixtureId) ?? fixtures[0];
  const firstFaultFixture = fixtures.find((fixture) => fixture.status === "fault");
  const operationallyOfflineFixtures = fixtures.filter(
    (fixture) => fixture.status === "offline" && fixture.statusReason !== "provisioning_waiting_state"
  );
  const firstOfflineFixture = operationallyOfflineFixtures[0];
  const offlineCount = operationallyOfflineFixtures.length;
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
    const latestQueryUpdate = Math.max(dashboardUpdatedAt, fixtureQuery.dataUpdatedAt ?? 0, mapQuery.dataUpdatedAt ?? 0);
    if (latestQueryUpdate > 0) setLastRefreshedAt(latestQueryUpdate);
  }, [dashboardUpdatedAt, fixtureQuery.dataUpdatedAt, mapQuery.dataUpdatedAt]);

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
        <InstallationPending />
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
        {userRole === "admin" ? (
          data.gateways.length === 0
            ? <GatewayClaimPanel siteId={data.site.id} />
            : <RegistrationPanel dashboard={data} dashboardQuerySiteId={siteId} />
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

  async function handleRefresh() {
    const refreshedFloorId = floor?.id ?? null;
    setIsManualRefreshing(true);
    setRefreshError(null);
    const results = await Promise.allSettled([
      refreshDashboard(),
      fixtureQuery.refetch({ throwOnError: true }),
      mapQuery.refetch({ throwOnError: true })
    ]);
    const failureCount = results.filter((result) => result.status === "rejected").length;
    setMapRefreshFailedFloorId((current) => results[2]?.status === "rejected"
      ? refreshedFloorId
      : current === refreshedFloorId ? null : current);
    if (failureCount < results.length) setLastRefreshedAt(Date.now());
    if (failureCount === results.length) {
      setRefreshError("현황 데이터를 새로고침하지 못했습니다.");
    } else if (failureCount > 0) {
      setRefreshError("일부 현황 데이터를 새로고침하지 못했습니다.");
    }
    setIsManualRefreshing(false);
  }

  async function handleMapRetry() {
    const retriedFloorId = floor?.id ?? null;
    setMapRefreshFailedFloorId((current) => current === retriedFloorId ? null : current);
    try {
      await mapQuery.refetch({ throwOnError: true });
    } catch {
      setMapRefreshFailedFloorId(retriedFloorId);
    }
  }

  return (
    <section className="screen-grid monitoring-screen">
      <PageHeader
        title="운영 현황"
        description={`${floor?.name ?? "층 미등록"} · 실시간 조명 상태`}
        actions={(
          <div className="monitoring-heading-actions">
            <div className="monitoring-refresh-actions">
              <button
                className="secondary-button"
                type="button"
                disabled={isManualRefreshing}
                onClick={() => void handleRefresh()}
              >
                <RefreshCw aria-hidden="true" size={15} className={isManualRefreshing ? "is-spinning" : undefined} />
                {isManualRefreshing ? "새로고침 중" : "새로고침"}
              </button>
              <small>{lastRefreshedAt > 0 ? `마지막 갱신: ${formatUpdatedAt(lastRefreshedAt)}` : "갱신 시각 확인 중"}</small>
              {refreshError ? <span className="monitoring-refresh-error" role="status">{refreshError}</span> : null}
            </div>
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
        )}
      />

      {userRole === "admin" && data.gateways.length > 0 ? (
        <RegistrationPanel dashboard={data} dashboardQuerySiteId={siteId} />
      ) : null}

      <div className="summary-row">
        <MetricCard label="전체 조명" value={floorSummary.totalFixtures} helper="선택 층 기준" tone="primary" />
        <MetricCard label="정상" value={floorSummary.onlineFixtures} helper="최근 수신 정상" tone="success" />
        <MetricCard label="점검 필요" value={floorSummary.faultFixtures} helper="우선 점검 대상" tone="danger" />
        <MetricCard label="평균 밝기" value={floorSummary.averageBrightness} unit="%" helper="현재 디밍" />
      </div>

      <div className="operations-layout">
        <div className="map-panel">
          {floor && mapSnapshot ? (
            <>
              <FloorMap floor={{ ...floor, fixtures }} snapshot={mapSnapshot} selectedFixtureId={selectedFixture?.id ?? null} onSelectFixture={setSelectedFixtureId} />
              {mapQuery.error || mapRefreshFailed ? (
                <FeedbackState
                  tone="danger"
                  icon={TriangleAlert}
                  title="저장된 지도를 유지하고 있습니다. 지도 갱신에 실패했습니다."
                  action={<button className="secondary-button" type="button" onClick={() => void handleMapRetry()}>지도 다시 시도</button>}
                />
              ) : null}
            </>
          ) : floor && (mapQuery.error || mapRefreshFailed) ? (
            <FeedbackState
              tone="danger"
              icon={TriangleAlert}
              title="저장된 지도를 불러오지 못했습니다."
              action={<button className="secondary-button" type="button" onClick={() => void handleMapRetry()}>지도 다시 시도</button>}
            />
          ) : (
            <div className="panel">등록된 층이 없습니다.</div>
          )}
        </div>
        <aside className="detail-panel" aria-label="선택 조명 상세">
          <div className="panel-title-row">
            <div>
              <span className="eyebrow">상세 패널</span>
              <h3>{selectedFixture?.name ?? "조명 선택"}</h3>
            </div>
            <FixtureStatusBadge fixture={selectedFixture} />
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
                  <dt>장비 Health</dt>
                  <dd>{formatHealthStatus(selectedFixture.health)}</dd>
                </div>
                <div>
                  <dt>Health 수신</dt>
                  <dd>{formatLastSeen(selectedFixture.health?.observedAt ?? null)}</dd>
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
            </div>
          ) : (
            <p className="muted-text">지도에서 조명을 선택하면 상태와 제어 정보를 확인할 수 있습니다.</p>
          )}
        </aside>
      </div>
    </section>
  );
}

function formatRssi(value: number | null) {
  return value === null ? "수집 전" : `${value} dBm`;
}

function FixtureStatusBadge({ fixture }: { fixture: Dashboard["floors"][number]["fixtures"][number] | undefined }) {
  if (!fixture) return <StatusBadge tone="neutral" icon={Clock3}>대기</StatusBadge>;
  if (fixture.statusReason === "provisioning_waiting_state") {
    return <StatusBadge tone="warning" icon={Clock3}>상태 확인 대기</StatusBadge>;
  }
  if (fixture.status === "online") return <StatusBadge tone="success" icon={CircleCheck}>{statusLabels.online}</StatusBadge>;
  if (fixture.status === "fault") return <StatusBadge tone="danger" icon={TriangleAlert}>{statusLabels.fault}</StatusBadge>;
  return <StatusBadge tone="neutral" icon={CircleX}>{statusLabels.offline}</StatusBadge>;
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

function formatHealthStatus(health: Dashboard["floors"][number]["fixtures"][number]["health"]) {
  if (!health) return "확인 대기";
  if (health.faultCodes.length === 0) return "정상";
  const codes = health.faultCodes.map((code) => `0x${code.toString(16).padStart(2, "0").toUpperCase()}`);
  return `장애 (${codes.join(", ")})`;
}

function formatUpdatedAt(value: number) {
  return new Intl.DateTimeFormat("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  }).format(new Date(value));
}
