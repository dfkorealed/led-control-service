import { Activity, BarChart3, MapPin, Settings, SlidersHorizontal } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import { useCurrentUser, logout, type AuthUser } from "./api/auth";
import { useDashboard } from "./api/queries";
import { AuthView } from "./features/auth/AuthView";
import { ControlView } from "./features/control/ControlView";
import { MonitoringView } from "./features/monitoring/MonitoringView";
import { SettingsView } from "./features/settings/SettingsView";
import { StatisticsView } from "./features/statistics/StatisticsView";
import { useNavigationStore } from "./state/navigation-store";
import "./styles.css";

const items = [
  { key: "monitoring", label: "모니터링", icon: Activity },
  { key: "control", label: "제어", icon: SlidersHorizontal },
  { key: "statistics", label: "통계", icon: BarChart3 },
  { key: "settings", label: "설정", icon: Settings }
] as const;

export function App() {
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
  const { view, setView } = useNavigationStore();
  const queryClient = useQueryClient();
  const { data: dashboard } = useDashboard();
  const active = items.find((item) => item.key === view) ?? items[0];
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
              <button
                key={item.key}
                className={view === item.key ? "nav-item active" : "nav-item"}
                onClick={() => setView(item.key)}
              >
                <Icon size={18} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>
      <main className="content">
        <header className="topbar">
          <div>
            <span className="eyebrow">{dashboard?.site.name || "현장 미등록"}</span>
            <h1>{active.label}</h1>
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
        {view === "monitoring" && <MonitoringView userRole={user.role} />}
        {view === "control" && <ControlView />}
        {view === "statistics" && <StatisticsView />}
        {view === "settings" && <SettingsView userRole={user.role} />}
      </main>
    </div>
  );
}
