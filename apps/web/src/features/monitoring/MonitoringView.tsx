import { CircleCheck, CircleX, Clock3, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useDashboard, useFloorFixtures, useFloorMapSnapshot, type Dashboard } from "../../api/queries";
import { Button, FeedbackState, MetricCard, SidePanel, StatusBadge } from "../../components/ui";
import { InstallationPending } from "../setup/SetupWizard";
import { FloorMap } from "./FloorMap";
import { presentFixtureStatus } from "./fixture-status-presentation";

const STALE_SNAPSHOT_AFTER_MS = 60_000;
const MAX_BROWSER_TIMEOUT_MS = 2_147_483_647;

export function MonitoringView({ userRole = "admin", siteId }: { userRole?: "operator" | "admin" | "viewer"; siteId?: string }) {
  const dashboardQuery = useDashboard(siteId);
  const { data, isLoading, error } = dashboardQuery;

  if (isLoading && !data) return <div className="panel">불러오는 중</div>;
  if (!data) return <div className="panel danger">현황 데이터를 불러오지 못했습니다.</div>;

  return (
    <MonitoringDashboard
      data={data}
      userRole={userRole}
      siteId={siteId}
      dashboardError={error}
      refreshDashboard={() => dashboardQuery.refetch({ throwOnError: true })}
    />
  );
}

interface MonitoringDashboardProps {
  data: Dashboard;
  userRole: "operator" | "admin" | "viewer";
  siteId?: string;
  dashboardError: unknown;
  refreshDashboard: () => Promise<unknown>;
}

function MonitoringDashboard({ data, userRole, siteId, dashboardError, refreshDashboard }: MonitoringDashboardProps) {
  const [selectedFloorId, setSelectedFloorId] = useState<string | null>(null);
  const [selectedFixtureId, setSelectedFixtureId] = useState<string | null>(null);
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<string | null>(null);
  const [mapRefreshFailedFloorId, setMapRefreshFailedFloorId] = useState<string | null>(null);
  const [freshnessRevision, setFreshnessRevision] = useState(0);
  const floor = data.floors.find((item) => item.id === selectedFloorId) ?? data.floors[0];
  const fixtureQuery = useFloorFixtures(floor?.id, siteId ?? data.site.id);
  const mapQuery = useFloorMapSnapshot(floor?.id, siteId ?? data.site.id);
  const hasFixtureData = fixtureQuery.data !== undefined;
  const fixtures = fixtureQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const mapSnapshot = mapQuery.data;
  const mapRefreshFailed = mapRefreshFailedFloorId === floor?.id;
  const selectedFixture = fixtures.find((fixture) => fixture.id === selectedFixtureId) ?? fixtures[0];
  const selectedFixturePresentation = selectedFixture ? presentFixtureStatus(selectedFixture) : null;
  const snapshotFreshness = useMemo(
    // A newly arrived server response must be compared with this render's wall clock, not a
    // periodic timer value captured before the response arrived.
    () => getSnapshotFreshness(fixtureQuery.data?.pages.map((page) => page.generatedAt), Date.now()),
    [fixtureQuery.data?.pages, freshnessRevision]
  );
  const staleSources = [
    dashboardError ? "현황" : null,
    fixtureQuery.error ? "조명 상태" : null,
    mapQuery.error || mapRefreshFailed ? "지도" : null
  ].filter((source): source is string => Boolean(source));
  const isStale = staleSources.length > 0 || snapshotFreshness.freshness === "stale" || snapshotFreshness.metadata !== "valid";
  const floorSummary = useMemo(
    () => ({
      totalFixtures: fixtures.length,
      onlineFixtures: fixtures.filter((fixture) => fixture.status === "online").length,
      faultFixtures: fixtures.filter((fixture) => fixture.status === "fault").length,
      offlineFixtures: fixtures.filter((fixture) => fixture.status === "offline").length
    }),
    [fixtures]
  );
  useEffect(() => {
    if (fixtureQuery.hasNextPage && !fixtureQuery.isFetchingNextPage) void fixtureQuery.fetchNextPage();
  }, [fixtureQuery.hasNextPage, fixtureQuery.isFetchingNextPage, fixtureQuery.fetchNextPage]);

  useEffect(() => {
    if (snapshotFreshness.nextReviewAt === undefined) return;
    const delay = Math.max(0, snapshotFreshness.nextReviewAt - Date.now());
    // Browsers clamp overflowing delays to an immediate timer. A far-future server clock is
    // re-evaluated by the normal query refresh instead of repeatedly scheduling zero-delay work.
    if (delay > MAX_BROWSER_TIMEOUT_MS) return;
    const timeout = window.setTimeout(() => setFreshnessRevision((revision) => revision + 1), delay);
    return () => window.clearTimeout(timeout);
  }, [snapshotFreshness.nextReviewAt]);

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
    if (userRole !== "admin") {
      return (
        <section className="screen-grid monitoring-screen">
          <InstallationPending />
        </section>
      );
    }

    return (
      <section className="screen-grid monitoring-screen">
        <div className="screen-heading">
          <div>
            <span className="eyebrow">초기 설정</span>
            <h2>등록된 조명이 없습니다</h2>
          </div>
        </div>
        <FeedbackState
          icon={Clock3}
          title="조명 등록은 설정 페이지에서 진행합니다"
          description="게이트웨이 연결과 조명 검색·등록은 설정의 조명 등록 메뉴에서 사용할 수 있습니다."
          action={<Link to={`/settings/registration?siteId=${encodeURIComponent(data.site.id)}`}>설정 페이지로 이동</Link>}
        />
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
    <section className="screen-grid monitoring-screen monitoring-dashboard">
      <div className="monitoring-toolbar" role="group" aria-label="모니터링 도구">
        <label className="monitoring-floor-selector">
          <span>맵 선택</span>
          <select
            aria-label="맵 선택"
            value={floor?.id ?? ""}
            disabled={data.floors.length === 0}
            onChange={(event) => handleSelectFloor(event.target.value)}
          >
            {data.floors.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <div className="monitoring-refresh-actions">
          <small>{formatSnapshotUpdatedAt(snapshotFreshness)}</small>
          {refreshError ? <span className="monitoring-refresh-error" role="status">{refreshError}</span> : null}
          <Button
            variant="secondary"
            isLoading={isManualRefreshing}
            loadingLabel="새로고침 중"
            onClick={() => void handleRefresh()}
          >
            <RefreshCw aria-hidden="true" size={15} className={isManualRefreshing ? "is-spinning" : undefined} />
            새로고침
          </Button>
        </div>
      </div>

      <FixtureQueryFeedback
        floorName={floor?.name}
        hasData={hasFixtureData}
        error={fixtureQuery.error}
      />

      {isStale ? (
        <FeedbackState
          tone="danger"
          icon={TriangleAlert}
          title={snapshotFreshness.metadata === "invalid"
            ? "서버 snapshot 시각을 확인할 수 없습니다."
            : fixtureQuery.error && !hasFixtureData
              ? "조명 상태를 불러오지 못했습니다."
              : fixtureQuery.error
                ? "저장된 조명 상태를 유지하고 있습니다. 조명 상태 갱신에 실패했습니다."
            : dashboardError && staleSources.length === 1
              ? "저장된 현황을 유지하고 있습니다. 현황 갱신에 실패했습니다."
              : "현황 갱신이 지연되고 있습니다."}
          description={[
            staleSources.length > 0 ? `${staleSources.join(", ")} 갱신 실패` : null,
            snapshotFreshness.metadata === "future" ? `시간 차이 확인: ${snapshotFreshness.anomalousGeneratedAt}` : null,
            snapshotFreshness.freshness === "stale" ? "가장 오래된 선택 층 snapshot이 60초를 초과했습니다." : null,
            snapshotFreshness.metadata === "invalid" ? "서버가 유효한 generatedAt ISO 시각을 반환하지 않았습니다." : null
          ].filter(Boolean).join(" · ")}
          action={<Button variant="secondary" isLoading={isManualRefreshing} onClick={() => void handleRefresh()}>{fixtureQuery.error ? "조명 상태 다시 시도" : "다시 시도"}</Button>}
        />
      ) : null}

      {hasFixtureData ? (
        <>
          <div className="summary-row">
            <MetricCard label="전체 조명" value={floorSummary.totalFixtures} helper="선택 층 기준" tone="primary" />
            <MetricCard label="정상" value={floorSummary.onlineFixtures} helper="최근 수신 정상" tone="success" />
            <MetricCard label="점검 필요" value={floorSummary.faultFixtures} helper="우선 점검 대상" tone="danger" />
            <MetricCard label="오프라인" value={floorSummary.offlineFixtures} helper="상태 확인 대기 포함" />
          </div>

          <label className="monitoring-fixture-selector">
            <span>상세 조명 선택</span>
            <select
              aria-label="상세 조명 선택"
              value={selectedFixture?.id ?? ""}
              onChange={(event) => setSelectedFixtureId(event.target.value)}
            >
              {fixtures.map((fixture) => (
                <option key={fixture.id} value={fixture.id}>
                  {fixture.name} · {presentFixtureStatus(fixture).label}
                </option>
              ))}
            </select>
          </label>

          <div className="operations-layout ui-side-panel-layout">
            <div className="map-panel">
              {floor && mapSnapshot ? (
                <>
                  <FloorMap floor={{ ...floor, fixtures }} snapshot={mapSnapshot} selectedFixtureId={selectedFixture?.id ?? null} onSelectFixture={setSelectedFixtureId} />
                  {fixtures.length > 0 && fixtures.every((fixture) => fixture.placementStatus === "unplaced") && <FeedbackState icon={Clock3} title="배치된 조명이 없습니다" description={`등록된 조명 ${fixtures.length}개는 목록에서 조회하고 제어할 수 있습니다.`} action={userRole === "admin" ? <Link to={`/settings/floor-plans/${encodeURIComponent(floor.id)}/edit?siteId=${encodeURIComponent(data.site.id)}`}>설정에서 조명 배치</Link> : undefined} />}
                  {mapQuery.error || mapRefreshFailed ? (
                    <FeedbackState
                      tone="danger"
                      icon={TriangleAlert}
                      title="저장된 지도를 유지하고 있습니다. 지도 갱신에 실패했습니다."
                      action={<Button variant="secondary" onClick={() => void handleMapRetry()}>지도 다시 시도</Button>}
                    />
                  ) : null}
                </>
              ) : floor && (mapQuery.error || mapRefreshFailed) ? (
                <FeedbackState
                  tone="danger"
                  icon={TriangleAlert}
                  title="저장된 지도를 불러오지 못했습니다."
                  action={<Button variant="secondary" onClick={() => void handleMapRetry()}>지도 다시 시도</Button>}
                />
              ) : floor ? (
                <FeedbackState icon={Clock3} title="저장된 지도를 불러오는 중" />
              ) : (
                <div className="panel">등록된 층이 없습니다.</div>
              )}
            </div>
            <SidePanel className="detail-panel" aria-label="선택 조명 상세">
              <div className="panel-title-row">
                <div>
                  <span className="eyebrow">상세 패널</span>
                  <h3>{selectedFixture?.name ?? "조명 선택"}</h3>
                </div>
                <FixtureStatusBadge fixture={selectedFixture} />
              </div>

              {selectedFixture ? (
                <section className="detail-stack" aria-label="선택 조명 정보">
                  <div className="brightness-card">
                    <span>현재 밝기</span>
                    <strong>{selectedFixture.brightness}%</strong>
                    <div className="progress-track">
                      <span style={{ width: `${selectedFixture.brightness}%` }} />
                    </div>
                  </div>
                  <dl className="info-list">
                    <div>
                      <dt>상태 원인</dt>
                      <dd>{selectedFixturePresentation?.description}</dd>
                    </div>
                    <div>
                      <dt>권장 조치</dt>
                      <dd>{selectedFixturePresentation?.recommendedAction}</dd>
                    </div>
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
                </section>
              ) : (
                <p className="muted-text">지도에서 조명을 선택하면 상태와 제어 정보를 확인할 수 있습니다.</p>
              )}
            </SidePanel>
          </div>
        </>
      ) : null}

    </section>
  );
}

function FixtureQueryFeedback({
  floorName,
  hasData,
  error
}: {
  floorName: string | undefined;
  hasData: boolean;
  error: unknown;
}) {
  if (error || hasData) return null;
  return <FeedbackState icon={Clock3} title={`${floorName ? `${floorName} ` : ""}조명 상태를 불러오는 중`} />;
}

function formatRssi(value: number | null) {
  return value === null ? "수집 전" : `${value} dBm`;
}

function FixtureStatusBadge({ fixture }: { fixture: Dashboard["floors"][number]["fixtures"][number] | undefined }) {
  if (!fixture) return <StatusBadge tone="neutral" icon={Clock3}>대기</StatusBadge>;
  const presentation = presentFixtureStatus(fixture);
  const icon = presentation.tone === "success" ? CircleCheck
    : presentation.tone === "warning" ? Clock3
      : presentation.tone === "danger" ? TriangleAlert
        : CircleX;
  return <StatusBadge tone={presentation.tone} icon={icon}>{presentation.label}</StatusBadge>;
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

function getSnapshotFreshness(generatedAts: unknown[] | undefined, now: number): {
  freshness: "pending" | "fresh" | "stale";
  metadata: "valid" | "future" | "invalid";
  rawGeneratedAt?: string;
  anomalousGeneratedAt?: string;
  nextReviewAt?: number;
} {
  if (!generatedAts?.length) return { freshness: "pending", metadata: "valid" };

  const parsed = generatedAts.map(parseStrictIsoTimestamp);
  const invalid = parsed.find((entry) => entry.kind === "invalid");
  const valid = parsed.filter((entry): entry is { kind: "valid"; rawGeneratedAt: string; value: number } => entry.kind === "valid");
  const future = valid.find((entry) => entry.value > now);
  const oldest = valid.reduce<{ kind: "valid"; rawGeneratedAt: string; value: number } | undefined>(
    (current, entry) => !current || entry.value < current.value ? entry : current,
    undefined
  );
  const freshness = oldest && now - oldest.value > STALE_SNAPSHOT_AFTER_MS ? "stale" : "fresh";
  const staleBoundary = oldest && oldest.value <= now && freshness === "fresh"
    ? oldest.value + STALE_SNAPSHOT_AFTER_MS + 1
    : undefined;
  const futureBoundary = valid.filter((entry) => entry.value > now).reduce<number | undefined>(
    (current, entry) => current === undefined || entry.value < current ? entry.value : current,
    undefined
  );

  return {
    freshness,
    metadata: invalid ? "invalid" : future ? "future" : "valid",
    rawGeneratedAt: oldest?.rawGeneratedAt,
    anomalousGeneratedAt: future?.rawGeneratedAt,
    nextReviewAt: [staleBoundary, futureBoundary].reduce<number | undefined>(
      (current, entry) => entry === undefined || current !== undefined && current <= entry ? current : entry,
      undefined
    )
  };
}

function parseStrictIsoTimestamp(value: unknown):
  | { kind: "valid"; rawGeneratedAt: string; value: number }
  | { kind: "invalid" } {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return { kind: "invalid" };
  const timestamp = new Date(value).getTime();
  // Date parses overflowed calendar dates (for example February 30) by normalizing them.
  // Round-tripping canonical server ISO output rejects that normalization.
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) return { kind: "invalid" };
  return { kind: "valid", rawGeneratedAt: value, value: timestamp };
}

function formatSnapshotUpdatedAt(snapshot: ReturnType<typeof getSnapshotFreshness>) {
  if (snapshot.metadata === "invalid") return "마지막 갱신: 서버 snapshot 시각 확인 필요";
  if (snapshot.freshness === "pending") return "마지막 갱신: 서버 snapshot 시각 확인 중";
  if (snapshot.metadata === "future") return `마지막 갱신: 시간 차이 확인 (${snapshot.anomalousGeneratedAt})`;
  return `마지막 갱신: ${snapshot.rawGeneratedAt}`;
}
