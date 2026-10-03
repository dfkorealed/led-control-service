import { Clock3, RefreshCw, TriangleAlert } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useDashboard, useFloorFixtures, useFloorMapSnapshot, type Dashboard } from "../../api/queries";
import { useCurrentUser } from "../../api/auth";
import { principalKey } from "../../api/principal-cache";
import { waitForMonitoringRefresh, type MonitoringRefreshResult } from "../../api/monitoring-refresh";
import { Button, DrawerDialog, FeedbackState, Heading, SelectBox, Text, cn, useWorkspaceFocus, useSessionStatus, type SessionStatusItem } from "../../components/ui";
import { InstallationPending } from "../setup/SetupWizard";
import { FloorMap } from "./FloorMap";
import { MonitoringFixtureFinder } from "./MonitoringFixtureFinder";
import { MonitoringSummary } from "./MonitoringSummary";
import { MonitoringLogDrawer } from "./MonitoringLogDrawer";
import { MonitoringLogTicker } from "./MonitoringLogTicker";
import { monitoringActivityScopeKey, useMonitoringActivity } from "./useMonitoringActivity";
import { FixtureDetailPanel } from "./FixtureDetailPanel";
import { resolveFixtureMapPosition } from "../floor-map/fixture-map-position";
import { matchesMonitoringFixture, matchesMonitoringFixtureSearch, type MonitoringFixtureFilter } from "./monitoring-fixture-filter";
import { presentFixtureStatus } from "./fixture-status-presentation";
import { formatMonitoringTimestamp } from "./monitoring-time";

const STALE_SNAPSHOT_AFTER_MS = 60_000;
const MAX_BROWSER_TIMEOUT_MS = 2_147_483_647;
interface MapRefreshFailure {
  floorId: string;
  dataUpdatedAt: number;
}

type ManualRefreshFailureSource = "dashboard" | "fixtures";

function copyForTerminal(result: MonitoringRefreshResult | null): string | null {
  switch (result?.status) {
    case "partial": return "일부 조명의 상태를 확인하지 못했습니다.";
    case "failed": return "장치 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.";
    case "expired": return "장치 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요.";
    default: return null;
  }
}

export function MonitoringView({ userRole = "admin", siteId }: { userRole?: "operator" | "admin" | "viewer"; siteId?: string }) {
  const dashboardQuery = useDashboard(siteId);
  const { data, isLoading } = dashboardQuery;

  if (isLoading && !data) return <FeedbackState icon={Clock3} title="모니터링 현황을 불러오는 중" />;
  if (!data) return <FeedbackState tone="danger" icon={TriangleAlert} title="현황 데이터를 불러오지 못했습니다." action={<Button variant="secondary" onClick={() => void dashboardQuery.refetch()}>다시 시도</Button>} />;

  return (
    <MonitoringDashboard
      key={siteId ?? data.site.id}
      data={data}
      userRole={userRole}
      siteId={siteId}
      refreshDashboard={() => dashboardQuery.refetch({ throwOnError: true })}
    />
  );
}

interface MonitoringDashboardProps {
  data: Dashboard;
  userRole: "operator" | "admin" | "viewer";
  siteId?: string;
  refreshDashboard: () => Promise<unknown>;
}

function MonitoringDashboard({ data, userRole, siteId, refreshDashboard }: MonitoringDashboardProps) {
  const queryClient = useQueryClient();
  const currentUser = useCurrentUser();
  const principal = currentUser.data?.user ? principalKey(currentUser.data.user) : null;
  const [selectedFloorId, setSelectedFloorId] = useState<string | null>(null);
  const [selectedFixtureId, setSelectedFixtureId] = useState<string | null>(null);
  const [isManualRefreshing, setIsManualRefreshing] = useState(false);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const [hardwareRefreshFailure, setHardwareRefreshFailure] = useState<string | null>(null);
  const [manualRefreshFailureSources, setManualRefreshFailureSources] = useState<ManualRefreshFailureSource[]>([]);
  const [mapRefreshFailure, setMapRefreshFailure] = useState<MapRefreshFailure | null>(null);
  const [freshnessRevision, setFreshnessRevision] = useState(0);
  const [isLogDrawerOpen, setIsLogDrawerOpen] = useState(false);
  const [isInspectorOpen, setIsInspectorOpen] = useState(false);
  const [finderDefaultOpen, setFinderDefaultOpen] = useState(false);
  const [isPinOpen, setIsPinOpen] = useState(false);
  const workspaceFocus = useWorkspaceFocus();
  const [fixtureFilter, setFixtureFilter] = useState<MonitoringFixtureFilter>("all");
  const [fixtureSearch, setFixtureSearch] = useState("");
  const [focusRequest, setFocusRequest] = useState<{ requestId: number; fixtureId: string }>();
  const focusSequence = useRef(0);
  const pinDetailsFixtureRef = useRef<string | null>(null);
  const logTriggerRef = useRef<HTMLButtonElement>(null);
  const inspectorTriggerRef = useRef<HTMLButtonElement>(null);
  const refreshButtonRef = useRef<HTMLButtonElement>(null);
  const floor = data.floors.find((item) => item.id === selectedFloorId) ?? data.floors[0];
  const activityQuery = useMonitoringActivity({ principal, siteId: siteId ?? data.site.id, floorId: floor?.id });
  const fixtureQuery = useFloorFixtures(floor?.id, siteId ?? data.site.id);
  const mapQuery = useFloorMapSnapshot(floor?.id, siteId ?? data.site.id);
  const hasFixtureData = fixtureQuery.data !== undefined;
  const fixtures = fixtureQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const mapSnapshot = mapQuery.data;
  const placedFixtureIds = useMemo(() => new Set(mapSnapshot?.fixtures?.map((item) => item.id) ?? []), [mapSnapshot?.fixtures]);
  // Saved layout can refresh before runtime placement DTOs. Match FloorScene's
  // snapshot placements plus its legacy/runtime-only placement fallback.
  const hasPlacedFixtures = Boolean(mapSnapshot?.fixtures?.length) || fixtures.some((fixture) => fixture.placementStatus !== "unplaced");
  const mapRefreshFailed = Boolean(floor && mapRefreshFailure && mapRefreshFailure.floorId === floor.id);
  const normalizedSearch = fixtureSearch.trim().toLocaleLowerCase("ko-KR");
  const filteredFixtures = fixtures.filter(fixture => matchesMonitoringFixtureSearch(fixture, normalizedSearch)
    && matchesMonitoringFixture(fixture, fixtureFilter, resolveFixtureMapPosition(mapSnapshot, fixture)));
  // A KPI filter must never leave an unrelated fixture in the selector, map selection, or detail panel.
  const selectedFixture = selectedFixtureId === null
    ? filteredFixtures[0]
    : filteredFixtures.find((fixture) => fixture.id === selectedFixtureId) ?? (fixtureFilter === "all" && !normalizedSearch ? undefined : filteredFixtures[0]);
  const emphasizedFixtureIds = fixtureFilter === "all" && !normalizedSearch ? undefined : new Set(filteredFixtures.map(fixture => fixture.id));
  const snapshotFreshness = useMemo(
    // A newly arrived server response must be compared with this render's wall clock, not a
    // periodic timer value captured before the response arrived.
    () => getSnapshotFreshness(floor ? fixtureQuery.data?.pages.map((page) => page.generatedAt) : undefined, Date.now()),
    [floor, fixtureQuery.data?.pages, freshnessRevision]
  );
  const manualRefreshFailureCount = manualRefreshFailureSources.length + (mapRefreshFailed ? 1 : 0);
  const refreshError = manualRefreshFailureCount === 3
    ? "현황 데이터를 새로고침하지 못했습니다."
    : manualRefreshFailureCount > 0 ? "일부 현황 데이터를 새로고침하지 못했습니다." : null;
  useEffect(() => {
    // Also covers a floor removed by a dashboard update, without a selector event.
    setIsManualRefreshing(false);
    setHardwareRefreshFailure(null);
    return () => {
      refreshAbortRef.current?.abort();
      refreshAbortRef.current = null;
    };
  }, [floor?.id, siteId]);
  useEffect(() => { setIsLogDrawerOpen(false); setIsInspectorOpen(false); setFixtureFilter("all"); setFixtureSearch(""); setFocusRequest(undefined); pinDetailsFixtureRef.current = null; }, [floor?.id, principal]);

  function closeInspector() {
    const returnToPin = pinDetailsFixtureRef.current;
    pinDetailsFixtureRef.current = null;
    setIsInspectorOpen(false);
    // Dialog focus restoration targets the toolbar. Revisit the originating pin
    // after the drawer closes so compact navigation cannot cover the map target.
    if (returnToPin) window.requestAnimationFrame(() => setFocusRequest({ requestId: ++focusSequence.current, fixtureId: returnToPin }));
  }

  useEffect(() => {
    if (floor && fixtureQuery.hasNextPage && !fixtureQuery.isFetchingNextPage && !fixtureQuery.isFetchNextPageError) void fixtureQuery.fetchNextPage();
  }, [floor, fixtureQuery.hasNextPage, fixtureQuery.isFetchingNextPage, fixtureQuery.isFetchNextPageError, fixtureQuery.fetchNextPage]);

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
      // Saved pins can arrive before their paged runtime row. Keep that explicit
      // selection without presenting another fixture's telemetry as its detail.
      if (current && (fixtures.some((fixture) => fixture.id === current) || mapSnapshot?.fixtures?.some((fixture) => fixture.id === current))) return current;
      return fixtures.find((fixture) => fixture.status === "fault")?.id ?? fixtures[0]?.id ?? null;
    });
  }, [floor?.id, fixtures, mapSnapshot?.fixtures]);

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
    if (floorId === floor?.id) return;
    refreshAbortRef.current?.abort();
    refreshAbortRef.current = null;
    setIsManualRefreshing(false);
    setHardwareRefreshFailure(null);
    setManualRefreshFailureSources([]);
    const nextFloor = data.floors.find((item) => item.id === floorId);
    setSelectedFloorId(floorId);
    setSelectedFixtureId(nextFloor?.fixtures.find((fixture) => fixture.status === "fault")?.id ?? nextFloor?.fixtures[0]?.id ?? null);
  }

  async function refetchMonitoringSources(signal: AbortSignal, initialFixtureRequest?: Promise<unknown>) {
    const refreshedFloorId = floor?.id ?? null;
    const results = await Promise.allSettled([
      refreshDashboard(),
      initialFixtureRequest ?? (floor ? fixtureQuery.refetch({ throwOnError: true }) : Promise.resolve()),
      floor ? mapQuery.refetch({ throwOnError: true }) : Promise.resolve()
    ]);
    // Query caches may complete after navigation; only the current refresh owns UI feedback.
    if (signal.aborted) return;
    setManualRefreshFailureSources([
      results[0]?.status === "rejected" ? "dashboard" : null,
      results[1]?.status === "rejected" ? "fixtures" : null
    ].filter((source): source is ManualRefreshFailureSource => source !== null));
    setMapRefreshFailure((current) => results[2]?.status === "rejected" && refreshedFloorId
      ? { floorId: refreshedFloorId, dataUpdatedAt: mapQuery.dataUpdatedAt }
      : current?.floorId === refreshedFloorId ? null : current);
  }

  async function handleRefresh() {
    if (refreshAbortRef.current) return;
    const controller = new AbortController();
    refreshAbortRef.current = controller;
    setIsManualRefreshing(true);
    setHardwareRefreshFailure(null);
    let initialFixtureRequest: Promise<unknown> | undefined;
    try {
      let hasFixtures = fixtures.length > 0;
      if (floor && !hasFixtureData) {
        // Missing data is not an empty floor. Resolve the initial source before deciding
        // whether this click needs a hardware job, and retain source failures as such.
        const request = fixtureQuery.refetch({ throwOnError: true }).then((result) => {
          if (!result.data) throw new Error("Fixture data unavailable");
          return result.data;
        });
        initialFixtureRequest = request;
        const fixtureData = await request;
        controller.signal.throwIfAborted();
        hasFixtures = fixtureData.pages.some((page) => page.items.length > 0);
      }
      // Once hardware runs, all three sources must be fetched again after its result.
      if (hasFixtures) initialFixtureRequest = undefined;
      const terminal = floor && hasFixtures ? await waitForMonitoringRefresh({
        siteId: siteId ?? data.site.id,
        floorId: floor.id,
        clientRequestId: crypto.randomUUID(),
        signal: controller.signal
      }) : null;
      if (!controller.signal.aborted) {
        setHardwareRefreshFailure(copyForTerminal(terminal));
        if (terminal && principal && floor) void queryClient.invalidateQueries({ queryKey: monitoringActivityScopeKey(principal, siteId ?? data.site.id, floor.id) });
      }
    } catch (error) {
      if (!controller.signal.aborted && !initialFixtureRequest) {
        setHardwareRefreshFailure(error instanceof DOMException && error.name === "TimeoutError"
          ? "장치 응답 시간이 초과되었습니다. 잠시 후 다시 시도해 주세요."
          : "장치 상태를 확인하지 못했습니다. 잠시 후 다시 시도해 주세요.");
      }
    } finally {
      if (!controller.signal.aborted) await refetchMonitoringSources(controller.signal, initialFixtureRequest);
      if (refreshAbortRef.current === controller) refreshAbortRef.current = null;
      if (!controller.signal.aborted) setIsManualRefreshing(false);
    }
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
    <section className={cn("grid min-w-0 gap-4 tablet:flex tablet:h-[calc(100dvh-7.25rem)] tablet:min-h-0 tablet:overflow-hidden tablet:flex-col", workspaceFocus.active && "flex! h-full! min-h-0! flex-col! overflow-hidden! gap-2!")} data-monitoring-screen="" onKeyDown={event => {
      if (event.key !== "Escape" || event.defaultPrevented || isPinOpen || isInspectorOpen || isLogDrawerOpen || !workspaceFocus.active) return;
      event.preventDefault(); workspaceFocus.exit();
    }}>
      <MonitoringSessionStatuses
        siteId={siteId ?? data.site.id}
        floorId={floor?.id}
        hasFixtureData={hasFixtureData}
        fixtureError={Boolean(fixtureQuery.error)}
        hasMapSnapshot={Boolean(mapSnapshot)}
        mapError={Boolean(mapQuery.error || mapRefreshFailed)}
        snapshotFreshness={snapshotFreshness}
        refreshError={refreshError}
        hardwareRefreshFailure={hardwareRefreshFailure}
        onRefresh={() => void handleRefresh()}
        onMapRetry={() => void handleMapRetry()}
      />
      <div hidden={workspaceFocus.active} className={workspaceFocus.active ? "hidden" : "contents"}><MonitoringSummary
        scope="site"
        total={data.summary.totalFixtures}
        online={data.summary.onlineFixtures}
        fault={data.summary.faultFixtures}
        offline={data.summary.offlineFixtures ?? null}
      /></div>
      <div className="flex items-center justify-between gap-4 max-compact:flex-col max-compact:items-stretch" role="group" aria-label="모니터링 도구">
        {/* Compact layouts reserve the full row for the map value; the search
            action must not squeeze the value or chevron when text is enlarged. */}
        <div className="flex min-w-0 items-center gap-2 max-compact:w-full max-compact:flex-col max-compact:items-stretch">
          <SelectBox
            label="맵 선택"
            items={data.floors.map((item) => ({ id: item.id, label: item.name }))}
            selectedKey={floor?.id ?? null}
            isDisabled={data.floors.length === 0}
            onSelectionChange={(floorId) => floorId !== null && handleSelectFloor(floorId)}
            className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 max-compact:max-w-none max-compact:flex-none"
          />
          <Button ref={inspectorTriggerRef} variant="secondary" className="shrink-0 max-compact:self-end" onClick={() => { setFinderDefaultOpen(false); setIsInspectorOpen(true); }}>조명 검색·상세</Button>
        </div>
        <div className="ml-auto flex flex-wrap items-center justify-end gap-2 text-content-secondary max-compact:ml-0 max-compact:w-full">
          <Text as="small" variant="caption" tone="secondary" className="min-w-0 max-w-full break-words text-right">
            {formatSnapshotUpdatedAt(snapshotFreshness, data.site.timeZone)}
          </Text>
          <Button
            ref={refreshButtonRef}
            variant="secondary"
            disabled={isManualRefreshing}
            aria-busy={isManualRefreshing}
            onClick={() => void handleRefresh()}
          >
            <RefreshCw aria-hidden="true" size={15} className={isManualRefreshing ? "animate-spin" : undefined} />
            {isManualRefreshing ? "장치 상태 확인 중" : "새로고침"}
          </Button>
        </div>
      </div>

      <FixtureQueryFeedback
        enabled={Boolean(floor)}
        floorName={floor?.name}
        hasData={hasFixtureData}
        error={fixtureQuery.error}
        onRetry={() => void fixtureQuery.refetch()}
      />

      {floor ? <MonitoringSummary
        scope="floor"
        filter={fixtureFilter}
        onSelect={filter => { setFixtureSearch(""); setFixtureFilter(filter); setFinderDefaultOpen(true); setIsInspectorOpen(true); }}
        total={floor.summary?.totalFixtures ?? null}
        online={floor.summary?.onlineFixtures ?? null}
        fault={floor.summary?.faultFixtures ?? null}
        offline={floor.summary?.offlineFixtures ?? null}
      /> : null}

      <div className="min-h-0 min-w-0 flex-1" data-monitoring-layout="">
        <div className="flex h-full min-h-0 min-w-0 flex-col gap-5 overflow-hidden" data-monitoring-map-panel="">
          <div className="min-h-0 flex-1">
          {data.summary.totalFixtures === 0 ? (
            <EmptyFixtureGuidance userRole={userRole} siteId={data.site.id} />
          ) : !hasFixtureData ? null : floor && mapSnapshot ? (
            <>
              <FloorMap floor={{ ...floor, fixtures }} snapshot={mapSnapshot} selectedFixtureId={fixtureFilter === "all" && !normalizedSearch ? selectedFixtureId ?? selectedFixture?.id ?? null : selectedFixture?.id ?? null} onSelectFixture={id => { setFixtureSearch(""); setFixtureFilter("all"); setSelectedFixtureId(id); }} timeZone={data.site.timeZone}
                focusRequest={focusRequest} emphasizedFixtureIds={emphasizedFixtureIds}
                fullView={workspaceFocus.active}
                activeFilter={`${fixtureFilter}:${normalizedSearch}`}
                onToggleFullView={trigger => workspaceFocus.active ? workspaceFocus.exit() : workspaceFocus.enter(trigger)}
                cameraScope={principal ? { principal, siteId: siteId ?? data.site.id, floorId: floor.id } : null}
                onPinOpenChange={setIsPinOpen}
                onShowDetails={id => { pinDetailsFixtureRef.current = id; setSelectedFixtureId(id); setFinderDefaultOpen(false); setIsInspectorOpen(true); }}
                onFocusResult={(_id, result) => { if (result !== "focused") setIsInspectorOpen(true); }}
              />
              {fixtures.length > 0 && !hasPlacedFixtures && <FeedbackState icon={Clock3} title="배치된 조명이 없습니다" description={`등록된 조명 ${fixtures.length}개는 목록에서 조회하고 제어할 수 있습니다.`} action={userRole === "admin" ? <Link to={`/settings/floor-plans/${encodeURIComponent(floor.id)}/edit?siteId=${encodeURIComponent(data.site.id)}`}>설정에서 조명 배치</Link> : undefined} />}
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
          {floor ? <MonitoringLogTicker
            items={activityQuery.data?.items ?? []}
            generatedAt={activityQuery.data?.generatedAt ?? null}
            retainedFrom={activityQuery.data?.retainedFrom ?? null}
            isPending={activityQuery.isPending}
            error={activityQuery.error}
            isRefetchError={activityQuery.isRefetchError}
            timeZone={data.site.timeZone}
            onOpen={() => setIsLogDrawerOpen(true)}
            onRetry={() => void activityQuery.refetch()}
            triggerRef={logTriggerRef}
          /> : null}
        </div>
      </div>
      <DrawerDialog
        isOpen={isInspectorOpen}
        onClose={closeInspector}
        returnFocusRef={inspectorTriggerRef}
        fallbackFocusRef={refreshButtonRef}
        title="조명 검색·상세"
        closeLabel="조명 검색·상세 닫기"
        bodyClassName="grid min-w-0 gap-4"
      >
        {hasFixtureData && filteredFixtures.length > 0 ? <div data-monitoring-fixture-selector="">
          <SelectBox
            label="상세 조명 선택"
            items={filteredFixtures.map((fixture) => ({ id: fixture.id, label: `${fixture.name} · ${presentFixtureStatus(fixture).label}` }))}
            selectedKey={selectedFixture?.id ?? null}
            onSelectionChange={(fixtureId) => { pinDetailsFixtureRef.current = null; setSelectedFixtureId(fixtureId); }}
            className="w-full"
          />
        </div> : null}
        {floor && hasFixtureData ? <div className="min-w-0">
          <MonitoringFixtureFinder
            key={floor.id}
            fixtures={fixtures}
            selectedFixtureId={selectedFixture?.id ?? null}
            onSelectFixture={id => {
              pinDetailsFixtureRef.current = null;
              setSelectedFixtureId(id);
              const position = resolveFixtureMapPosition(mapSnapshot, fixtures.find(fixture => fixture.id === id));
              if (position.kind === "placed") {
                setIsInspectorOpen(false);
                setFocusRequest({ requestId: ++focusSequence.current, fixtureId: id });
              }
            }}
            hasNextPage={Boolean(fixtureQuery.hasNextPage)}
            isFetchingNextPage={fixtureQuery.isFetchingNextPage}
            onLoadMore={() => void fixtureQuery.fetchNextPage()}
            userRole={userRole}
            siteId={data.site.id}
            floorId={floor.id}
            placedFixtureIds={placedFixtureIds}
            snapshot={mapSnapshot}
            filter={fixtureFilter}
            onFilterChange={filter => { pinDetailsFixtureRef.current = null; setFixtureFilter(filter); }}
            search={fixtureSearch}
            onSearchChange={search => { pinDetailsFixtureRef.current = null; setFixtureSearch(search); }}
            defaultOpen={finderDefaultOpen}
            nextPageError={fixtureQuery.isFetchNextPageError}
            expectedTotal={floor.summary?.totalFixtures}
          />
        </div> : null}
        {(fixtureFilter === "all" && !normalizedSearch) || filteredFixtures.length > 0
          ? <FixtureDetailPanel fixture={selectedFixture ?? null} position={resolveFixtureMapPosition(mapSnapshot, selectedFixture)} timeZone={data.site.timeZone} /> : null}
      </DrawerDialog>
      <MonitoringLogDrawer
        isOpen={isLogDrawerOpen}
        onClose={() => setIsLogDrawerOpen(false)}
        returnFocusRef={logTriggerRef}
        fallbackFocusRef={refreshButtonRef}
        principal={principal}
        siteId={siteId ?? data.site.id}
        floorId={floor?.id ?? null}
        timeZone={data.site.timeZone}
      />

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
  error,
  onRetry
}: {
  enabled: boolean;
  floorName: string | undefined;
  hasData: boolean;
  error: unknown;
  onRetry: () => void;
}) {
  if (!enabled || hasData) return null;
  if (error) return <FeedbackState tone="danger" icon={TriangleAlert} title="조명 상태를 불러오지 못했습니다." action={<Button variant="secondary" onClick={onRetry}>조명 상태 다시 시도</Button>} />;
  return <FeedbackState icon={Clock3} title={`${floorName ? `${floorName} ` : ""}조명 상태를 불러오는 중`} />;
}

type SnapshotFreshness = ReturnType<typeof getSnapshotFreshness>;

function MonitoringSessionStatuses({
  siteId, floorId, hasFixtureData, fixtureError, hasMapSnapshot, mapError,
  snapshotFreshness, refreshError, hardwareRefreshFailure, onRefresh, onMapRetry
}: {
  siteId: string;
  floorId: string | undefined;
  hasFixtureData: boolean;
  fixtureError: boolean;
  hasMapSnapshot: boolean;
  mapError: boolean;
  snapshotFreshness: SnapshotFreshness;
  refreshError: string | null;
  hardwareRefreshFailure: string | null;
  onRefresh: () => void;
  onMapRetry: () => void;
}) {
  const actions = useRef({ onRefresh, onMapRetry });
  actions.current = { onRefresh, onMapRetry };
  const scope = `${siteId}:${floorId ?? "none"}`;
  const anomalousGeneratedAt = snapshotFreshness.metadata === "future" ? snapshotFreshness.anomalousGeneratedAt : undefined;
  const fixtureItems = useMemo<SessionStatusItem[]>(() => {
    if (!floorId || !hasFixtureData || (!fixtureError && snapshotFreshness.metadata === "valid" && snapshotFreshness.freshness !== "stale")) return [];
    const title = snapshotFreshness.metadata === "invalid"
      ? "서버 snapshot 시각을 확인할 수 없습니다."
      : fixtureError ? "저장된 조명 상태를 유지하고 있습니다. 조명 상태 갱신에 실패했습니다."
        : "현황 갱신이 지연되고 있습니다.";
    const description = [
      fixtureError ? "조명 상태 갱신 실패" : null,
      snapshotFreshness.metadata === "future" ? `시간 차이 확인: ${anomalousGeneratedAt}` : null,
      snapshotFreshness.freshness === "stale" ? "가장 오래된 선택 층 snapshot이 60초를 초과했습니다." : null,
      snapshotFreshness.metadata === "invalid" ? "서버가 유효한 generatedAt ISO 시각을 반환하지 않았습니다." : null
    ].filter(Boolean).join(" · ");
    return [{
      id: `query:monitoring:${scope}:fixtures`,
      fingerprint: `fixtures:${fixtureError}:${snapshotFreshness.metadata}:${snapshotFreshness.freshness}:${anomalousGeneratedAt ?? ""}`,
      source: "query", tone: "warning", title, description,
      action: { label: fixtureError ? "조명 상태 다시 시도" : "다시 시도", onAction: () => actions.current.onRefresh() }
    }];
  }, [anomalousGeneratedAt, fixtureError, floorId, hasFixtureData, scope, snapshotFreshness.freshness, snapshotFreshness.metadata]);
  const mapItems = useMemo<SessionStatusItem[]>(() => floorId && hasMapSnapshot && mapError ? [{
    id: `query:monitoring:${scope}:map`, fingerprint: "map-refresh-failed", source: "query", tone: "warning",
    title: "저장된 지도를 유지하고 있습니다. 지도 갱신에 실패했습니다.",
    action: { label: "지도 다시 시도", onAction: () => actions.current.onMapRetry() }
  }] : [], [floorId, hasMapSnapshot, mapError, scope]);
  const refreshItems = useMemo<SessionStatusItem[]>(() => {
    if (!refreshError && !hardwareRefreshFailure) return [];
    return [{
      id: `command:monitoring:${scope}:refresh`,
      fingerprint: `refresh:${refreshError ?? ""}:${hardwareRefreshFailure ?? ""}`,
      source: "command", tone: "warning",
      title: hardwareRefreshFailure ?? refreshError ?? "",
      description: hardwareRefreshFailure ? refreshError ?? undefined : undefined,
      action: { label: "다시 시도", onAction: () => actions.current.onRefresh() }
    }];
  }, [hardwareRefreshFailure, refreshError, scope]);
  useSessionStatus(`monitoring:${scope}:fixtures`, fixtureItems);
  useSessionStatus(`monitoring:${scope}:map`, mapItems);
  useSessionStatus(`monitoring:${scope}:refresh`, refreshItems);
  return null;
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

function formatSnapshotUpdatedAt(snapshot: ReturnType<typeof getSnapshotFreshness>, timeZone: string) {
  if (snapshot.metadata === "invalid") return "마지막 갱신: 서버 snapshot 시각 확인 필요";
  if (snapshot.freshness === "pending" || snapshot.rawGeneratedAt === undefined) return "마지막 갱신: 서버 snapshot 시각 확인 중";
  if (snapshot.metadata === "future") return `마지막 갱신: 시간 차이 확인 (${snapshot.anomalousGeneratedAt})`;
  return <>마지막 갱신: <time dateTime={snapshot.rawGeneratedAt}>{formatMonitoringTimestamp(snapshot.rawGeneratedAt, timeZone)} (현장 시간)</time></>;
}
