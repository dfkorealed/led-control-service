import { Clock3, Filter, RefreshCw, TriangleAlert } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useDashboard, useFloorFixtures, useFloorMapSnapshot, type Dashboard } from "../../api/queries";
import { useCurrentUser } from "../../api/auth";
import { principalKey } from "../../api/principal-cache";
import { waitForMonitoringRefresh, type MonitoringRefreshResult } from "../../api/monitoring-refresh";
import { Button, Popover, FeedbackState, Heading, OperationMapPanel, SelectBox, Text, cn, useWorkspaceFocus, useSessionStatus, type SessionStatusItem } from "../../components/ui";
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

  const pageHeader = <Heading as="h1" className="sr-only">모니터링</Heading>;
  if (isLoading && !data) return <section className="grid min-w-0 gap-5">{pageHeader}<FeedbackState icon={Clock3} title="모니터링 현황을 불러오는 중" /></section>;
  if (!data) return <section className="grid min-w-0 gap-5">{pageHeader}<FeedbackState tone="danger" icon={TriangleAlert} title="현황 데이터를 불러오지 못했습니다." action={<Button variant="secondary" onClick={() => void dashboardQuery.refetch()}>다시 시도</Button>} /></section>;

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
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const detailReturnRef = useRef<HTMLElement | null>(null);
  const detailScopeRef = useRef<string | null>(null);
  const detailRef = useRef<HTMLElement | null>(null);
  const detailBodyRef = useRef<HTMLDivElement | null>(null);
  const detailScrollRef = useRef(0);
  const detailScrollRestoringRef = useRef(false);
  const [isPinOpen, setIsPinOpen] = useState(false);
  const workspaceFocus = useWorkspaceFocus();
  const [fixtureFilter, setFixtureFilter] = useState<MonitoringFixtureFilter>("all");
  const [fixtureSearch, setFixtureSearch] = useState("");
  const [focusRequest, setFocusRequest] = useState<{ requestId: number; fixtureId: string }>();
  const focusSequence = useRef(0);
  const pinDetailsFixtureRef = useRef<string | null>(null);
  const logTriggerRef = useRef<HTMLButtonElement>(null);
  const inspectorTriggerRef = useRef<HTMLButtonElement>(null);
  const finderOpenerRef = useRef<HTMLButtonElement | null>(null);
  const refreshButtonRef = useRef<HTMLButtonElement>(null);
  const floor = data.floors.find((item) => item.id === selectedFloorId) ?? data.floors[0];
  const detailScope = JSON.stringify([principal, siteId ?? data.site.id, floor?.id]);
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
  const selectedFixture = selectedFixtureId === null ? undefined : filteredFixtures.find(fixture => fixture.id === selectedFixtureId);
  const selectedRuntimeFixture = selectedFixtureId === null ? undefined : fixtures.find(fixture => fixture.id === selectedFixtureId);
  const selectedPin = mapSnapshot?.fixtures?.find(pin => pin.id === selectedFixtureId);
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
  useEffect(() => { setSelectedFixtureId(null); setIsLogDrawerOpen(false); setIsInspectorOpen(false); setIsDetailOpen(false); setFixtureFilter("all"); setFixtureSearch(""); setFocusRequest(undefined); pinDetailsFixtureRef.current = null; }, [floor?.id, principal]);
  useEffect(() => { detailScrollRef.current = 0; }, [selectedFixtureId]);
  useEffect(() => {
    if (!isDetailOpen) return;
    detailScrollRestoringRef.current = true;
    let releaseFrame: number | undefined;
    const frame = requestAnimationFrame(() => {
      const body = detailBodyRef.current;
      if (body) body.scrollTop = detailScrollRef.current;
      if (!detailRef.current?.contains(document.activeElement)) detailRef.current?.focus({ preventScroll: true });
      releaseFrame = requestAnimationFrame(() => { detailScrollRestoringRef.current = false; });
    });
    return () => { cancelAnimationFrame(frame); if (releaseFrame !== undefined) cancelAnimationFrame(releaseFrame); };
  }, [isDetailOpen, selectedFixtureId]);

  function clearSelection() {
    // Automatic runtime exclusion/deletion can remove a focused nonmodal aside.
    // Return only its own current-scope focus, before removal: no deferred job
    // may steal outside focus after an account/site/floor change or unmount.
    if (isDetailOpen && detailScopeRef.current === detailScope && detailRef.current?.contains(document.activeElement)) {
      const opener = detailReturnRef.current;
      const target = opener?.isConnected && opener.tabIndex >= 0 && !detailRef.current.contains(opener) && !("disabled" in opener && opener.disabled)
        ? opener : finderOpenerRef.current ?? inspectorTriggerRef.current;
      target?.focus({ preventScroll: true });
    }
    setSelectedFixtureId(null); setIsDetailOpen(false); setFocusRequest(undefined); pinDetailsFixtureRef.current = null;
  }
  function openDetail(id: string, trigger?: HTMLElement) {
    if (selectedFixtureId !== id) detailScrollRef.current = 0;
    detailReturnRef.current = trigger ?? (isInspectorOpen ? finderOpenerRef.current : document.activeElement instanceof HTMLElement ? document.activeElement : null);
    detailScopeRef.current = detailScope;
    setSelectedFixtureId(id); setIsInspectorOpen(false); setIsDetailOpen(true);
  }
  function rememberDetailScroll(scrollTop: number) {
    if (!detailScrollRestoringRef.current) detailScrollRef.current = scrollTop;
  }
  function closeDetail() {
    setIsDetailOpen(false);
    requestAnimationFrame(() => (detailReturnRef.current?.isConnected ? detailReturnRef.current : finderOpenerRef.current ?? inspectorTriggerRef.current)?.focus({ preventScroll: true }));
  }

  function openInspector(opener: HTMLButtonElement) {
    // The unified finder keeps the existing data/filter owner. Keep the initiating anchor
    // outside the transient portal so dismissal and detail return target it.
    finderOpenerRef.current = opener;
    setIsInspectorOpen(true);
  }

  function closeInspector() {
    const returnToPin = pinDetailsFixtureRef.current;
    pinDetailsFixtureRef.current = null;
    setIsInspectorOpen(false);
    // Popover focus restoration targets the toolbar. Revisit the originating pin
    // after it closes so compact navigation cannot cover the map target.
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
    // A confirmed runtime row leaving the current search/filter is invalid,
    // unlike a saved pin whose runtime row has not arrived in paged results.
    // Placement exclusion additionally needs a successful map observation.
    const runtimeConfirmed = hasFixtureData && !fixtureQuery.isFetching && !fixtureQuery.error;
    const placementConfirmed = fixtureFilter !== "unplaced" || Boolean(mapSnapshot && !mapQuery.isFetching && !mapQuery.error);
    if (selectedRuntimeFixture && runtimeConfirmed && placementConfirmed && !selectedFixture) {
      clearSelection();
      return;
    }
    // Only a complete successful pair of sources can establish deletion.
    // A saved pin before its runtime row remains an explicit loading selection.
    if (selectedFixtureId && hasFixtureData && mapSnapshot && !fixtureQuery.isFetching && !mapQuery.isFetching && !fixtureQuery.hasNextPage
      && !fixtureQuery.error && !mapQuery.error && !fixtures.some(fixture => fixture.id === selectedFixtureId) && !selectedPin) clearSelection();
  }, [floor?.id, fixtures, mapSnapshot, hasFixtureData, selectedFixtureId, selectedFixture, selectedRuntimeFixture, selectedPin, fixtureFilter, fixtureQuery.isFetching, fixtureQuery.hasNextPage, fixtureQuery.error, mapQuery.isFetching, mapQuery.error]);

  useEffect(() => {
    if (!mapRefreshFailure || mapRefreshFailure.floorId !== floor?.id) return;
    if (!mapQuery.data || mapQuery.error || mapQuery.isFetching) return;
    if (mapQuery.dataUpdatedAt <= mapRefreshFailure.dataUpdatedAt) return;
    setMapRefreshFailure((current) => current === mapRefreshFailure ? null : current);
  }, [floor?.id, mapQuery.data, mapQuery.dataUpdatedAt, mapQuery.error, mapQuery.isFetching, mapRefreshFailure]);

  if (!data.site.id) {
    return (
      <section className="grid min-w-0 gap-4" data-monitoring-screen="">
        <Heading as="h1" className="sr-only">모니터링</Heading>
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
    setSelectedFloorId(floorId);
    clearSelection();
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
    // The compact minimum must include bottom-navigation padding after the
    // ticker; overflowing a fixed-height section loses that trailing scroll space.
    <section className={cn("flex h-full min-h-0 min-w-0 flex-1 flex-col gap-4", !workspaceFocus.active && "max-compact:min-h-min max-compact:pb-shell-navigation-safe", workspaceFocus.active && "h-full! gap-2!")} data-monitoring-screen="" onKeyDown={event => {
      if (event.key !== "Escape" || event.defaultPrevented || isPinOpen || isInspectorOpen || isDetailOpen || isLogDrawerOpen || !workspaceFocus.active) return;
      event.preventDefault(); workspaceFocus.exit();
    }}>
      <Heading as="h1" className="sr-only">모니터링</Heading>
      <MonitoringSessionStatuses
        timeZone={data.site.timeZone ?? "Asia/Seoul"}
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
      <div className="flex min-w-0 items-center gap-2 max-compact:order-1" role="group" aria-label="모니터링 도구">
          <SelectBox
            label="맵 선택"
            items={data.floors.map((item) => ({ id: item.id, label: item.name }))}
            selectedKey={floor?.id ?? null}
            isDisabled={data.floors.length === 0}
            onSelectionChange={(floorId) => floorId !== null && handleSelectFloor(floorId)}
            className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-2 compact:w-64 max-compact:flex-1 max-compact:[&_label]:sr-only"
          />
          <Button ref={inspectorTriggerRef} variant="secondary" className="shrink-0 max-tablet:size-13 max-tablet:p-0" aria-label="조명 검색/목록" aria-haspopup="dialog" aria-expanded={isInspectorOpen} onClick={event => openInspector(event.currentTarget)}><Filter size={16} aria-hidden="true" /><span className="max-tablet:hidden">조명 검색/목록</span></Button>
          <Text as="small" variant="caption" tone="secondary" className="ml-auto min-w-0 shrink-0 text-right">
            {formatSnapshotUpdatedAt(snapshotFreshness, data.site.timeZone ?? "Asia/Seoul")}
          </Text>
          <Button ref={refreshButtonRef} variant="secondary" className="shrink-0 max-tablet:size-13 max-tablet:p-0" aria-label={isManualRefreshing ? "장치 상태 확인 중" : "새로고침"} disabled={isManualRefreshing} aria-busy={isManualRefreshing} onClick={() => void handleRefresh()}>
            <RefreshCw aria-hidden="true" size={16} className={isManualRefreshing ? "animate-spin" : undefined} />
            <span className="max-tablet:hidden">{isManualRefreshing ? "장치 상태 확인 중" : "새로고침"}</span>
          </Button>
      </div>

      <FixtureQueryFeedback
        enabled={Boolean(floor)}
        floorName={floor?.name}
        hasData={hasFixtureData}
        error={fixtureQuery.error}
        onRetry={() => void fixtureQuery.refetch()}
      />

      {/* Compact maps consume remaining viewport space; the natural minimum
          keeps the canvas and ticker reachable through document scroll on short screens. */}
      <div className={cn("grid min-h-0 min-w-0 flex-1 gap-4 tablet:min-h-min max-compact:order-3", !workspaceFocus.active && "max-compact:min-h-min")} data-monitoring-layout="">
        <div className="flex h-full min-h-min min-w-0 flex-col gap-5" data-monitoring-map-panel="">
          <OperationMapPanel className="min-h-min"
            status={floor ? <MonitoringSummary scope="floor" mapName={floor.name}
              total={floor.summary?.totalFixtures ?? null} online={floor.summary?.onlineFixtures ?? null}
              fault={floor.summary?.faultFixtures ?? null} offline={floor.summary?.offlineFixtures ?? null} /> : undefined}>
          {data.summary.totalFixtures === 0 ? (
            <EmptyFixtureGuidance userRole={userRole} siteId={data.site.id} />
          ) : floor && mapSnapshot && (hasFixtureData || Boolean(mapSnapshot.fixtures?.length)) ? (
            <>
              <FloorMap floor={{ ...floor, fixtures }} snapshot={mapSnapshot} selectedFixtureId={selectedFixtureId} onSelectFixture={id => { setFixtureSearch(""); setFixtureFilter("all"); setSelectedFixtureId(id); }} timeZone={data.site.timeZone}
                focusRequest={focusRequest} emphasizedFixtureIds={emphasizedFixtureIds}
                fullView={workspaceFocus.active}
                activeFilter={`${fixtureFilter}:${normalizedSearch}`}
                onToggleFullView={trigger => workspaceFocus.active ? workspaceFocus.exit() : workspaceFocus.enter(trigger)}
                cameraScope={principal ? { principal, siteId: siteId ?? data.site.id, floorId: floor.id } : null}
                onPinOpenChange={setIsPinOpen}
                detailOpen={isDetailOpen}
                onShowDetails={(id, trigger) => openDetail(id, trigger)}
                onFocusResult={(_id, result) => { if (result !== "focused" && inspectorTriggerRef.current) openInspector(inspectorTriggerRef.current); }}
              />
              {fixtures.length > 0 && !hasPlacedFixtures && <FeedbackState icon={Clock3} title="배치된 조명이 없습니다" description={`등록된 조명 ${fixtures.length}개는 목록에서 조회하고 제어할 수 있습니다.`} action={userRole === "admin" ? <Link to={`/settings/floor-plans/${encodeURIComponent(floor.id)}/edit?siteId=${encodeURIComponent(data.site.id)}`}>설정에서 조명 배치</Link> : undefined} />}
            </>
          ) : !hasFixtureData ? null : floor && (mapQuery.error || mapRefreshFailed) ? (
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
          {/* The overlay is out of flow: opening detail never changes the map
              viewport or camera. Only its reading body scrolls; map remains usable. */}
          {isDetailOpen && selectedFixtureId ? <aside ref={detailRef} tabIndex={-1} aria-label="조명 상세" className="absolute inset-x-0 bottom-0 z-10 flex h-1/2 min-h-0 min-w-0 flex-col border-t border-border-default bg-surface-panel p-3 shadow-popover compact:p-4" onKeyDown={event => { if (event.key === "Escape" && !event.defaultPrevented) { event.preventDefault(); closeDetail(); } }}>
            <div className="flex shrink-0 items-start justify-between gap-3"><Heading as="h2" variant="card-title">조명 상세</Heading><Button variant="ghost" className="min-h-13" onClick={closeDetail} aria-label="조명 상세 닫기">닫기</Button></div>
            <div ref={detailBodyRef} onScroll={event => rememberDetailScroll(event.currentTarget.scrollTop)} data-monitoring-detail-scroll="" className="min-h-0 flex-1 overflow-y-auto overscroll-contain"><FixtureDetailPanel fixture={selectedFixture ?? null} selectedName={selectedPin?.name} position={selectedPin ? { kind: "placed", point: { x: selectedPin.x, y: selectedPin.y } } : resolveFixtureMapPosition(mapSnapshot, selectedFixture)} timeZone={data.site.timeZone} /></div>
          </aside> : null}
          </OperationMapPanel>
          {floor ? <MonitoringLogTicker
            scopeKey={detailScope}
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
      <Popover
        isOpen={isInspectorOpen}
        onOpenChange={open => { if (!open) closeInspector(); }}
        triggerRef={finderOpenerRef.current ? finderOpenerRef : inspectorTriggerRef}
        mobilePresentation="bottom-sheet"
        label="조명 검색/목록"
        placement="bottom end"
        className="w-96 min-w-0 max-h-[min(36rem,var(--available-height))]"
      >
        <div className="grid min-w-0 gap-4">
        <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
          <Heading as="h2" variant="customer-card-title">조명 검색/목록</Heading>
          <Button variant="ghost" onClick={closeInspector} aria-label="조명 검색/목록 닫기">닫기</Button>
        </div>
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
              } else openDetail(id);
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
            onFilterChange={filter => { clearSelection(); setFixtureFilter(filter); }}
            search={fixtureSearch}
            onSearchChange={search => { clearSelection(); setFixtureSearch(search); }}
            nextPageError={fixtureQuery.isFetchNextPageError}
            expectedTotal={floor.summary?.totalFixtures}
          />
        </div> : null}
        {fixtureFilter !== "all" ? <Button variant="secondary" onClick={() => { clearSelection(); setFixtureFilter("all"); }}>필터 초기화</Button> : null}
        {selectedFixtureId ? <Button variant="secondary" onClick={() => openDetail(selectedFixtureId)}>상세 보기</Button> : null}
        </div>
      </Popover>
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
  timeZone,
  siteId, floorId, hasFixtureData, fixtureError, hasMapSnapshot, mapError,
  snapshotFreshness, refreshError, hardwareRefreshFailure, onRefresh, onMapRetry
}: {
  timeZone: string;
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
      snapshotFreshness.metadata === "future" ? `시간 차이 확인: ${formatMonitoringTimestamp(anomalousGeneratedAt!, timeZone)}` : null,
      snapshotFreshness.freshness === "stale" ? "가장 오래된 선택 층 snapshot이 60초를 초과했습니다." : null,
      snapshotFreshness.metadata === "invalid" ? "서버가 유효한 generatedAt ISO 시각을 반환하지 않았습니다." : null
    ].filter(Boolean).join(" · ");
    return [{
      id: `query:monitoring:${scope}:fixtures`,
      fingerprint: `fixtures:${fixtureError}:${snapshotFreshness.metadata}:${snapshotFreshness.freshness}:${anomalousGeneratedAt ?? ""}`,
      source: "query", tone: "warning", title, description,
      // Pure snapshot delay stays actionable in current-screen alarms, without
      // inventing a durable device incident or repeating transient notifications.
      announce: fixtureError || snapshotFreshness.metadata !== "valid",
      action: { label: fixtureError ? "조명 상태 다시 시도" : "다시 시도", onAction: () => actions.current.onRefresh() }
    }];
  }, [anomalousGeneratedAt, fixtureError, floorId, hasFixtureData, scope, snapshotFreshness.freshness, snapshotFreshness.metadata, timeZone]);
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
  const notice = snapshot.metadata === "invalid" ? "마지막 갱신: 서버 snapshot 시각 확인 필요"
    : snapshot.freshness === "pending" || snapshot.rawGeneratedAt === undefined ? "마지막 갱신: 서버 snapshot 시각 확인 중"
      : snapshot.metadata === "future" ? `마지막 갱신: 시간 차이 확인 (${formatMonitoringTimestamp(snapshot.anomalousGeneratedAt!, timeZone)})` : null;
  if (notice) return <span title={notice}><span className="max-tablet:sr-only">{notice}</span><span aria-hidden="true" className="hidden max-tablet:inline">시각 확인</span></span>;
  if (!snapshot.rawGeneratedAt) return null;
  const full = formatMonitoringTimestamp(snapshot.rawGeneratedAt, timeZone);
  // The shared formatter owns strict instant/zone validation and canonical
  // YYYY-MM-DD HH:mm:ss output; compact copy must not reparse with a fallback zone.
  const short = full === "—" ? full : full.slice(11, 16);
  return <span title={`마지막 갱신: ${full} (현장 시간)`}>
    <span className="max-tablet:sr-only">마지막 갱신: </span>
    <time dateTime={snapshot.rawGeneratedAt} aria-label={`${full} (현장 시간)`}><span className="max-tablet:hidden">{full} (현장 시간)</span><span aria-hidden="true" className="hidden max-tablet:inline">{short}</span></time>
  </span>;
}
