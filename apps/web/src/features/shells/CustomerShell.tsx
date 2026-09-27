import { forwardRef, lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { Activity, BarChart3, CircleAlert, LoaderCircle, LogOut, SlidersHorizontal } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { matchPath, Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { logout, type AuthUser } from "../../api/auth";
import { authMeQueryKey, clearTenantCache } from "../../api/principal-cache";
import { useDashboard, useSites, type SiteCapabilities } from "../../api/queries";
import { KindaLogo } from "../../components/brand/KindaLogo";
import {
  Button,
  ConfirmDialog,
  FeedbackState,
  Heading,
  IconTooltipButton,
  SessionStatusCenter,
  SessionStatusProvider,
  Text,
  ToastRegion,
  useSessionStatus,
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
import { SiteSwitcher } from "../sites/SiteSwitcher";
import { useGuardedSiteSelection } from "../sites/useGuardedSiteSelection";
import { deriveGatewayAggregate } from "./gateway-status";
import { primaryNavigationClass, SettingsNavigationItem } from "./SettingsNavigationItem";

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
const compactNavigationQuery = "(max-width: 759px)";

function PrimaryNavigation({ capabilities, search }: { capabilities: SiteCapabilities; search: string }) {
  const location = useLocation();
  return (
    <>
      {items.filter((item) => item.path !== "/control" || capabilities.control).map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            aria-current={item.path === "/statistics" && location.pathname.startsWith("/statistics") ? "page" : undefined}
            className={({ isActive }) => primaryNavigationClass(isActive || (item.path === "/statistics" && location.pathname.startsWith("/statistics")))}
            data-shell-navigation-item
            key={item.path}
            to={`${item.destination}${search}`}
          >
            <Icon size={18} />
            <span>{item.label}</span>
          </NavLink>
        );
      })}
      <SettingsNavigationItem capabilities={capabilities} search={search} />
    </>
  );
}

export function CustomerShell({ user }: { user: AuthUser }) {
  const location = useLocation();
  const [isCompactNavigation, setIsCompactNavigation] = useState(() => window.matchMedia(compactNavigationQuery).matches);
  const isEditorRoute = Boolean(matchPath("/settings/floor-plans/:floorId/edit", location.pathname));
  const queryClient = useQueryClient();
  const isEditorDirty = useFloorEditorStore((store) => store.isDirty);
  const discardEditorChanges = useFloorEditorStore((store) => store.discardChanges);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [isLogoutConfirmationOpen, setIsLogoutConfirmationOpen] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const logoutButtonRef = useRef<HTMLButtonElement>(null);
  const siteSwitcherRef = useRef<HTMLButtonElement>(null);
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
  const siteSelection = useGuardedSiteSelection(authorizedSelectedSiteId);
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
    if (isLoggingOut || !logoutError || !restoreLogoutFocusAfterFailureRef.current) return;
    restoreLogoutFocusAfterFailureRef.current = false;
    logoutButtonRef.current?.focus();
  }, [isLoggingOut, logoutError]);

  async function performLogout() {
    if (isLoggingOut) return;
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
      setIsLoggingOut(false);
      setLogoutError("로그아웃에 실패했습니다. 연결을 확인한 뒤 다시 시도하세요.");
    }
  }

  function handleLogout() {
    if (isLoggingOut) return;
    if (isEditorDirty || hasDirtyEditorSentinel()) {
      setIsLogoutConfirmationOpen(true);
      return;
    }
    restoreLogoutFocusAfterFailureRef.current = false;
    void performLogout();
  }

  const isAdmin = user.role === "admin";
  const installationStatus = dashboard?.site.installationStatus;
  const capabilities = dashboard?.capabilities;

  // Installation state remains the first admin gate because setup child routes
  // must not mount while its dashboard request is pending.
  if (isAdmin && !installationStatus) {
    if (isDashboardLoading) {
      return (
        <section className="grid min-h-screen place-items-center bg-surface-canvas p-6" aria-live="polite">
          <FeedbackState tone="info" icon={LoaderCircle} title="설치 상태를 확인하는 중입니다." />
        </section>
      );
    }

    return (
      <section className="grid min-h-screen place-items-center bg-surface-canvas p-6" aria-live="polite">
        <FeedbackState tone="danger" icon={CircleAlert} title="설치 상태를 확인하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도하세요." action={
          <Button type="button" onClick={() => void refetchDashboard()}>다시 시도</Button>
        } />
      </section>
    );
  }

  // Fail closed until the server-provided site capability matrix is known.
  // This prevents a read-only user from briefly mounting protected route trees.
  if (!capabilities) {
    if (isDashboardLoading) {
      return (
        <section className="grid min-h-screen place-items-center bg-surface-canvas p-6" aria-live="polite">
          <FeedbackState tone="info" icon={LoaderCircle} title="현장 권한을 확인하는 중입니다." />
        </section>
      );
    }

    return (
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
  if (mustCompleteInstallation) {
    const settingsSearch = selectedSiteId ? `?siteId=${encodeURIComponent(selectedSiteId)}` : location.search;
    return <Navigate to={`/settings${settingsSearch}`} replace />;
  }

  return (
    <SessionStatusProvider>
      <ShellStatusRegistration items={shellStatusItems} />
      <div className={`bg-surface-canvas ${isEditorRoute ? "flex h-dvh min-h-0 overflow-hidden" : "min-h-screen"} ${isCompactNavigation ? "pb-shell-navigation-safe" : "flex"}`} data-app-shell>
      {isCompactNavigation ? (
        <nav className="fixed inset-x-0 bottom-0 z-20 grid h-shell-navigation-safe grid-cols-4 gap-1 border-t border-border-default bg-surface-panel px-1.5 pt-1 pb-safe-area-bottom" aria-label="모바일 주 메뉴" data-shell-navigation="compact">
          <PrimaryNavigation capabilities={capabilities} search={location.search} />
        </nav>
      ) : (
        <aside className={`sticky top-0 z-20 ${isEditorRoute ? "h-full" : "h-screen"} w-shell-rail shrink-0 border-r border-border-default bg-surface-panel px-2 py-4`} data-shell-navigation="desktop">
          <KindaLogo context="관제 센터" compact />
          <nav className="grid w-full gap-2" aria-label="주 메뉴">
            <PrimaryNavigation capabilities={capabilities} search={location.search} />
          </nav>
        </aside>
      )}
      <main className={`flex min-w-0 flex-1 flex-col ${isEditorRoute ? "min-h-0 overflow-hidden" : ""}`}>
        <header className="sticky top-0 z-10 grid min-h-16 min-w-0 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-2 border-b border-border-default bg-surface-panel px-3.5 py-2 compact:grid-cols-[minmax(0,1fr)_minmax(0,auto)_auto] compact:gap-x-4 compact:px-7" data-shell-topbar>
          <div className="col-start-1 row-start-1 min-w-0">
            <Heading as="h1" variant="page-title" className="truncate" data-testid="shell-current-menu">{titleForPath(location.pathname)}</Heading>
          </div>
          <div className="col-span-2 row-start-2 flex min-w-0 items-center gap-2 compact:col-span-1 compact:col-start-2 compact:row-start-1" aria-label="현장 정보" data-shell-context>
            <SiteContextControl
              ref={siteSwitcherRef}
              sites={sitesQuery.data}
              selectedSiteId={authorizedSelectedSiteId}
              isLoading={sitesQuery.isLoading}
              hasError={Boolean(sitesQuery.error)}
              onSelectionChange={siteSelection.requestSiteChange}
            />
            <span className="sr-only" data-testid="active-site-badge">{dashboard?.site.name || "현장 미등록"}</span>
          </div>
          <div className="col-start-2 row-start-1 flex min-w-0 items-center justify-end gap-2 compact:col-start-3" data-shell-actions>
            <SessionStatusCenter contextItems={gatewayContextItems} />
            <IconTooltipButton
              ref={logoutButtonRef}
              className="size-13"
              icon={LogOut}
              label="로그아웃"
              loadingLabel="로그아웃 중"
              isLoading={isLoggingOut}
              onClick={handleLogout}
            />
          </div>
        </header>
        {/* Only the editor bounds SettingsShell's navigation and outlet rows.
            Keeping this scoped avoids changing normal settings scroll. */}
        <div data-shell-content className={`m-0! min-w-0 flex-1 ${isEditorRoute ? "min-h-0 overflow-hidden p-2 compact:p-3 [&>section]:h-full [&>section]:min-h-0 [&>section]:grid-rows-[auto_minmax(0,1fr)] [&>section]:gap-2 [&>section>div]:min-h-0" : "p-6 max-compact:p-3.5"}`}>
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
              <Route index element={<SettingsView userRole={user.role} siteId={siteId} />} />
              <Route
                path="site"
                element={capabilities.manage
                  ? <SiteOperationsView siteId={selectedSiteId} />
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
        </div>
      </main>
      <ConfirmDialog
        isOpen={siteSelection.pendingSiteId !== null}
        title="현장 변경"
        confirmLabel="변경"
        returnFocusRef={siteSwitcherRef}
        onCancel={siteSelection.cancelSiteChange}
        onConfirm={siteSelection.confirmSiteChange}
      >
        저장하지 않은 변경사항을 버리고 다른 현장으로 이동하시겠습니까?
      </ConfirmDialog>
      <ConfirmDialog
        isOpen={isLogoutConfirmationOpen}
        role="alertdialog"
        title="로그아웃 확인"
        confirmLabel="로그아웃"
        tone="danger"
        returnFocusRef={logoutButtonRef}
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
      <ToastRegion />
      </div>
    </SessionStatusProvider>
  );
}

function ShellStatusRegistration({ items }: { items: readonly SessionStatusItem[] }) {
  useSessionStatus("customer-shell", items);
  return null;
}

interface SiteContextControlProps {
  sites: ReturnType<typeof useSites>["data"];
  selectedSiteId?: string;
  isLoading: boolean;
  hasError: boolean;
  onSelectionChange(siteId: string): void;
}

const SiteContextControl = forwardRef<HTMLButtonElement, SiteContextControlProps>(function SiteContextControl(
  { sites, selectedSiteId, isLoading, hasError, onSelectionChange },
  ref
) {
  if (isLoading) {
    return <Button ref={ref} type="button" className="min-w-0 flex-1 overflow-hidden compact:w-64 compact:flex-none" isDisabled>현장 목록 확인 중</Button>;
  }
  if (hasError) {
    return <Button ref={ref} type="button" className="min-w-0 flex-1 overflow-hidden compact:w-64 compact:flex-none" isDisabled>현장 목록 확인 불가</Button>;
  }
  if (!sites?.length) {
    return <Button ref={ref} type="button" className="min-w-0 flex-1 overflow-hidden compact:w-64 compact:flex-none" isDisabled>접근 가능한 현장 없음</Button>;
  }
  return (
    <SiteSwitcher
      ref={ref}
      sites={sites}
      selectedSiteId={selectedSiteId}
      onSelectionChange={onSelectionChange}
      className="min-w-0 flex-1 compact:w-64 compact:flex-none"
    />
  );
});

function titleForPath(pathname: string) {
  if (pathname.startsWith("/control")) return "제어";
  if (pathname.startsWith("/statistics")) return "통계";
  if (pathname.startsWith("/settings")) return "설정";
  return "모니터링";
}
