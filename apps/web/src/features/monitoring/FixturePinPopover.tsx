import type { RefObject } from "react";
import { X } from "lucide-react";
import type { DashboardFixture } from "../../api/queries";
import { Button, IconButton, Popover, Text } from "../../components/ui";
import { FixtureStatusBadge } from "./FixtureStatusBadge";
import { presentFixtureStatus } from "./fixture-status-presentation";
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
  onShowDetails?: () => void;
}

export function FixturePinPopover({ name, fixture, triggerRef, open, onOpenChange, timeZone, onShowDetails }: FixturePinPopoverProps) {
  const brightness = fixture ? presentFixtureBrightness(fixture) : null;
  const status = fixture ? presentFixtureStatus(fixture) : null;

  return <Popover
    isOpen={open}
    onOpenChange={onOpenChange}
    triggerRef={triggerRef}
    shouldCloseOnInteractOutside={(element) => !triggerRef.current?.contains(element)}
    isNonModal
    // 위/아래 배치는 좁은 화면에서도 가로 경계 보정이 가능하다.
    // 좌/우 배치는 중앙 핀 양쪽에 공간이 부족하면 내용이 화면 밖으로 밀린다.
    placement="top"
    offset={8}
    label={`${name} 조명 정보`}
    className="w-56 max-w-[calc(100vw-24px)]"
  >
    <div className="grid gap-3" data-monitoring-pin-popover="">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <Text as="strong" variant="body" weight="bold" className="min-w-0 break-words">{name}</Text>
        <IconButton variant="ghost" className="size-13" aria-label="조명 정보 닫기" onClick={() => onOpenChange(false)}><X size={16} aria-hidden="true" /></IconButton>
      </div>
      <FixtureStatusBadge fixture={fixture} />
      <dl className="m-0 grid gap-2 text-body-sm">
        <div className="grid gap-0.5">
          <dt className="text-content-secondary">{brightness?.label ?? "조명 상태"}</dt>
          <dd className="m-0 font-bold">{brightness?.value ?? "상태 확인 전"}</dd>
        </div>
        {brightness?.observedAt ? <div className="grid gap-0.5">
          <dt className="text-content-secondary">마지막 확인</dt>
          <dd className="m-0"><time dateTime={brightness.observedAt}>{formatMonitoringTimestamp(brightness.observedAt, timeZone)}</time></dd>
        </div> : null}
      </dl>
      {status ? <Text variant="body-sm" tone="secondary">{status.recommendedAction}</Text> : null}
      {onShowDetails ? <Button variant="secondary" onClick={onShowDetails}>상세 보기</Button> : null}
    </div>
  </Popover>;
}
