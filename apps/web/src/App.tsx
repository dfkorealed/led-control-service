import { Activity, BarChart3, Bell, MapPin, Settings, SlidersHorizontal } from "lucide-react";
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
  const { view, setView } = useNavigationStore();
  const active = items.find((item) => item.key === view) ?? items[0];

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
            <span className="eyebrow">Demo Underground Parking</span>
            <h1>{active.label}</h1>
          </div>
          <div className="topbar-actions" aria-label="현장 상태">
            <span className="site-pill">
              <MapPin size={16} />
              B2 주차장
            </span>
            <span className="status-pill online">게이트웨이 정상</span>
            <button className="icon-button" aria-label="알림">
              <Bell size={18} />
            </button>
          </div>
        </header>
        {view === "monitoring" && <MonitoringView />}
        {view === "control" && <ControlView />}
        {view === "statistics" && <StatisticsView />}
        {view === "settings" && <SettingsView />}
      </main>
    </div>
  );
}
