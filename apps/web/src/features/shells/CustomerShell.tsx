import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type RefObject } from "react";
import { Activity, Bell, BarChart3, CircleAlert, LoaderCircle, PanelLeftClose, PanelLeftOpen, SlidersHorizontal, UserRound } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link, matchPath, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { logout, type AuthUser } from "../../api/auth";
import { authMeQueryKey, clearTenantCache, principalKey } from "../../api/principal-cache";
import { useDashboard, useSites, type SiteCapabilities } from "../../api/queries";
import { KindaLogo } from "../../components/brand/KindaLogo";
import {
  Button,
  IconTooltipButton,
  ConfirmDialog,
  CustomerThemeProvider,
  ThemeToggle,
  FeedbackState,
  SessionStatusCenter,
  SessionStatusProvider,
  WorkspaceFocusProvider,
  Text,
  ToastRegion,
  useSessionStatus,
  type SessionStatusCenterHandle,
  type SessionStatusContextItem,
  type SessionStatusItem
} from "../../components/ui";
import { RouteLoadingState } from "../../components/ui/RouteLoadingState";
import {
  blockActiveCommandSession,
  unblockActiveCommandSession
} from "../control/active-command-session";
import { clearActiveCommandsForUser } from "../control/active-command-store";
import { hasDirtyEditorSentinel } from "../floor-editor/dirty-editor-history";
import { useFloorEditorStore } from "../floor-editor/editor-store";
import { deriveGatewayAggregate } from "./gateway-status";
import { PrimaryNavigationLink, SettingsNavigationItem, type NavigationLayout } from "./SettingsNavigationItem";
import { CustomerAccountContext } from "./CustomerAccountContext";
import { CustomerAccountPanel } from "./CustomerAccountPanel";
import { CustomerHeaderSummarySlot, type CustomerSiteSummary, type CustomerShellScope } from "./CustomerHeaderSummarySlot";
import { CustomerRouteErrorBoundary } from "./CustomerRouteErrorBoundary";

const MonitoringView = lazy(() => import("../monitoring/MonitoringView").then((module) => ({ default: module.MonitoringView })));
const ControlView = lazy(() => import("../control/ControlView").then((module) => ({ default: module.ControlView })));
const StatisticsShell = lazy(() => import("../statistics/StatisticsShell").then((module) => ({ default: module.StatisticsShell })));
const StatisticsIndexRedirect = lazy(() => import("../statistics/StatisticsShell").then((module) => ({ default: module.StatisticsIndexRedirect })));
const StatisticsOverviewPage = lazy(() => import("../statistics/StatisticsOverviewPage").then((module) => ({ default: module.StatisticsOverviewPage })));
const StatisticsAnalysisPage = lazy(() => import("../statistics/analysis/StatisticsAnalysisPage").then((module) => ({ default: module.StatisticsAnalysisPage })));
const StatisticsReportsPage = lazy(() => import("../statistics/reports/StatisticsReportsPage").then((module) => ({ default: module.StatisticsReportsPage })));
const SettingsShell = lazy(() => import("../settings/SettingsShell").then((module) => ({ default: module.SettingsShell })));
const SettingsView = lazy(() => import("../settings/SettingsView").then((module) => ({ default: module.SettingsView })));
const SiteUsersView = lazy(() => import("../settings/users/SiteUsersView").then((module) => ({ default: module.SiteUsersView })));
const RegistrationSettingsView = lazy(() => import("../settings/registration/RegistrationSettingsView").then((module) => ({ default: module.RegistrationSettingsView })));
const FloorPlanSettingsView = lazy(() => import("../settings/floor-plans/FloorPlanSettingsView").then((module) => ({ default: module.FloorPlanSettingsView })));
const FloorEditorRoute = lazy(() => import("../settings/floor-plans/FloorEditorRoute").then((module) => ({ default: module.FloorEditorRoute })));
const AccountSecurityView = lazy(() => import("../settings/security/AccountSecurityView").then((module) => ({ default: module.AccountSecurityView })));
const SiteOperationsView = lazy(() => import("../settings/site/SiteOperationsView").then((module) => ({ default: module.SiteOperationsView })));

const items = [
  { path: "/monitoring", destination: "/monitoring", label: "모니터링", icon: Activity },
  { path: "/control", destination: "/control", label: "제어", icon: SlidersHorizontal },
  { path: "/statistics", destination: "/statistics/overview", label: "통계", icon: BarChart3 }
] as const;
const compactNavigationQuery = "(width < 760px)";
const wideNavigationQuery = "(min-width: 1024px)";

function PrimaryNavigation({ capabilities, search, layout = "mobile" }: { capabilities: SiteCapabilities; search: string; layout?: NavigationLayout }) {
  const location = useLocation();
  return (
    <>
      {items.filter((item) => item.path !== "/control" || capabilities.control).map((item) => {
        return (
          <PrimaryNavigationLink key={item.path} to={`${item.destination}${search}`} icon={item.icon} label={item.label} layout={layout}
            active={item.path === "/statistics" && location.pathname.startsWith("/statistics")} />
        );
      })}
      <SettingsNavigationItem capabilities={capabilities} search={search} layout={layout} />
    </>
  );
}

export function CustomerShell({ user }: { user: AuthUser }) {
  // Keep this unkeyed boundary stable: theme updates never rebuild the domain
  // shell or its route/query/command/editor ownership scopes.
  return <CustomerThemeProvider><CustomerShellContent user={user} /></CustomerThemeProvider>;
}

function CustomerShellContent({ user }: { user: AuthUser }) {
  const location = useLocation();
  const [isCompactNavigation, setIsCompactNavigation] = useState(() => window.matchMedia(compactNavigationQuery).matches);
  const [isWideNavigation, setIsWideNavigation] = useState(() => window.matchMedia(wideNavigationQuery).matches);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [manualWorkspaceActive, setManualWorkspaceActive] = useState(false);
  const isSidebarExpanded = isWideNavigation && !isSidebarCollapsed;
  const desktopNavigationId = useId();
  const isEditorRoute = Boolean(matchPath("/settings/floor-plans/:floorId/edit", location.pathname));
  const isMonitoringRoute = location.pathname === "/monitoring";
  const queryClient = useQueryClient();
  const isEditorDirty = useFloorEditorStore((store) => store.isDirty);
  const discardEditorChanges = useFloorEditorStore((store) => store.discardChanges);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [isLogoutConfirmationOpen, setIsLogoutConfirmationOpen] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const logoutButtonRef = useRef<RefObject<HTMLButtonElement | null>>({ current: null });
  const logoutInFlightRef = useRef(false);
  const statusCenterRef = useRef<SessionStatusCenterHandle>(null);
  const restoreLogoutFocusAfterFailureRef = useRef(false);
  const siteId = new URLSearchParams(location.search).get("siteId") ?? undefined;
  const sitesQuery = useSites();
  const {
    data: dashboard,
    isLoading: isDashboardLoading,
    error: dashboardError,
    refetch: refetchDashboard
  } = useDashboard(siteId);
  const selectedSiteId = siteId ?? dashboard?.site.id;
  const authorizedSelectedSiteId = sitesQuery.data?.some((site) => site.id === selectedSiteId)
    ? selectedSiteId
    : undefined;
  const currentSite = sitesQuery.data?.find(site => site.id === authorizedSelectedSiteId);
  const currentSiteLabel = currentSite ? currentSite.customerName ? `${currentSite.customerName} · ${currentSite.name}` : currentSite.name : "접근 가능한 현장 없음";
  const gatewayAggregate = deriveGatewayAggregate({ gateways: dashboard?.gateways, error: dashboardError });
  const gatewayContextItems = useMemo<readonly SessionStatusContextItem[]>(() => [{
    id: `gateway-summary:${selectedSiteId ?? "default"}`,
    title: "Gateway 연결",
    description: gatewayAggregate.label,
    tone: gatewayAggregate.tone
  }], [gatewayAggregate.label, gatewayAggregate.tone, selectedSiteId]);
  const shellStatusItems = useMemo<SessionStatusItem[]>(() => {
    const statuses: SessionStatusItem[] = [];
    if (sitesQuery.error) {
      statuses.push({
        id: "query:sites",
        fingerprint: "site-list-unavailable",
        source: "query",
        tone: "danger",
        title: "현장 목록을 확인하지 못했습니다.",
        description: "연결 상태를 확인한 뒤 다시 시도하세요.",
        action: { label: "다시 시도", onAction: () => void sitesQuery.refetch() }
      });
    }
    if (logoutError) {
      statuses.push({
        id: "command:logout",
        fingerprint: "logout-failed",
        source: "command",
        tone: "danger",
        title: logoutError,
        description: "로그아웃 버튼을 눌러 다시 시도할 수 있습니다."
      });
    }
    if (dashboard && dashboardError) {
      statuses.push({
        id: `query:dashboard:${selectedSiteId ?? "default"}`,
        fingerprint: "dashboard-refresh-delayed",
        source: "query",
        tone: "warning",
        title: "현장 상태 갱신이 지연되고 있습니다.",
        description: "마지막으로 확인한 값을 표시하고 있습니다.",
        action: { label: "다시 시도", onAction: () => void refetchDashboard() }
      });
    } else if (gatewayAggregate.kind === "attention") {
      statuses.push({
        id: `gateway:${selectedSiteId ?? "default"}`,
        fingerprint: `gateway-attention:${gatewayAggregate.online}/${gatewayAggregate.total}`,
        source: "gateway",
        tone: "warning",
        title: "확인이 필요한 게이트웨이가 있습니다.",
        description: gatewayAggregate.label,
        action: { label: "상태 새로고침", onAction: () => void refetchDashboard() }
      });
    }
    return statuses;
  }, [dashboard, dashboardError, gatewayAggregate.kind, gatewayAggregate.label, gatewayAggregate.online, gatewayAggregate.total, logoutError, refetchDashboard, selectedSiteId, sitesQuery.error, sitesQuery.refetch]);

  useEffect(() => {
    unblockActiveCommandSession(user.id);
  }, [user.id]);

  useEffect(() => {
    const media = window.matchMedia(compactNavigationQuery);
    const updateNavigation = (event: MediaQueryListEvent) => setIsCompactNavigation(event.matches);
    media.addEventListener("change", updateNavigation);
    return () => media.removeEventListener("change", updateNavigation);
  }, []);
  useEffect(() => {
    const media = window.matchMedia(wideNavigationQuery);
    const update = (event: MediaQueryListEvent) => setIsWideNavigation(event.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  useEffect(() => {
    if (isLoggingOut || !logoutError || !restoreLogoutFocusAfterFailureRef.current) return;
    restoreLogoutFocusAfterFailureRef.current = false;
    logoutButtonRef.current.current?.focus();
  }, [isLoggingOut, logoutError]);

  async function performLogout() {
    if (logoutInFlightRef.current) return;
    logoutInFlightRef.current = true;
    setLogoutError("");
    setIsLoggingOut(true);
    blockActiveCommandSession(user.id);
    try {
      await logout();
      clearActiveCommandsForUser(user.id);
      clearTenantCache(queryClient);
      queryClient.setQueryData(authMeQueryKey, null);
    } catch {
      unblockActiveCommandSession(user.id);
      logoutInFlightRef.current = false;
      setIsLoggingOut(false);
      setLogoutError("로그아웃에 실패했습니다. 연결을 확인한 뒤 다시 시도하세요.");
    }
  }

  function handleLogout(returnFocusRef: RefObject<HTMLButtonElement | null>) {
    if (logoutInFlightRef.current) return;
    logoutButtonRef.current = returnFocusRef;
    if (isEditorDirty || hasDirtyEditorSentinel()) {
      setIsLogoutConfirmationOpen(true);
      return;
    }
    restoreLogoutFocusAfterFailureRef.current = true;
    void performLogout();
  }

  const isAdmin = user.role === "admin";
  const installationStatus = dashboard?.site.installationStatus;
  const capabilities = dashboard?.capabilities;
  let gate = null;

  // Installation state remains the first admin gate because setup child routes
  // must not mount while its dashboard request is pending.
  if (isAdmin && !installationStatus) {
    if (isDashboardLoading) {
      gate = (
        <section className="grid min-h-screen place-items-center bg-surface-canvas p-6" aria-live="polite">
          <FeedbackState tone="info" icon={LoaderCircle} title="설치 상태를 확인하는 중입니다." />
        </section>
      );
    } else gate = (
      <section className="grid min-h-screen place-items-center bg-surface-canvas p-6" aria-live="polite">
        <FeedbackState tone="danger" icon={CircleAlert} title="설치 상태를 확인하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도하세요." action={
          <Button type="button" onClick={() => void refetchDashboard()}>다시 시도</Button>
        } />
      </section>
    );
  }

  // Fail closed until the server-provided site capability matrix is known.
  // This prevents a read-only user from briefly mounting protected route trees.
  if (!gate && !capabilities) {
    if (isDashboardLoading) {
      gate = (
        <section className="grid min-h-screen place-items-center bg-surface-canvas p-6" aria-live="polite">
          <FeedbackState tone="info" icon={LoaderCircle} title="현장 권한을 확인하는 중입니다." />
        </section>
      );
    } else gate = (
      <section className="grid min-h-screen place-items-center bg-surface-canvas p-6" aria-live="polite">
        <FeedbackState tone="danger" icon={CircleAlert} title="현장 권한을 확인하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도하세요." action={
          <Button type="button" onClick={() => void refetchDashboard()}>다시 시도</Button>
        } />
      </section>
    );
  }

  const mustCompleteInstallation = isAdmin
    && installationStatus === "pending"
    && location.pathname !== "/settings";
  if (!gate && mustCompleteInstallation) {
    const settingsSearch = selectedSiteId ? `?siteId=${encodeURIComponent(selectedSiteId)}` : location.search;
    gate = <Navigate to={`/settings${settingsSearch}`} replace />;
  }

  const isControlWorkspace = location.pathname === "/control" && Boolean(capabilities?.control) && !gate;
  // The page owns resolved mode/site authorization. This stable setter is only
  // a layout handoff: execution locks, queries and theme never define its scope.
  const isManualDesktopWorkspace = isControlWorkspace && manualWorkspaceActive && !isCompactNavigation;
  const summaryScope: CustomerShellScope | null = authorizedSelectedSiteId
    ? { principalKey: principalKey(user), siteId: authorizedSelectedSiteId, pathname: location.pathname } : null;
  const summaryValue: CustomerSiteSummary | null = summaryScope ? {
    scope: summaryScope,
    siteName: sitesQuery.data!.find(site => site.id === summaryScope.siteId)!.name,
    ...(dashboardError ? { state: "error" as const } : dashboard?.site.id !== summaryScope.siteId || isDashboardLoading ? { state: "loading" as const } : {
      state: "ready" as const,
      counts: { totalFixtures: dashboard.summary.totalFixtures ?? null, onlineFixtures: dashboard.summary.onlineFixtures ?? null,
        faultFixtures: dashboard.summary.faultFixtures ?? null, offlineFixtures: dashboard.summary.offlineFixtures ?? null }
    })
  } : null;

  return (
    <CustomerAccountContext.Provider value={{ user, isLoggingOut, logoutError: logoutError || null, requestLogout: handleLogout }}>
    <WorkspaceFocusProvider scope={JSON.stringify([principalKey(user), selectedSiteId, location.pathname])}>{focus =>
    <SessionStatusProvider scope={JSON.stringify([principalKey(user), authorizedSelectedSiteId])}>
      <ShellStatusRegistration items={shellStatusItems} />
      <div className={`bg-surface-canvas ${isMonitoringRoute ? "flex h-dvh min-h-0" : focus.active ? "flex h-dvh min-h-0 overflow-hidden" : isManualDesktopWorkspace ? "flex h-dvh min-h-0" : isEditorRoute ? "flex min-h-dvh" : "min-h-screen"} ${isCompactNavigation && !focus.active && !isMonitoringRoute ? "pb-shell-navigation-safe" : "flex"}`} data-app-shell data-workspace-full-view={focus.active}>
      {capabilities && !gate ? isCompactNavigation ? (
        <nav hidden={focus.active} className={focus.active ? "hidden" : "fixed inset-x-0 bottom-0 z-20 grid h-shell-navigation-safe grid-cols-4 gap-1 border-t border-border-default bg-surface-panel px-1.5 pt-1 pb-safe-area-bottom"} aria-label="모바일 주 메뉴" data-shell-navigation="compact">
          <PrimaryNavigation capabilities={capabilities} search={location.search} />
        </nav>
      ) : (
        <aside hidden={focus.active} className={focus.active ? "hidden" : `sticky top-0 z-20 ${isEditorRoute ? "h-full" : "h-screen"} ${isSidebarExpanded ? "w-customer-sidebar px-4.5" : "w-customer-rail px-2"} shrink-0 border-r border-border-default bg-surface-panel py-4`} data-shell-navigation="desktop">
          <div className={`mb-7 flex min-w-0 items-center gap-1 px-1 ${isSidebarExpanded ? "justify-between" : "flex-col justify-center"}`}>
            <KindaLogo presentation="workspace" context="관제 센터" compact={!isSidebarExpanded} />
            {isWideNavigation ? <IconTooltipButton size="sm" icon={isSidebarExpanded ? PanelLeftClose : PanelLeftOpen} label={isSidebarExpanded ? "사이드바 접기" : "사이드바 펼치기"} aria-expanded={isSidebarExpanded} aria-controls={desktopNavigationId} onClick={() => setIsSidebarCollapsed(value => !value)} /> : null}
          </div>
          <nav id={desktopNavigationId} className="grid w-full gap-2" aria-label="주 메뉴">
            <PrimaryNavigation capabilities={capabilities} search={location.search} layout={isSidebarExpanded ? "expanded" : "rail"} />
          </nav>
        </aside>
      ) : null}
      <main className={`flex min-w-0 flex-1 flex-col ${isMonitoringRoute ? "min-h-0" : focus.active ? "min-h-0 overflow-hidden" : isManualDesktopWorkspace ? "min-h-0" : isEditorRoute ? "min-h-min" : ""}`}>
        {/* Reserve intrinsic summary/action widths before giving the site label
            remaining space; otherwise a long label collapses the summary track. */}
        <header hidden={focus.active} className={focus.active ? "hidden" : "sticky top-0 z-10 grid min-h-16 min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1 gap-y-1 border-b border-border-default bg-surface-panel px-2 py-1 compact:grid-cols-[minmax(0,1fr)_auto_auto] compact:gap-x-4 compact:px-7 compact:py-2"} data-shell-topbar>
          <span className="sr-only" data-testid="shell-current-menu">{titleForPath(location.pathname)}</span>
          <div className="col-start-1 row-start-1 flex min-w-0 items-center gap-1" aria-label="현장 정보" data-shell-context>
            {isCompactNavigation ? <KindaLogo presentation="header" /> : null}
            <Text variant="body-sm" className="min-w-0 truncate" title={currentSiteLabel}>
              {sitesQuery.isLoading ? "현장 목록 확인 중" : sitesQuery.error ? "현장 목록 확인 불가" : currentSiteLabel}
            </Text>
            <span className="sr-only" data-testid="active-site-badge">{dashboard?.site.name || "현장 미등록"}</span>
          </div>
          <div className="col-start-2 row-start-1 flex min-w-0 items-center justify-end gap-2 compact:col-start-3" data-shell-actions>
            <SessionStatusCenter
              ref={statusCenterRef}
              compact={isCompactNavigation}
              key={JSON.stringify([user.id, authorizedSelectedSiteId])}
              userId={user.id}
              siteId={authorizedSelectedSiteId}
              timeZone={dashboard && dashboard.site.id === authorizedSelectedSiteId ? dashboard.site.timeZone : undefined}
              contextItems={gatewayContextItems}
            />
            <ThemeToggle />
            {!isCompactNavigation ? <Link to={`/settings/security${location.search}${location.hash}`} aria-label="내 계정 및 보안"
              className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-control text-content-secondary outline-none focus-visible:shadow-focus hover:bg-surface-inset"><UserRound size={20} aria-hidden="true" /></Link> : null}
          </div>
          {summaryScope ? <CustomerHeaderSummarySlot currentScope={summaryScope} value={summaryValue} compact={isCompactNavigation} className={isCompactNavigation ? "col-span-full" : "col-start-2 row-start-1"} /> : null}
        </header>
        {focus.active ? <div className="shrink-0 self-start px-2 pt-2"><Button type="button" variant="secondary" onClick={event => statusCenterRef.current?.open(event.currentTarget)}><Bell size={18} aria-hidden="true" />알람센터</Button></div> : null}
        <ToastRegion placement="flow" suppressVisual={isCompactNavigation} />
        {/* Monitoring needs a finite flex height to grow its map into available
            space. Its overflow stays visible so short screens can scroll the
            page rather than clip the minimum-height map or small log ticker.
            Other normal routes keep their existing document scroll policy. */}
        {/* Short monitoring fullview preserves the map's natural minimum and
            scrolls normally when live notice height exceeds the viewport. */}
        {/* Editor minima may exceed a short viewport. Keep ordinary document
            scrolling through both grids instead of clipping the workspace. */}
        {/* Only an authorized Control workspace needs the available grid row,
            not an intrinsic content-start row. Its min-content floor keeps a
            short viewport in document flow; account/gate and other routes keep
            their existing composition and scrolling policy. */}
        {/* Manual desktop consumes remaining space below the dynamic header
            and flow notices. Overflow remains reachable inside this workspace,
            rather than clipping a short-screen map or command recovery action. */}
        <div data-shell-content className={`m-0! min-w-0 flex-1 ${focus.active ? `min-h-0 ${isMonitoringRoute ? "" : "overflow-hidden"} p-2 compact:p-3` : isManualDesktopWorkspace ? "grid min-h-0 grid-rows-[minmax(0,1fr)] overflow-auto gap-5 px-7 py-6" : isEditorRoute ? "grid min-h-min grid-rows-[auto_minmax(min-content,1fr)] gap-2 p-2 compact:p-3 [&>section:last-child]:h-full [&>section:last-child]:min-h-min [&>section:last-child]:grid-rows-[auto_minmax(min-content,1fr)] [&>section:last-child]:gap-2 [&>section:last-child>div]:min-h-min" : isMonitoringRoute ? "flex min-h-0 flex-col px-7 py-6 max-compact:px-3.5 max-compact:py-4.5" : isControlWorkspace ? "grid grid-rows-[minmax(min-content,1fr)] gap-5 px-7 py-6 max-compact:px-3.5 max-compact:py-4.5" : "grid content-start gap-5 px-7 py-6 max-compact:px-3.5 max-compact:py-4.5"}`}>
          {/* The eager account region stays outside the lazy route boundary so
              failed settings chunks and installation/permission gates retain
              the same logout controller, confirmation and initiating ref. */}
          {location.pathname.startsWith("/settings") || gate ? <CustomerAccountPanel /> : null}
          {gate ?? (capabilities ? <CustomerRouteErrorBoundary scope={JSON.stringify([principalKey(user), selectedSiteId, location.pathname])}>
          <Suspense fallback={<RouteLoadingState />}>
            <Routes>
            <Route path="/monitoring" element={<MonitoringView userRole={user.role} siteId={siteId} />} />
            <Route
              path="/control"
              element={capabilities.control ? (
                <ControlView
                  siteId={siteId}
                  userId={user.id}
                  userRole={user.role}
                  commandSessionBlocked={isLoggingOut}
                  singleColumnLayout={isCompactNavigation}
                  onManualWorkspaceActiveChange={setManualWorkspaceActive}
                />
              ) : <Navigate to={`/monitoring${location.search}`} replace />}
            />
            <Route path="/statistics" element={<StatisticsShell siteId={siteId ?? dashboard?.site.id} />}>
              <Route index element={<StatisticsIndexRedirect />} />
              <Route path="overview" element={<StatisticsOverviewPage />} />
              <Route path="analysis" element={<StatisticsAnalysisPage />} />
              <Route path="reports" element={<StatisticsReportsPage />} />
              <Route path="*" element={<StatisticsIndexRedirect />} />
            </Route>
            <Route path="/settings" element={<SettingsShell capabilities={capabilities} />}>
              <Route index element={<SettingsView userRole={user.role} siteId={siteId} capabilities={capabilities} />} />
              <Route
                path="site"
                element={capabilities.manage
                  ? <SiteOperationsView siteId={selectedSiteId} ownerUserId={user.id} canPrepare={capabilities.commission} />
                  : <Navigate to={`/settings${location.search}`} replace />}
              />
              <Route
                path="users"
                element={capabilities.manage
                  ? <SiteUsersView siteId={selectedSiteId} />
                  : <Navigate to={`/settings${location.search}`} replace />}
              />
              <Route
                path="registration"
                element={capabilities.manage ? <RegistrationSettingsView siteId={siteId} /> : <Navigate to={`/settings${location.search}`} replace />}
              />
              <Route path="floor-plans" element={<FloorPlanSettingsView siteId={siteId} capabilities={capabilities} />} />
              <Route
                path="floor-plans/:floorId/edit"
                element={capabilities.manage
                  ? <FloorEditorRoute capabilities={capabilities} />
                  : <Navigate to={`/settings/floor-plans${location.search}`} replace />}
              />
              <Route
                path="security"
                element={<AccountSecurityView user={user} />}
              />
              <Route path="*" element={<Navigate to={`/settings${location.search}`} replace />} />
            </Route>
            <Route path="*" element={<Navigate to={`/monitoring${location.search}`} replace />} />
            </Routes>
          </Suspense>
          </CustomerRouteErrorBoundary> : null)}
        </div>
      </main>
      <ConfirmDialog
        isOpen={isLogoutConfirmationOpen}
        role="alertdialog"
        title="로그아웃 확인"
        confirmLabel="로그아웃"
        tone="danger"
        returnFocusRef={logoutButtonRef.current}
        onCancel={() => setIsLogoutConfirmationOpen(false)}
        onConfirm={() => {
          setIsLogoutConfirmationOpen(false);
          discardEditorChanges();
          restoreLogoutFocusAfterFailureRef.current = true;
          void performLogout();
        }}
      >
        저장하지 않은 변경사항이 있습니다. 로그아웃하시겠습니까?
      </ConfirmDialog>
      </div>
    </SessionStatusProvider>
    }</WorkspaceFocusProvider>
    </CustomerAccountContext.Provider>
  );
}

function ShellStatusRegistration({ items }: { items: readonly SessionStatusItem[] }) {
  useSessionStatus("customer-shell", items);
  return null;
}

function titleForPath(pathname: string) {
  if (pathname.startsWith("/control")) return "제어";
  if (pathname.startsWith("/statistics")) return "통계";
  if (pathname.startsWith("/settings")) return "설정";
  return "모니터링";
}
