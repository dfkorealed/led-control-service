import { CircleCheck, CircleX, Clock3, RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useDashboard, useFloorFixtures, useFloorMapSnapshot, type Dashboard } from "../../api/queries";
import { Button, FeedbackState, Heading, MetricCard, SelectBox, SidePanel, StatusBadge, Text } from "../../components/ui";
import { InstallationPending } from "../setup/SetupWizard";
import { FloorMap } from "./FloorMap";
import { presentFixtureStatus } from "./fixture-status-presentation";

const STALE_SNAPSHOT_AFTER_MS = 60_000;
const MAX_BROWSER_TIMEOUT_MS = 2_147_483_647;

interface MapRefreshFailure {
  floorId: string;
  dataUpdatedAt: number;
}

type ManualRefreshFailureSource = "dashboard" | "fixtures";

export function MonitoringView({ userRole = "admin", siteId }: { userRole?: "operator" | "admin" | "viewer"; siteId?: string }) {
  const dashboardQuery = useDashboard(siteId);
  const { data, isLoading, error } = dashboardQuery;

  if (isLoading && !data) return <FeedbackState icon={Clock3} title="모니터링 현황을 불러오는 중" />;
  if (!data) return <FeedbackState tone="danger" icon={TriangleAlert} title="현황 데이터를 불러오지 못했습니다." />;

  return (
    <MonitoringDashboard
      key={data.site.id}
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
  const [manualRefreshFailureSources, setManualRefreshFailureSources] = useState<ManualRefreshFailureSource[]>([]);
  const [mapRefreshFailure, setMapRefreshFailure] = useState<MapRefreshFailure | null>(null);
  const [freshnessRevision, setFreshnessRevision] = useState(0);
  const floor = data.floors.find((item) => item.id === selectedFloorId) ?? data.floors[0];
  const fixtureQuery = useFloorFixtures(floor?.id, siteId ?? data.site.id);
  const mapQuery = useFloorMapSnapshot(floor?.id, siteId ?? data.site.id);
  const hasFixtureData = fixtureQuery.data !== undefined;
  const fixtures = fixtureQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const mapSnapshot = mapQuery.data;
  const mapRefreshFailed = Boolean(floor && mapRefreshFailure && mapRefreshFailure.floorId === floor.id);
  const selectedFixture = fixtures.find((fixture) => fixture.id === selectedFixtureId) ?? fixtures[0];
  const selectedFixturePresentation = selectedFixture ? presentFixtureStatus(selectedFixture) : null;
  const snapshotFreshness = useMemo(
    // A newly arrived server response must be compared with this render's wall clock, not a
    // periodic timer value captured before the response arrived.
    () => getSnapshotFreshness(floor ? fixtureQuery.data?.pages.map((page) => page.generatedAt) : undefined, Date.now()),
    [floor, fixtureQuery.data?.pages, freshnessRevision]
  );
  const staleSources = [
    dashboardError ? "현황" : null,
    floor && fixtureQuery.error ? "조명 상태" : null,
    floor && (mapQuery.error || mapRefreshFailed) ? "지도" : null
  ].filter((source): source is string => Boolean(source));
  const isStale = staleSources.length > 0 || Boolean(floor && (snapshotFreshness.freshness === "stale" || snapshotFreshness.metadata !== "valid"));
  const manualRefreshFailureCount = manualRefreshFailureSources.length + (mapRefreshFailed ? 1 : 0);
  const refreshError = manualRefreshFailureCount === 3
    ? "현황 데이터를 새로고침하지 못했습니다."
    : manualRefreshFailureCount > 0 ? "일부 현황 데이터를 새로고침하지 못했습니다." : null;
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
    if (floor && fixtureQuery.hasNextPage && !fixtureQuery.isFetchingNextPage) void fixtureQuery.fetchNextPage();
  }, [floor, fixtureQuery.hasNextPage, fixtureQuery.isFetchingNextPage, fixtureQuery.fetchNextPage]);

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

  useEffect(() => {
    if (!mapRefreshFailure || mapRefreshFailure.floorId !== floor?.id) return;
    if (!mapQuery.data || mapQuery.error || mapQuery.isFetching) return;
    if (mapQuery.dataUpdatedAt <= mapRefreshFailure.dataUpdatedAt) return;
    setMapRefreshFailure((current) => current === mapRefreshFailure ? null : current);
  }, [floor?.id, mapQuery.data, mapQuery.dataUpdatedAt, mapQuery.error, mapQuery.isFetching, mapRefreshFailure]);

  if (!data.site.id) {
    return (
      <section className="grid min-w-0 gap-4" data-monitoring-screen="">
        <InstallationPending />
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
    setManualRefreshFailureSources([]);
    const results = await Promise.allSettled([
      refreshDashboard(),
      floor ? fixtureQuery.refetch({ throwOnError: true }) : Promise.resolve(),
      floor ? mapQuery.refetch({ throwOnError: true }) : Promise.resolve()
    ]);
    setManualRefreshFailureSources([
      results[0]?.status === "rejected" ? "dashboard" : null,
      results[1]?.status === "rejected" ? "fixtures" : null
    ].filter((source): source is ManualRefreshFailureSource => source !== null));
    setMapRefreshFailure((current) => results[2]?.status === "rejected" && refreshedFloorId
      ? { floorId: refreshedFloorId, dataUpdatedAt: mapQuery.dataUpdatedAt }
      : current?.floorId === refreshedFloorId ? null : current);
    setIsManualRefreshing(false);
  }

  async function handleMapRetry() {
    const retriedFloorId = floor?.id ?? null;
    try {
      await mapQuery.refetch({ throwOnError: true });
      setMapRefreshFailure((current) => current?.floorId === retriedFloorId ? null : current);
    } catch {
      setMapRefreshFailure(retriedFloorId ? { floorId: retriedFloorId, dataUpdatedAt: mapQuery.dataUpdatedAt } : null);
    }
  }

  return (
    <section className="grid min-w-0 gap-4 tablet:flex tablet:h-[calc(100dvh-7.25rem)] tablet:min-h-0 tablet:overflow-hidden tablet:flex-col" data-monitoring-screen="">
      <div className="flex items-center justify-between gap-4 max-compact:flex-col max-compact:items-stretch" role="group" aria-label="모니터링 도구">
        <SelectBox
          label="맵 선택"
          items={data.floors.map((item) => ({ id: item.id, label: item.name }))}
          selectedKey={floor?.id ?? null}
          isDisabled={data.floors.length === 0}
          onSelectionChange={(floorId) => floorId !== null && handleSelectFloor(floorId)}
          className="monitoring-map-selector grid w-full max-w-56 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 max-compact:max-w-none"
        />
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2 text-content-secondary max-compact:ml-0 max-compact:w-full">
          <Text as="small" variant="caption" tone="secondary" className="whitespace-nowrap">{formatSnapshotUpdatedAt(snapshotFreshness)}</Text>
          {refreshError ? <Text as="span" variant="label" tone="danger" role="status">{refreshError}</Text> : null}
          <Button
            variant="secondary"
            isLoading={isManualRefreshing}
            loadingLabel="새로고침 중"
            onClick={() => void handleRefresh()}
          >
            <RefreshCw aria-hidden="true" size={15} className={isManualRefreshing ? "animate-spin" : undefined} />
            새로고침
          </Button>
        </div>
      </div>

      <FixtureQueryFeedback
        enabled={Boolean(floor)}
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

      {hasFixtureData && data.summary.totalFixtures > 0 ? (
        <>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(9.375rem,1fr))] gap-3" data-monitoring-summary="">
            <MetricCard className="min-h-18 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3" label="전체 조명" value={floorSummary.totalFixtures} helper="선택 층 기준" tone="primary" />
            <MetricCard className="min-h-18 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3" label="정상" value={floorSummary.onlineFixtures} helper="최근 수신 정상" tone="success" />
            <MetricCard className="min-h-18 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3" label="점검 필요" value={floorSummary.faultFixtures} helper="우선 점검 대상" tone="danger" />
            <MetricCard className="min-h-18 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 px-4 py-3" label="오프라인" value={floorSummary.offlineFixtures} helper="상태 확인 대기 포함" />
          </div>

          <div className="hidden max-compact:block" data-monitoring-fixture-selector="">
            <SelectBox
              label="상세 조명 선택"
              items={fixtures.map((fixture) => ({ id: fixture.id, label: `${fixture.name} · ${presentFixtureStatus(fixture).label}` }))}
              selectedKey={selectedFixture?.id ?? null}
              onSelectionChange={(fixtureId) => setSelectedFixtureId(fixtureId)}
              className="w-full"
            />
          </div>
        </>
      ) : null}

      <div className="grid min-h-0 min-w-0 flex-1 grid-cols-1 items-stretch gap-4 tablet:grid-cols-[minmax(0,1fr)_clamp(17.5rem,26vw,21.25rem)] tablet:overflow-hidden" data-monitoring-layout="">
        <div className="min-h-0 min-w-0 overflow-hidden" data-monitoring-map-panel="">
          {data.summary.totalFixtures === 0 ? (
            <EmptyFixtureGuidance userRole={userRole} siteId={data.site.id} />
          ) : !hasFixtureData ? null : floor && mapSnapshot ? (
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
            <FeedbackState icon={Clock3} title="등록된 층이 없습니다." />
          )}
        </div>
            <SidePanel className="grid min-w-0 grid-cols-1 content-start gap-4 border-border-default bg-surface-panel p-4.5 shadow-none max-tablet:grid-cols-2 max-compact:grid-cols-1" aria-label="선택 조명 상세" data-monitoring-detail-panel="">
              <div className="flex min-w-0 items-start justify-between gap-3 max-tablet:col-span-full">
                <div className="min-w-0">
                  <Text as="span" variant="overline" tone="secondary">상세 패널</Text>
                  <Heading as="h3" variant="card-title">{selectedFixture?.name ?? "조명 선택"}</Heading>
                </div>
                <FixtureStatusBadge fixture={selectedFixture} />
              </div>

              {selectedFixture ? (
                <section className="grid min-w-0 gap-3.5 max-tablet:col-span-full max-tablet:grid-cols-2 max-compact:grid-cols-1" aria-label="선택 조명 정보">
                  <div className="grid gap-2 rounded-panel bg-action-primary p-4 text-content-inverse">
                    <Text as="span" variant="body-sm" tone="inverse" weight="bold">현재 밝기</Text>
                    <Text as="strong" variant="display" tone="inverse">{selectedFixture.brightness}%</Text>
                    <div className="h-2 overflow-hidden rounded-control bg-action-primary-soft">
                      {/* Brightness is runtime device data, so only this measured percentage remains inline. */}
                      <span className="block h-full rounded-control bg-surface-panel" style={{ width: `${selectedFixture.brightness}%` }} />
                    </div>
                  </div>
                  <dl className="m-0 grid gap-2">
                    <div className="grid grid-cols-[minmax(5rem,0.8fr)_minmax(0,1.2fr)] items-center gap-3 rounded-control border border-border-default bg-surface-elevated p-3">
                      <dt className="min-w-0 text-body-sm text-content-secondary">상태 원인</dt>
                      <dd className="m-0 min-w-0 text-right text-body font-bold text-content-primary">{selectedFixturePresentation?.description}</dd>
                    </div>
                    <div className="grid grid-cols-[minmax(5rem,0.8fr)_minmax(0,1.2fr)] items-center gap-3 rounded-control border border-border-default bg-surface-elevated p-3">
                      <dt className="min-w-0 text-body-sm text-content-secondary">권장 조치</dt>
                      <dd className="m-0 min-w-0 text-right text-body font-bold text-content-primary">{selectedFixturePresentation?.recommendedAction}</dd>
                    </div>
                    <div className="grid grid-cols-[minmax(5rem,0.8fr)_minmax(0,1.2fr)] items-center gap-3 rounded-control border border-border-default bg-surface-elevated p-3">
                      <dt className="min-w-0 text-body-sm text-content-secondary">정격 전력</dt>
                      <dd className="m-0 min-w-0 text-right text-body font-bold text-content-primary">{selectedFixture.ratedWatt} W</dd>
                    </div>
                    <div className="grid grid-cols-[minmax(5rem,0.8fr)_minmax(0,1.2fr)] items-center gap-3 rounded-control border border-border-default bg-surface-elevated p-3">
                      <dt className="min-w-0 text-body-sm text-content-secondary">마지막 수신</dt>
                      <dd className="m-0 min-w-0 text-right text-body font-bold text-content-primary">{formatLastSeen(selectedFixture.lastSeenAt)}</dd>
                    </div>
                    <div className="grid grid-cols-[minmax(5rem,0.8fr)_minmax(0,1.2fr)] items-center gap-3 rounded-control border border-border-default bg-surface-elevated p-3">
                      <dt className="min-w-0 text-body-sm text-content-secondary">장비 Health</dt>
                      <dd className="m-0 min-w-0 text-right text-body font-bold text-content-primary">{formatHealthStatus(selectedFixture.health)}</dd>
                    </div>
                    <div className="grid grid-cols-[minmax(5rem,0.8fr)_minmax(0,1.2fr)] items-center gap-3 rounded-control border border-border-default bg-surface-elevated p-3">
                      <dt className="min-w-0 text-body-sm text-content-secondary">Health 수신</dt>
                      <dd className="m-0 min-w-0 text-right text-body font-bold text-content-primary">{formatLastSeen(selectedFixture.health?.observedAt ?? null)}</dd>
                    </div>
                    <div className="grid grid-cols-[minmax(5rem,0.8fr)_minmax(0,1.2fr)] items-center gap-3 rounded-control border border-border-default bg-surface-elevated p-3">
                      <dt className="min-w-0 text-body-sm text-content-secondary">게이트웨이</dt>
                      <dd className="m-0 min-w-0 text-right text-body font-bold text-content-primary">
                        {selectedFixture.gateway
                          ? `${selectedFixture.gateway.name} (${selectedFixture.gateway.connectionStatus === "online" ? "정상" : "오프라인"})`
                          : "미매핑"}
                      </dd>
                    </div>
                    <div className="grid grid-cols-[minmax(5rem,0.8fr)_minmax(0,1.2fr)] items-center gap-3 rounded-control border border-border-default bg-surface-elevated p-3">
                      <dt className="min-w-0 text-body-sm text-content-secondary">RSSI</dt>
                      <dd className="m-0 min-w-0 text-right text-body font-bold text-content-primary">{formatRssi(selectedFixture.rssi)}</dd>
                    </div>
                    <div className="grid grid-cols-[minmax(5rem,0.8fr)_minmax(0,1.2fr)] items-center gap-3 rounded-control border border-border-default bg-surface-elevated p-3">
                      <dt className="min-w-0 text-body-sm text-content-secondary">Hop</dt>
                      <dd className="m-0 min-w-0 text-right text-body font-bold text-content-primary">{selectedFixture.hopCount ?? "수집 전"}</dd>
                    </div>
                    <div className="grid grid-cols-[minmax(5rem,0.8fr)_minmax(0,1.2fr)] items-center gap-3 rounded-control border border-border-default bg-surface-elevated p-3">
                      <dt className="min-w-0 text-body-sm text-content-secondary">명령 성공률</dt>
                      <dd className="m-0 min-w-0 text-right text-body font-bold text-content-primary">{formatSuccessRate(selectedFixture.commandSuccessRate)}</dd>
                    </div>
                  </dl>
                </section>
              ) : (
                <Text tone="secondary">지도에서 조명을 선택하면 상태와 제어 정보를 확인할 수 있습니다.</Text>
              )}
            </SidePanel>
      </div>

    </section>
  );
}

function EmptyFixtureGuidance({ userRole, siteId }: { userRole: MonitoringDashboardProps["userRole"]; siteId: string }) {
  if (userRole !== "admin") return <InstallationPending />;
  return <>
    <div className="flex items-end justify-between gap-4">
      <div className="min-w-0">
        <Text as="span" variant="overline" tone="secondary">초기 설정</Text>
        <Heading as="h2" variant="section-title">등록된 조명이 없습니다</Heading>
      </div>
    </div>
    <FeedbackState
      icon={Clock3}
      title="조명 등록은 설정 페이지에서 진행합니다"
      description="게이트웨이 연결과 조명 검색·등록은 설정의 조명 등록 메뉴에서 사용할 수 있습니다."
      action={<Link to={`/settings/registration?siteId=${encodeURIComponent(siteId)}`}>설정 페이지로 이동</Link>}
    />
  </>;
}

function FixtureQueryFeedback({
  enabled,
  floorName,
  hasData,
  error
}: {
  enabled: boolean;
  floorName: string | undefined;
  hasData: boolean;
  error: unknown;
}) {
  if (!enabled || error || hasData) return null;
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
