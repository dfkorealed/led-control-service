import { CalendarClock, CarFront, Layers3, SlidersHorizontal } from "lucide-react";
import { useRef, type KeyboardEvent } from "react";
import { Button, UnderlineNavigation, UnderlineNavigationLabel, navigationItemClass } from "../../../components/ui";

export type ControlPageMode = "manual" | "schedule" | "event" | "group";

const allModes = [
  { value: "manual", label: "수동 제어", icon: SlidersHorizontal },
  { value: "schedule", label: "스케줄 제어", icon: CalendarClock },
  { value: "event", label: "이벤트 제어", icon: CarFront },
  { value: "group", label: "그룹/구역", icon: Layers3 }
] as const;

const controlModeTabClassName = (isActive: boolean) => `${navigationItemClass({ active: isActive, variant: "customer" })} min-w-28 shrink-0 whitespace-nowrap`;

export function ControlModeTabs({
  mode,
  onChange,
  allowAutomation,
  allowGroups
}: {
  mode: ControlPageMode;
  onChange: (mode: ControlPageMode) => void;
  allowAutomation: boolean;
  allowGroups: boolean;
}) {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const modes = allModes.filter((item) => item.value === "manual"
    || (item.value === "group" ? allowGroups : allowAutomation));

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
    <UnderlineNavigation variant="customer" as="div" role="tablist" aria-label="제어 방식">
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
