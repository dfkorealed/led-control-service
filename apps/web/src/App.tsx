import { Activity, BarChart3, Settings, SlidersHorizontal } from "lucide-react";
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
        <div className="brand">LED Control</div>
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
        <h1>{active.label}</h1>
      </main>
    </div>
  );
}
