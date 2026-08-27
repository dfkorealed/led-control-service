import { useEffect, useState } from "react";
import { Activity, BarChart3, MapPin, Settings, SlidersHorizontal } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { Navigate, NavLink, Route, Routes, useLocation } from "react-router-dom";
import { logout, type AuthUser } from "../../api/auth";
import { useDashboard } from "../../api/queries";
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
import { PasswordSettingsView } from "../settings/security/PasswordSettingsView";
import { StatisticsView } from "../statistics/StatisticsView";

const items = [
  { path: "/monitoring", label: "모니터링", icon: Activity },
  { path: "/control", label: "제어", icon: SlidersHorizontal },
  { path: "/statistics", label: "통계", icon: BarChart3 },
  { path: "/settings", label: "설정", icon: Settings }
] as const;

export function CustomerShell({ user }: { user: AuthUser }) {
  const location = useLocation();
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
  const gateway = dashboard?.gateways[0];
  const gatewayStatusLabel = gateway ? (gateway.connectionStatus === "online" ? "게이트웨이 정상" : "게이트웨이 오프라인") : "게이트웨이 미등록";
  const gatewayStatusClass = gateway?.connectionStatus === "online" ? "online" : "offline";

  useEffect(() => {
    unblockActiveCommandSession(user.id);
  }, [user.id]);

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
      queryClient.setQueryData(["auth", "me"], null);
      queryClient.removeQueries({
        predicate: (query) => Array.isArray(query.queryKey) && query.queryKey[0] !== "auth"
      });
    } catch {
      unblockActiveCommandSession(user.id);
      setIsLoggingOut(false);
      setLogoutError("로그아웃에 실패했습니다. 연결을 확인한 뒤 다시 시도하세요.");
    }
  }

  const isAdmin = user.role === "admin";
  const installationStatus = dashboard?.site.installationStatus;

  // An admin's customer routes depend on the assigned site's installation state.
  // Keep the shell closed until that state is known so child route queries cannot run early.
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

  const mustCompleteInstallation = isAdmin
    && installationStatus === "pending"
    && location.pathname !== "/settings";
  if (mustCompleteInstallation) {
    const settingsSearch = selectedSiteId ? `?siteId=${encodeURIComponent(selectedSiteId)}` : location.search;
    return <Navigate to={`/settings${settingsSearch}`} replace />;
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">LC</span>
          <div>
            <strong>LED Control</strong>
            <span>관제 센터</span>
          </div>
        </div>
        <nav className="nav-list" aria-label="주 메뉴">
          {items.map((item) => {
            const Icon = item.icon;
            return (
              <NavLink
                className={({ isActive }) => isActive ? "nav-item active" : "nav-item"}
                key={item.path}
                to={`${item.path}${location.search}`}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </NavLink>
            );
          })}
        </nav>
      </aside>
      <main className="content">
        <header className="topbar">
          <div>
            <span className="eyebrow">{dashboard?.site.name || "현장 미등록"}</span>
            <h1>{titleForPath(location.pathname)}</h1>
          </div>
          <div className="topbar-actions" aria-label="현장 상태">
            <span className="site-pill">
              <MapPin size={16} />
              {dashboard?.floors[0]?.name ?? "층 미등록"} 주차장
            </span>
            <span className={`status-pill ${gatewayStatusClass}`}>
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
            element={(
              <ControlView
                siteId={siteId}
                userId={user.id}
                userRole={user.role}
                commandSessionBlocked={isLoggingOut}
              />
            )}
          />
          <Route path="/statistics" element={<StatisticsView siteId={siteId ?? dashboard?.site.id} />} />
          <Route path="/settings" element={<SettingsShell userRole={user.role} selectedSiteId={siteId ?? dashboard?.site.id} />}>
            <Route index element={<SettingsView userRole={user.role} siteId={siteId} />} />
            <Route path="floor-plans" element={<FloorPlanSettingsView siteId={siteId} userRole={user.role} />} />
            <Route path="floor-plans/:floorId/edit" element={<FloorEditorRoute userRole={user.role} />} />
            <Route
              path="security"
              element={isAdmin ? <PasswordSettingsView /> : <Navigate to={`/settings${location.search}`} replace />}
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
