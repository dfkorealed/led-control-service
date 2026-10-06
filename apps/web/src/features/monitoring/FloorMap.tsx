import type { FloorMapSnapshot } from "@led-control/shared";
import { CircleCheck, CircleX, Clock3, Maximize, Minimize, TriangleAlert } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Dashboard } from "../../api/queries";
import { IconButton, Text, cn } from "../../components/ui";
import { FloorScene } from "../floor-map/FloorScene";
import { FloorMapViewport, type FloorMapViewportHandle } from "../floor-map/FloorMapViewport";
import { resolveFixtureMapPosition } from "../floor-map/fixture-map-position";
import { FixturePinPopover } from "./FixturePinPopover";
import { presentFixtureStatus } from "./fixture-status-presentation";
import { useMonitoringCameraMemory } from "./useMonitoringCameraMemory";
import type { MonitoringCameraScope } from "./monitoring-camera-storage";

interface FloorMapProps {
  floor: Dashboard["floors"][number];
  snapshot: FloorMapSnapshot;
  selectedFixtureId: string | null;
  onSelectFixture: (fixtureId: string) => void;
  timeZone?: string;
  focusRequest?: { requestId: number; fixtureId: string };
  onFocusResult?: (requestId: number, result: "focused" | "unplaced" | "unknown") => void;
  onPinOpenChange?: (open: boolean) => void;
  onShowDetails?: (fixtureId: string, trigger?: HTMLElement) => void;
  emphasizedFixtureIds?: ReadonlySet<string>;
  fullView?: boolean;
  onToggleFullView?: (trigger: HTMLButtonElement) => void;
  activeFilter?: string;
  cameraScope?: MonitoringCameraScope | null;
  detailOpen?: boolean;
}

const MAP_PAN_STEP_PX = 80;

export function FloorMap({ floor, snapshot, selectedFixtureId, onSelectFixture, timeZone = "Asia/Seoul", focusRequest, onFocusResult, onPinOpenChange, onShowDetails, emphasizedFixtureIds, fullView = false, onToggleFullView, activeFilter, cameraScope = null, detailOpen = false }: FloorMapProps) {
  const [zoom, setZoom] = useState(1);
  const shellRef = useRef<HTMLDivElement>(null);
  const viewportRef = useRef<FloorMapViewportHandle>(null);
  const cameraMemory = useMonitoringCameraMemory(cameraScope, snapshot, viewportRef);
  const anchors = useRef(new Map<string, HTMLButtonElement>());
  const lastFocusRequest = useRef<number | null>(null);
  const onFocusResultRef = useRef(onFocusResult);
  onFocusResultRef.current = onFocusResult;
  const markerRef = useRef<HTMLButtonElement | null>(null);
  const pinOpenTimerRef = useRef<number | null>(null);
  const [openFixtureId, setOpenFixtureId] = useState<string | null>(null);
  const previousOpenFixture = useRef<string | null>(null);
  useEffect(() => {
    const closed = previousOpenFixture.current !== null && openFixtureId === null;
    previousOpenFixture.current = openFixtureId;
    if (!closed || detailOpen) return;
    // Run after the overlay's own FocusScope teardown, which may restore focus in a frame.
    const frame = requestAnimationFrame(() => {
      if (markerRef.current?.isConnected) markerRef.current.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [openFixtureId, detailOpen]);
  useEffect(() => { if (detailOpen) setOpenFixtureId(null); }, [detailOpen]);
  const selectedRuntimeFixture = floor.fixtures.find((fixture) => fixture.id === openFixtureId) ?? null;
  const savedFixture = snapshot.fixtures?.find((fixture) => fixture.id === openFixtureId) ?? null;
  const openFixtureName = savedFixture?.name ?? selectedRuntimeFixture?.name ?? "조명";
  useEffect(() => { setOpenFixtureId(null); }, [floor.id, snapshot.revision]);
  useEffect(() => { if (selectedFixtureId === null) setOpenFixtureId(null); }, [activeFilter, selectedFixtureId]);
  useEffect(() => {
    if (openFixtureId !== null && selectedFixtureId !== null && openFixtureId !== selectedFixtureId) setOpenFixtureId(null);
  }, [openFixtureId, selectedFixtureId]);
  useEffect(() => { onPinOpenChange?.(openFixtureId !== null); }, [openFixtureId, onPinOpenChange]);
  useEffect(() => {
    if (!focusRequest || lastFocusRequest.current === focusRequest.requestId) return;
    const fixture = floor.fixtures.find(item => item.id === focusRequest.fixtureId);
    const position = resolveFixtureMapPosition(snapshot, fixture);
    const anchor = anchors.current.get(focusRequest.fixtureId);
    if (position.kind !== "placed" || !anchor) {
      lastFocusRequest.current = focusRequest.requestId;
      onFocusResultRef.current?.(focusRequest.requestId, position.kind === "unplaced" ? "unplaced" : "unknown");
      return;
    }
    // Centering applies scroll in the viewport's next frame. React Aria dismisses
    // a pin when its scroll ancestor moves: open only after that scroll settles,
    // and after the closing drawer has restored its focus.
    let frame = requestAnimationFrame(() => {
      // The compact shell has a fixed bottom navigation. Bring an explicitly
      // located fixture into the visible map area before opening its overlay.
      if (!fullView && window.matchMedia?.("(max-width: 759px)").matches) {
        shellRef.current?.scrollIntoView?.({ block: "center", inline: "nearest", behavior: "auto" });
      }
      viewportRef.current?.centerOn(position.point);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          lastFocusRequest.current = focusRequest.requestId;
          markerRef.current = anchor;
          anchor.focus({ preventScroll: true });
          setOpenFixtureId(focusRequest.fixtureId);
          onFocusResultRef.current?.(focusRequest.requestId, "focused");
        });
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, floor.fixtures, snapshot, fullView]);
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
  const observedFixtureIds = new Set(floor.fixtures.map(fixture => fixture.id));
  const unobservedFixtureIds = new Set(snapshot.fixtures?.filter(pin => !observedFixtureIds.has(pin.id)).map(pin => pin.id));
  const savedIds = new Set(snapshot.fixtures?.map(pin => pin.id));
  const displayed = sceneFixtures.filter(fixture => savedIds.has(fixture.id) || (!snapshot.mapDocument && fixture.placementStatus !== "unplaced"));
  const presentStates = new Set<string>(displayed.map(fixture => fixture.statusPresentation.mapState));
  if (unobservedFixtureIds.size) presentStates.add("unknown");
  const legend = [
    { state: "online", label: "정상", Icon: CircleCheck, color: "text-fixture-connected" },
    { state: "fault", label: "장애", Icon: TriangleAlert, color: "text-fixture-fault" },
    { state: "offline", label: "오프라인", Icon: CircleX, color: "text-fixture-offline" },
    { state: "waiting", label: "상태 확인 대기", Icon: Clock3, color: "text-fixture-inspection" },
    { state: "unknown", label: "조명 정보 확인 전", Icon: Clock3, color: "text-fixture-inspection" }
  ].filter(item => presentStates.has(item.state));

  return (
    <div ref={shellRef} className="relative flex h-full min-h-min w-full min-w-0 flex-col overflow-hidden rounded-panel border border-border-default bg-surface-inset" role="region" aria-label="층 도면" data-monitoring-map-shell="" data-zoom={zoom}>
      {/* The CAD surface's aspect ratio must not contribute an intrinsic page
          height; the containing flex map defines its available viewport. */}
      <div className="min-h-min min-w-0 flex-1">
      <FloorMapViewport
        ref={viewportRef}
        maintainCameraOnResize
        controlsPlacement="footer"
        wheelZoomWithoutModifier
        showFitControl={false}
        resetControlFits
        controlAfterZoom={onToggleFullView ? <IconButton type="button" variant="ghost" size="sm" className="max-compact:size-13" aria-label={fullView ? "전체 보기 종료" : "지도 전체 보기"} aria-pressed={fullView} onClick={event => onToggleFullView(event.currentTarget)}>{fullView ? <Minimize size={16} aria-hidden="true" /> : <Maximize size={16} aria-hidden="true" />}</IconButton> : undefined}
        onCameraReady={cameraMemory.onCameraReady}
        onCameraSettled={cameraMemory.onCameraSettled}
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
          onFixtureAnchorChange={(id, anchor) => { if (anchor) anchors.current.set(id, anchor); else anchors.current.delete(id); }}
          emphasizedFixtureIds={emphasizedFixtureIds}
          unobservedFixtureIds={unobservedFixtureIds}
        />
      </FloorMapViewport>
      </div>
      <FixturePinPopover
        name={openFixtureName}
        fixture={selectedRuntimeFixture}
        position={savedFixture ? { x: savedFixture.x, y: savedFixture.y } : null}
        triggerRef={markerRef}
        open={openFixtureId !== null && !detailOpen}
        onShowDetails={openFixtureId && onShowDetails ? () => onShowDetails(openFixtureId, markerRef.current ?? undefined) : undefined}
        onOpenChange={(open) => {
          if (open) return;
          setOpenFixtureId(null);
        }}
        timeZone={timeZone}
      />
      {legend.length ? <ul className="pointer-events-none m-0 flex shrink-0 list-none flex-wrap gap-x-3 gap-y-1.5 border-t border-border-default bg-surface-panel px-3 py-2" aria-label="조명 상태 범례">
        {legend.map(({ state, label, Icon, color }) => <li key={state} className={cn("inline-flex items-center gap-1", color)}><Icon size={14} aria-hidden="true" /><Text as="span" variant="overline" className={color}>{label}</Text></li>)}
      </ul> : null}
    </div>
  );
}
