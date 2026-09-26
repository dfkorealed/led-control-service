import type { RefObject } from "react";
import type { DashboardFixture } from "../../api/queries";
import { Popover, Text } from "../../components/ui";
import { presentFixtureBrightness } from "./fixture-brightness-presentation";
import { formatMonitoringTimestamp } from "./monitoring-time";

interface FixturePinPopoverProps {
  name: string;
  fixture: DashboardFixture | null;
  position: { x: number; y: number } | null;
  triggerRef: RefObject<Element | null>;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  timeZone: string;
}

export function FixturePinPopover({ name, fixture, position, triggerRef, open, onOpenChange, timeZone }: FixturePinPopoverProps) {
  const brightness = fixture ? presentFixtureBrightness(fixture) : null;

  return <Popover
    isOpen={open}
    onOpenChange={onOpenChange}
    triggerRef={triggerRef}
    shouldCloseOnInteractOutside={(element) => !triggerRef.current?.contains(element)}
    isNonModal
    placement="right"
    offset={8}
    label={`${name} 조명 정보`}
    className="w-56 max-w-[calc(100vw-24px)]"
  >
    <div className="grid gap-3" data-monitoring-pin-popover="">
      <Text as="strong" variant="body" weight="bold">{name}</Text>
      <dl className="m-0 grid gap-2 text-body-sm">
        <div className="grid gap-0.5">
          <dt className="text-content-secondary">{brightness?.label ?? "조명 상태"}</dt>
          <dd className="m-0 font-bold">{brightness?.value ?? "상태 확인 전"}</dd>
        </div>
        {brightness?.observedAt ? <div className="grid gap-0.5">
          <dt className="text-content-secondary">마지막 확인</dt>
          <dd className="m-0"><time dateTime={brightness.observedAt}>{formatMonitoringTimestamp(brightness.observedAt, timeZone)}</time></dd>
        </div> : null}
        <div className="grid gap-0.5">
          <dt className="text-content-secondary">지도 좌표</dt>
          <dd className="m-0">{position ? `${position.x}, ${position.y}` : "저장된 위치 정보 없음"}</dd>
        </div>
      </dl>
    </div>
  </Popover>;
}
