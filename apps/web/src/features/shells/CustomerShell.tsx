import { useEffect, useState } from "react";
import { Activity, BarChart3, CircleAlert, CircleCheck, MapPin, SlidersHorizontal } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate, NavLink, Route, Routes, matchPath, useLocation } from "react-router-dom";
import { logout, type AuthUser } from "../../api/auth";
import { authMeQueryKey, clearTenantCache } from "../../api/principal-cache";
import { useDashboard, type SiteCapabilities } from "../../api/queries";
import { ControlView } from "../control/ControlView";
import {
  blockActiveCommandSession,
  unblockActiveCommandSession
} from "../control/active-command-session";
import { clearActiveCommandsForUser } from "../control/active-command-store";
import { hasDirtyEditorSentinel } from "../floor-editor/dirty-editor-history";
import { useFloorEditorStore } from "../floor-editor/editor-store";
import { MonitoringView } from "../monitoring/MonitoringView";
import { SettingsShell } from "../settings/SettingsShell";
import { FloorEditorRoute } from "../settings/floor-plans/FloorEditorRoute";
import { FloorPlanSettingsView } from "../settings/floor-plans/FloorPlanSettingsView";
import { SettingsView } from "../settings/SettingsView";
import { RegistrationSettingsView } from "../settings/registration/RegistrationSettingsView";
import { PasswordSettingsView } from "../settings/security/PasswordSettingsView";
import { SiteUsersView } from "../settings/users/SiteUsersView";
import { StatisticsOverviewPage } from "../statistics/StatisticsOverviewPage";
import { StatisticsAnalysisPage } from "../statistics/analysis/StatisticsAnalysisPage";
import { StatisticsIndexRedirect, StatisticsShell } from "../statistics/StatisticsShell";
import { SettingsNavigationItem } from "./SettingsNavigationItem";

const items = [
  { path: "/monitoring", destination: "/monitoring", label: "모니터링", icon: Activity },
  { path: "/control", destination: "/control", label: "제어", icon: SlidersHorizontal },
  { path: "/statistics", destination: "/statistics/overview", label: "통계", icon: BarChart3 }
] as const;

function PrimaryNavigation({ capabilities, search }: { capabilities: SiteCapabilities; search: string }) {
  const location = useLocation();
  return (
    <>
      {items.filter((item) => item.path !== "/control" || capabilities.control).map((item) => {
        const Icon = item.icon;
        return (
          <NavLink
            aria-current={item.path === "/statistics" && location.pathname.startsWith("/statistics") ? "page" : undefined}
            className={({ isActive }) => isActive || (item.path === "/statistics" && location.pathname.startsWith("/statistics"))
              ? "nav-item active"
              : "nav-item"}
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
  const [isCompactNavigation, setIsCompactNavigation] = useState(() => window.matchMedia("(max-width: 760px)").matches);
  const queryClient = useQueryClient();
  const isEditorDirty = useFloorEditorStore((store) => store.isDirty);
  const discardEditorChanges = useFloorEditorStore((store) => store.discardChanges);
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState("");
  const siteId = new URLSearchParams(location.search).get("siteId") ?? undefined;
  const {
    data: dashboard,
    isLoading: isDashboardLoading,
    refetch: refetchDashboard
  } = useDashboard(siteId);
  const selectedSiteId = siteId ?? dashboard?.site.id;
  const editorRoute = matchPath("/settings/floor-plans/:floorId/edit", location.pathname);
  const displayedFloor = editorRoute
    ? dashboard?.floors.find((floor) => floor.id === editorRoute.params.floorId)
    : dashboard?.floors[0];
  const gateway = dashboard?.gateways[0];
  const gatewayStatusLabel = gateway ? (gateway.connectionStatus === "online" ? "게이트웨이 정상" : "게이트웨이 오프라인") : "게이트웨이 미등록";
  const gatewayStatusClass = gateway?.connectionStatus === "online" ? "online" : "offline";
  const gatewayStatusTone = gateway?.connectionStatus === "online" ? "success" : gateway ? "danger" : "neutral";
  const GatewayStatusIcon = gateway?.connectionStatus === "online" ? CircleCheck : CircleAlert;

  useEffect(() => {
    unblockActiveCommandSession(user.id);
  }, [user.id]);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const updateNavigation = (event: MediaQueryListEvent) => setIsCompactNavigation(event.matches);
    media.addEventListener("change", updateNavigation);
    return () => media.removeEventListener("change", updateNavigation);
  }, []);

  async function handleLogout() {
    if (isLoggingOut) return;
    if (isEditorDirty || hasDirtyEditorSentinel()) {
      const confirmed = window.confirm("저장하지 않은 변경사항이 있습니다. 로그아웃하시겠습니까?");
      if (!confirmed) return;
      discardEditorChanges();
    }
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

  const isAdmin = user.role === "admin";
  const installationStatus = dashboard?.site.installationStatus;
  const capabilities = dashboard?.capabilities;

  // Installation state remains the first admin gate because setup child routes
  // must not mount while its dashboard request is pending.
  if (isAdmin && !installationStatus) {
    if (isDashboardLoading) {
      return (
        <section className="settings-screen" aria-live="polite">
          <p>설치 상태를 확인하는 중입니다.</p>
        </section>
      );
    }

    return (
      <section className="settings-screen" aria-live="polite">
        <p role="alert">설치 상태를 확인하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도하세요.</p>
        <button type="button" className="secondary-button" onClick={() => void refetchDashboard()}>
          다시 시도
        </button>
      </section>
    );
  }

  // Fail closed until the server-provided site capability matrix is known.
  // This prevents a read-only user from briefly mounting protected route trees.
  if (!capabilities) {
    if (isDashboardLoading) {
      return (
        <section className="settings-screen" aria-live="polite">
          <p>현장 권한을 확인하는 중입니다.</p>
        </section>
      );
    }

    return (
      <section className="settings-screen" aria-live="polite">
        <p role="alert">현장 권한을 확인하지 못했습니다. 네트워크 상태를 확인한 뒤 다시 시도하세요.</p>
        <button type="button" className="secondary-button" onClick={() => void refetchDashboard()}>
          다시 시도
        </button>
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
    <div className="app-shell">
      {isCompactNavigation ? (
        <nav className="bottom-nav nav-list" aria-label="모바일 주 메뉴">
          <PrimaryNavigation capabilities={capabilities} search={location.search} />
        </nav>
      ) : (
        <aside className="sidebar">
          <div className="brand">
            <span className="brand-mark">LC</span>
            <div>
              <strong>LED Control</strong>
              <span>관제 센터</span>
            </div>
          </div>
          <nav className="nav-list" aria-label="주 메뉴">
            <PrimaryNavigation capabilities={capabilities} search={location.search} />
          </nav>
        </aside>
      )}
      <main className="content">
        <header className="topbar">
          <div>
            <span className="eyebrow">{dashboard?.site.name || "현장 미등록"}</span>
            <h1>{titleForPath(location.pathname)}</h1>
          </div>
          <div className="topbar-actions" aria-label="현장 상태">
            {(!editorRoute || displayedFloor) && <span className="site-pill" data-testid="active-floor-badge">
              <MapPin size={16} />
              {displayedFloor?.name ?? "층 미등록"} 주차장
            </span>}
            <span className={`status-pill ${gatewayStatusClass}`} data-tone={gatewayStatusTone}>
              <GatewayStatusIcon size={16} aria-hidden="true" />
              {gatewayStatusLabel}
            </span>
            <button className="logout-button" onClick={handleLogout} disabled={isLoggingOut}>
              {isLoggingOut ? "로그아웃 중" : "로그아웃"}
            </button>
            {logoutError ? <span className="danger-text" role="alert">{logoutError}</span> : null}
          </div>
        </header>
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
            <Route path="*" element={<StatisticsIndexRedirect />} />
          </Route>
          <Route path="/settings" element={<SettingsShell selectedSiteId={siteId ?? dashboard?.site.id} />}>
            <Route index element={<SettingsView userRole={user.role} siteId={siteId} />} />
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
              element={<PasswordSettingsView />}
            />
            <Route path="*" element={<Navigate to={`/settings${location.search}`} replace />} />
          </Route>
          <Route path="*" element={<Navigate to={`/monitoring${location.search}`} replace />} />
        </Routes>
      </main>
    </div>
  );
}

function titleForPath(pathname: string) {
  if (pathname.startsWith("/control")) return "제어";
  if (pathname.startsWith("/statistics")) return "통계";
  if (pathname.startsWith("/settings")) return "설정";
  return "모니터링";
}
