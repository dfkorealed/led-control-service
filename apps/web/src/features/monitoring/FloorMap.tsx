import type { FloorMapSnapshot } from "@led-control/shared";
import { CircleCheck, CircleX, Clock3, Hand, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Dashboard } from "../../api/queries";
import { Text } from "../../components/ui";
import { FloorScene } from "../floor-map/FloorScene";
import { FloorMapViewport } from "../floor-map/FloorMapViewport";
import { FixturePinPopover } from "./FixturePinPopover";
import { presentFixtureStatus } from "./fixture-status-presentation";

interface FloorMapProps {
  floor: Dashboard["floors"][number];
  snapshot: FloorMapSnapshot;
  selectedFixtureId: string | null;
  onSelectFixture: (fixtureId: string) => void;
  timeZone?: string;
}

const MAP_PAN_STEP_PX = 80;

export function FloorMap({ floor, snapshot, selectedFixtureId, onSelectFixture, timeZone = "Asia/Seoul" }: FloorMapProps) {
  const [zoom, setZoom] = useState(1);
  const markerRef = useRef<HTMLButtonElement | null>(null);
  const pinOpenTimerRef = useRef<number | null>(null);
  const [openFixtureId, setOpenFixtureId] = useState<string | null>(null);
  const selectedRuntimeFixture = floor.fixtures.find((fixture) => fixture.id === openFixtureId) ?? null;
  const savedFixture = snapshot.fixtures?.find((fixture) => fixture.id === openFixtureId) ?? null;
  const openFixtureName = savedFixture?.name ?? selectedRuntimeFixture?.name ?? "조명";
  const savedFixtureIds = new Set(snapshot.fixtures?.map((fixture) => fixture.id) ?? []);
  // Legacy maps can draw runtime-only placements alongside saved pins. A paged
  // runtime list cannot prove the complete displayed count, so show no number.
  const hasLegacyRuntimeOnlyPin = !snapshot.mapDocument && floor.fixtures.some((fixture) =>
    fixture.placementStatus !== "unplaced" && !savedFixtureIds.has(fixture.id)
  );
  const mapCount = snapshot.fixtures === undefined || hasLegacyRuntimeOnlyPin
    ? null : snapshot.fixtures.length;
  useEffect(() => { setOpenFixtureId(null); }, [floor.id, snapshot.revision]);
  useEffect(() => () => {
    if (pinOpenTimerRef.current !== null) window.clearTimeout(pinOpenTimerRef.current);
  }, []);

  function handleMapKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    const delta = {
      ArrowLeft: { left: -MAP_PAN_STEP_PX, top: 0 },
      ArrowRight: { left: MAP_PAN_STEP_PX, top: 0 },
      ArrowUp: { left: 0, top: -MAP_PAN_STEP_PX },
      ArrowDown: { left: 0, top: MAP_PAN_STEP_PX }
    }[event.key];
    if (!delta) return;
    event.preventDefault();
    event.currentTarget.scrollBy({ ...delta, behavior: "smooth" });
  }

  function handleFixturePress(fixtureId: string, anchor: HTMLButtonElement) {
    markerRef.current = anchor;
    if (pinOpenTimerRef.current !== null) window.clearTimeout(pinOpenTimerRef.current);
    // Non-modal overlays can see the marker's activating pointer event as an outside click.
    // Open after that event completes so the first dismiss belongs to a later user action.
    pinOpenTimerRef.current = window.setTimeout(() => {
      pinOpenTimerRef.current = null;
      setOpenFixtureId((current) => current === fixtureId ? null : fixtureId);
    }, 0);
    onSelectFixture(fixtureId);
  }
  const selectedFixtureIds = useMemo(
    () => selectedFixtureId ? new Set([selectedFixtureId]) : new Set<string>(),
    [selectedFixtureId]
  );
  const sceneFixtures = floor.fixtures.map((fixture) => ({
    ...fixture,
    statusPresentation: presentFixtureStatus(fixture)
  }));

  return (
    <div className="relative h-[340px] w-full min-w-0 overflow-hidden rounded-panel border border-border-default bg-surface-inset max-phone-wide:h-[300px] tablet:h-full tablet:min-h-0" role="region" aria-label="층 도면" data-monitoring-map-shell="" data-zoom={zoom}>
      <FloorMapViewport
        snapshot={snapshot}
        ariaLabel="상하좌우로 이동하고 확대 축소할 수 있는 지도"
        onZoomChange={setZoom}
        viewportTestId="monitoring-map-viewport"
        onViewportKeyDown={handleMapKeyDown}
      >
        <FloorScene
          snapshot={snapshot}
          fixtures={sceneFixtures}
          interactive={false}
          floorName={floor.name}
          selection={{ kind: "single", selectedFixtureIds }}
          coarsePointer
          markerTitle={(fixture) => fixture.name}
          onFixturePress={handleFixturePress}
        />
      </FloorMapViewport>
      <FixturePinPopover
        name={openFixtureName}
        fixture={selectedRuntimeFixture}
        position={savedFixture ? { x: savedFixture.x, y: savedFixture.y } : null}
        triggerRef={markerRef}
        open={openFixtureId !== null}
        onOpenChange={(open) => {
          if (open) return;
          setOpenFixtureId(null);
          queueMicrotask(() => markerRef.current?.focus());
        }}
        timeZone={timeZone}
      />
      <Text as="span" variant="overline" className="pointer-events-none absolute top-3 left-3 z-6 rounded-control border border-border-default bg-surface-panel px-2.5 py-1.5 text-content-secondary" data-monitoring-map-count="">
        {mapCount === null ? "지도 배치 정보 확인 불가" : `지도 표시 ${mapCount}대`}
      </Text>
      <ul className="pointer-events-none absolute bottom-12 left-3 z-6 m-0 flex max-w-[calc(100%-1.5rem)] list-none flex-wrap justify-start gap-x-3 gap-y-1.5 rounded-control border border-border-default bg-surface-panel p-2 max-compact:bottom-16 max-compact:-translate-y-2.5" aria-label="조명 상태 범례">
        <li className="inline-flex items-center gap-1 whitespace-nowrap text-fixture-connected"><CircleCheck size={14} aria-hidden="true" /><Text as="span" variant="overline" className="text-fixture-connected">정상</Text></li>
        <li className="inline-flex items-center gap-1 whitespace-nowrap text-fixture-fault"><TriangleAlert size={14} aria-hidden="true" /><Text as="span" variant="overline" className="text-fixture-fault">장애</Text></li>
        <li className="inline-flex items-center gap-1 whitespace-nowrap text-fixture-offline"><CircleX size={14} aria-hidden="true" /><Text as="span" variant="overline" className="text-fixture-offline">오프라인</Text></li>
        <li className="inline-flex items-center gap-1 whitespace-nowrap text-fixture-inspection"><Clock3 size={14} aria-hidden="true" /><Text as="span" variant="overline" className="text-fixture-inspection">상태 확인 대기</Text></li>
      </ul>
      <Text as="span" variant="overline" tone="inverse" className="pointer-events-none absolute bottom-3 left-3 z-6 inline-flex items-center gap-1.5 rounded-control bg-surface-inverse px-2.5 py-1.5 max-compact:hidden" data-monitoring-map-pan-hint=""><Hand size={14} aria-hidden="true" />드래그 또는 스크롤로 이동</Text>
    </div>
  );
}
