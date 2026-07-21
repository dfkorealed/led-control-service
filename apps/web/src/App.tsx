import { Activity, BarChart3, MapPin, Settings, SlidersHorizontal } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { BrowserRouter, Navigate, NavLink, Route, Routes, useLocation, useParams } from "react-router-dom";
import { useCurrentUser, logout, type AuthUser } from "./api/auth";
import { useDashboard } from "./api/queries";
import { AuthView } from "./features/auth/AuthView";
import { ControlView } from "./features/control/ControlView";
import { MonitoringView } from "./features/monitoring/MonitoringView";
import { SettingsShell } from "./features/settings/SettingsShell";
import { SettingsView } from "./features/settings/SettingsView";
import { StatisticsView } from "./features/statistics/StatisticsView";
import "./styles.css";

const items = [
  { path: "/monitoring", label: "모니터링", icon: Activity },
  { path: "/control", label: "제어", icon: SlidersHorizontal },
  { path: "/statistics", label: "통계", icon: BarChart3 },
  { path: "/settings", label: "설정", icon: Settings }
] as const;

export function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}

function AppContent() {
  const queryClient = useQueryClient();
  const { data: auth, isLoading: isAuthLoading, error: authError } = useCurrentUser();

  if (isAuthLoading) {
    return <main className="auth-shell"><section className="auth-panel">인증 상태를 확인하는 중</section></main>;
  }

  if (authError || !auth?.user) {
    return <AuthView onAuthenticated={() => queryClient.invalidateQueries({ queryKey: ["auth", "me"] })} />;
  }

  return <AuthenticatedShell user={auth.user} />;
}

function AuthenticatedShell({ user }: { user: AuthUser }) {
  const location = useLocation();
  const queryClient = useQueryClient();
  const siteId = new URLSearchParams(location.search).get("siteId") ?? undefined;
  const { data: dashboard } = useDashboard(siteId);
  const gateway = dashboard?.gateways[0];
  const gatewayStatusLabel = gateway ? (gateway.connectionStatus === "online" ? "게이트웨이 정상" : "게이트웨이 오프라인") : "게이트웨이 미등록";
  const gatewayStatusClass = gateway?.connectionStatus === "online" ? "online" : "offline";

  async function handleLogout() {
    await logout();
    queryClient.clear();
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
            <button className="logout-button" onClick={handleLogout}>
              로그아웃
            </button>
          </div>
        </header>
        <Routes>
          <Route path="/monitoring" element={<MonitoringView userRole={user.role} siteId={siteId} />} />
          <Route path="/control" element={<ControlView siteId={siteId} />} />
          <Route path="/statistics" element={<StatisticsView />} />
          <Route path="/settings" element={<SettingsShell userRole={user.role} selectedSiteId={siteId ?? dashboard?.site.id} />}>
            <Route index element={<SettingsView userRole={user.role} siteId={siteId} />} />
            <Route path="floor-plans" element={<FloorPlanSettingsView siteId={siteId} />} />
            <Route path="floor-plans/:floorId/edit" element={<FloorEditorRoute />} />
            <Route path="*" element={<Navigate to={`/settings${location.search}`} replace />} />
          </Route>
          <Route path="*" element={<Navigate to={`/monitoring${location.search}`} replace />} />
        </Routes>
      </main>
    </div>
  );
}

function FloorPlanSettingsView({ siteId }: { siteId?: string }) {
  const { data, isLoading, error } = useDashboard(siteId);

  return (
    <section className="settings-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">도면</span>
          <h2>도면 관리</h2>
        </div>
      </div>
      {isLoading && <div className="panel">도면 목록을 불러오는 중</div>}
      {error && <div className="panel danger">도면 목록을 불러오지 못했습니다.</div>}
      {data && (
        <div className="settings-grid">
          {data.floors.map((floor) => (
            <div className="setting-card" key={floor.id}>
              <span>{floor.name}</span>
              <strong>{floor.floorPlan ? "도면 등록됨" : "도면 미등록"}</strong>
              <small>편집 기능은 다음 작업에서 연결됩니다.</small>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function FloorEditorRoute() {
  const { floorId } = useParams();

  return (
    <section className="settings-screen">
      <div className="screen-heading">
        <div>
          <span className="eyebrow">도면</span>
          <h2>도면 편집</h2>
        </div>
      </div>
      <div className="panel">{floorId} 도면 편집 화면을 준비 중입니다.</div>
    </section>
  );
}

function titleForPath(pathname: string) {
  if (pathname.startsWith("/control")) return "제어";
  if (pathname.startsWith("/statistics")) return "통계";
  if (pathname.startsWith("/settings")) return "설정";
  return "모니터링";
}
