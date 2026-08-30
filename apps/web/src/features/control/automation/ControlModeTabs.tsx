import { CalendarClock, CarFront, SlidersHorizontal } from "lucide-react";

export type ControlPageMode = "manual" | "schedule" | "event";

const modes = [
  { value: "manual", label: "수동 제어", icon: SlidersHorizontal },
  { value: "schedule", label: "스케줄 제어", icon: CalendarClock },
  { value: "event", label: "이벤트 제어", icon: CarFront }
] as const;

export function ControlModeTabs({
  mode,
  onChange
}: {
  mode: ControlPageMode;
  onChange: (mode: ControlPageMode) => void;
}) {
  return (
    <div className="control-mode-tabs" role="tablist" aria-label="제어 방식">
      {modes.map((item) => {
        const Icon = item.icon;
        return (
          <button
            key={item.value}
            id={`control-mode-${item.value}`}
            type="button"
            role="tab"
            aria-selected={mode === item.value}
            aria-controls={`control-mode-panel-${item.value}`}
            className={mode === item.value ? "active" : ""}
            onClick={() => onChange(item.value)}
          >
            <Icon size={16} aria-hidden="true" />
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
