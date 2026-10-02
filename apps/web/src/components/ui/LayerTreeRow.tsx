import { Eye, EyeOff, Lock, MoreHorizontal, Unlock } from "lucide-react";
import { Checkbox } from "./fields/Checkbox";
import { IconTooltipButton } from "./IconTooltipButton";
import { DropdownMenu, type DropdownItem } from "./overlays/DropdownMenu";
import { Text } from "./Typography";

export function LayerTreeRow({ name, checked, indeterminate = false, selectionLabel = `${name} 내 요소 선택`, visible, locked, disabled, onSelect, onVisible, onLock, menu = [], onAction }: {
  name: string; checked: boolean; visible: boolean; locked: boolean; disabled: boolean;
  indeterminate?: boolean; selectionLabel?: string;
  onSelect(checked: boolean): void; onVisible(): void; onLock(): void;
  menu?: DropdownItem<string>[]; onAction?(key: string): void;
}) {
  return <div data-layer-row className="flex min-w-0 items-center border-b border-border-subtle">
    <Checkbox label={selectionLabel} className="w-11 shrink-0 [&_label>span:last-child]:sr-only [&_label]:size-11 [&_label]:justify-center [&_label]:p-0" isSelected={checked} isIndeterminate={indeterminate} isDisabled={disabled} onChange={onSelect} />
    <Text className="min-w-0 flex-1 truncate" title={name}>{name}</Text>
    <IconTooltipButton size="sm" icon={visible ? Eye : EyeOff} label={`${name} ${visible ? "숨기기" : "표시"}`} disabled={disabled} onClick={onVisible} />
    <IconTooltipButton size="sm" icon={locked ? Lock : Unlock} label={`${name} ${locked ? "잠금 해제" : "잠금"}`} disabled={disabled} onClick={onLock} />
    {menu.length > 0 && <DropdownMenu label={`${name} 메뉴`} triggerIcon={MoreHorizontal} size="sm" variant="ghost" items={menu} onAction={key => onAction?.(key)} isDisabled={disabled} />}
  </div>;
}
