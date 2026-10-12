import { useRef, type HTMLAttributes, type KeyboardEvent } from "react";
import { Button } from "./Button";
import { UnderlineNavigation } from "./UnderlineNavigation";
import { navigationItemClass } from "./navigation-item-recipe";
import { cn } from "./utils/cn";

interface UnderlineTabsProps<T extends string> {
  id: string;
  label: string;
  items: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (value: T) => void;
}

export function UnderlineTabs<T extends string>({ id, label, items, value, onChange }: UnderlineTabsProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  function selectFromKeyboard(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const next = event.key === "ArrowRight" ? (index + 1) % items.length
      : event.key === "ArrowLeft" ? (index - 1 + items.length) % items.length
        : event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : null;
    if (next === null) return;
    event.preventDefault();
    refs.current[next]?.focus();
    onChange(items[next].value);
  }
  return <UnderlineNavigation as="div" role="tablist" aria-label={label} aria-orientation="horizontal"
    className="shrink-0" trackClassName="w-full gap-0">
    {items.map((item, index) => <Button key={item.value} ref={node => { refs.current[index] = node; }}
      type="button" variant="ghost" size="sm" role="tab" id={`${id}-tab-${item.value}`}
      aria-controls={`${id}-panel-${item.value}`} aria-selected={value === item.value} tabIndex={value === item.value ? 0 : -1}
      className={cn(navigationItemClass({ active: value === item.value }), "h-13 min-h-13 min-w-0 flex-1 basis-0 whitespace-nowrap rounded-none border-x-0 border-t-0 px-1 text-body-sm")}
      onClick={() => onChange(item.value)} onKeyDown={event => selectFromKeyboard(event, index)}>{item.label}</Button>)}
  </UnderlineNavigation>;
}

interface UnderlineTabPanelProps extends Omit<HTMLAttributes<HTMLDivElement>, "id"> {
  tabsId: string;
  value: string;
  activeValue: string;
}

export function UnderlineTabPanel({ tabsId, value, activeValue, className, ...props }: UnderlineTabPanelProps) {
  const active = value === activeValue;
  return <div {...props} id={`${tabsId}-panel-${value}`} role="tabpanel" aria-labelledby={`${tabsId}-tab-${value}`}
    hidden={!active} className={cn(active ? className : "hidden")} />;
}
