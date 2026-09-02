import { CalendarClock, CarFront, SlidersHorizontal } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";

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
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function selectFromKeyboard(event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) {
    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % modes.length;
    if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + modes.length) % modes.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = modes.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    tabRefs.current[nextIndex]?.focus();
    onChange(modes[nextIndex].value);
  }

  return (
    <div className="control-mode-tabs" role="tablist" aria-label="제어 방식">
      {modes.map((item, index) => {
        const Icon = item.icon;
        return (
          <button
            ref={(element) => {
              tabRefs.current[index] = element;
            }}
            key={item.value}
            id={`control-mode-${item.value}`}
            type="button"
            role="tab"
            aria-selected={mode === item.value}
            aria-controls={`control-mode-panel-${item.value}`}
            tabIndex={mode === item.value ? 0 : -1}
            className={mode === item.value ? "active" : ""}
            onClick={() => onChange(item.value)}
            onKeyDown={(event) => selectFromKeyboard(event, index)}
          >
            <Icon size={18} aria-hidden="true" />
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
