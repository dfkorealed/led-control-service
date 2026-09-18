import { CalendarClock, CarFront, SlidersHorizontal } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";
import { Button, UnderlineNavigation, UnderlineNavigationLabel } from "../../../components/ui";

export type ControlPageMode = "manual" | "schedule" | "event";

const allModes = [
  { value: "manual", label: "수동 제어", icon: SlidersHorizontal },
  { value: "schedule", label: "스케줄 제어", icon: CalendarClock },
  { value: "event", label: "이벤트 제어", icon: CarFront }
] as const;

const controlModeTabClassName = (isActive: boolean) => `min-w-28 shrink-0 rounded-none border-x-0 border-t-0 border-b-2 bg-transparent px-3 text-body-sm whitespace-nowrap ${isActive
  ? "border-action-primary text-action-primary"
  : "border-transparent text-content-secondary hover:border-border-strong hover:text-content-primary"}`;

export function ControlModeTabs({
  mode,
  onChange,
  allowAutomation
}: {
  mode: ControlPageMode;
  onChange: (mode: ControlPageMode) => void;
  allowAutomation: boolean;
}) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const modes = allowAutomation ? allModes : allModes.slice(0, 1);

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
    <UnderlineNavigation as="div" role="tablist" aria-label="제어 방식">
      {modes.map((item, index) => {
        const Icon = item.icon;
        return (
          <Button
            variant="ghost"
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
            className={controlModeTabClassName(mode === item.value)}
            onClick={() => onChange(item.value)}
            onKeyDown={(event) => selectFromKeyboard(event, index)}
          >
            <UnderlineNavigationLabel icon={<Icon size={18} />}>
              {item.label}
            </UnderlineNavigationLabel>
          </Button>
        );
      })}
    </UnderlineNavigation>
  );
}
