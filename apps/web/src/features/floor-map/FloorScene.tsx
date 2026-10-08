import Konva from "konva";
import { CircleX, Clock3, TriangleAlert } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  lazy,
  Suspense,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent
} from "react";
import { createPortal } from "react-dom";
import { Group, Line, Rect, Stage, Text, Layer } from "react-konva";
import type {
  CadSceneDescriptor,
  CadSceneManifest,
  CadSceneState,
  CadSceneTile,
  FloorMapSnapshot
} from "@led-control/shared";
import { Button, Text as UiText, cn, themeColor } from "../../components/ui";
import {
  CAD_SCENE_MAX_MANIFEST_BYTES,
  CAD_SCENE_MAX_TILE_BYTE_SIZE,
  cadSceneManifestSchema,
  cadSceneStateSchema
} from "@led-control/shared/cad-scene-contracts";
import { readCadSceneBytes, readCadSceneJson } from "../../api/cad-scene-content";
import { useFloorMapViewportOverlay, type FloorMapCameraFrame } from "./FloorMapViewport";
import type { ReadOnlyCadSceneRenderer } from "./cad-scene-readonly-runtime";
import { createMapDocumentSource } from "../../api/map-document";
import { useMapDocumentReadScope } from "../floor-editor/editor-monitoring-cache";
import { MAP_DRAG_THRESHOLD_PX, pointerDistance } from "./map-gestures";
import { resolveMarkerHit } from "./marker-hit";

const MapSceneCanvas = lazy(() => import("../map-scene/MapSceneCanvas").then(module => ({ default: module.MapSceneCanvas })));

const fixtureStatusLabels = {
  online: "정상",
  offline: "오프라인",
  fault: "장애"
} as const;

const fixtureBrightnessClasses = {
  1: "bg-fixture-brightness-1 shadow-fixture-brightness-1",
  2: "bg-fixture-brightness-2 shadow-fixture-brightness-2",
  3: "bg-fixture-brightness-3 shadow-fixture-brightness-3",
  4: "bg-fixture-brightness-4 shadow-fixture-brightness-4",
  5: "bg-fixture-brightness-5 shadow-fixture-brightness-5",
  6: "bg-fixture-brightness-6 shadow-fixture-brightness-6",
  7: "bg-fixture-brightness-7 shadow-fixture-brightness-7",
  8: "bg-fixture-brightness-8 shadow-fixture-brightness-8",
  9: "bg-fixture-brightness-9 shadow-fixture-brightness-9",
  10: "bg-fixture-brightness-10 shadow-fixture-brightness-10"
} as const;

export interface SceneFixture {
  id: string;
  name: string;
  x: number;
  y: number;
  brightness: number;
  status: "online" | "offline" | "fault";
  statusReason?: string | null;
  placementStatus?: "unplaced" | "placed";
  statusPresentation?: { label: string; state: string; mapState?: "online" | "fault" | "offline" | "waiting" };
}

export interface SceneMapObject {
  id: string;
  type: "rectangle" | "triangle" | "line" | "text";
  x: number;
  y: number;
  width: number;
  height: number;
  points?: Array<{ x: number; y: number }> | null;
  rotation: number;
  strokeColor: string;
  fillColor?: string | null;
  strokeWidth: number;
  text?: string | null;
  fontSize?: number | null;
  zIndex: number;
  locked: boolean;
  visible: boolean;
}

export type FixtureSceneSelection =
  | { kind: "none" }
  | { kind: "single"; selectedFixtureIds: ReadonlySet<string> }
  | {
      kind: "multiple";
      selectedFixtureIds: ReadonlySet<string>;
      disabledFixtureIds: ReadonlySet<string>;
      disabledReasons?: ReadonlyMap<string, string>;
    };

export interface FloorSceneProps {
  snapshot: FloorMapSnapshot;
  fixtures: SceneFixture[];
  interactive: boolean;
  floorName?: string;
  selection?: FixtureSceneSelection;
  coarsePointer?: boolean;
  markerTitle?: (fixture: SceneFixture) => string;
  onFixturePress?: (fixtureId: string, anchor: HTMLButtonElement) => void;
  /** Inspection remains available for blocked source markers; selection is still guarded by the caller. */
  inspectDisabledFixtures?: boolean;
  onFixtureAnchorChange?: (fixtureId: string, anchor: HTMLButtonElement | null) => void;
  emphasizedFixtureIds?: ReadonlySet<string>;
  unobservedFixtureIds?: ReadonlySet<string>;
}

interface FixtureMarkerStyle extends CSSProperties {
  "--fixture-left": string;
  "--fixture-top": string;
}

const noFixtureSceneSelection: FixtureSceneSelection = { kind: "none" };

export function FloorScene({
  snapshot,
  fixtures,
  interactive,
  floorName,
  selection = noFixtureSceneSelection,
  coarsePointer = false,
  markerTitle,
  onFixturePress,
  inspectDisabledFixtures = false,
  onFixtureAnchorChange,
  emphasizedFixtureIds,
  unobservedFixtureIds
}: FloorSceneProps) {
  const commonMap = snapshot.mapDocument;
  const nativeCad = !commonMap && snapshot.floorPlan?.sourceType === "cad" && snapshot.cadScene;
  const backgroundUrl = commonMap || nativeCad ? null : snapshot.floorPlan?.renderedImageUrl ?? snapshot.floorPlan?.imageUrl;
  const objectCanvasHost = useRef<HTMLDivElement>(null);
  const [objectCanvasSize, setObjectCanvasSize] = useState({ width: 1, height: 1 });
  useLayoutEffect(() => {
    const host = objectCanvasHost.current;
    if (!host) return;
    const measure = () => {
      const bounds = host.getBoundingClientRect();
      const width = Math.max(1, bounds.width);
      const height = Math.max(1, bounds.height);
      setObjectCanvasSize(current => current.width === width && current.height === height ? current : { width, height });
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(host);
    return () => observer.disconnect();
  }, [snapshot.width, snapshot.height, Boolean(commonMap)]);
  const objects = commonMap ? [] : snapshot.objects.filter((object) => object.visible);
  const renderedFixtures = useMemo<SceneFixture[]>(() => {
    if (snapshot.fixtures === undefined) {
      return fixtures.filter((fixture) => fixture.placementStatus !== "unplaced");
    }
    const runtimeById = new Map(fixtures.map((fixture) => [fixture.id, fixture]));
    const snapshotFixtureIds = new Set(snapshot.fixtures.map((fixture) => fixture.id));
    const snapshotFixtures = snapshot.fixtures.map((layout) => {
      const runtime: SceneFixture = runtimeById.get(layout.id) ?? {
        id: layout.id,
        name: layout.name,
        x: layout.x,
        y: layout.y,
        brightness: 0,
        status: "offline" as const,
        placementStatus: "placed" as const
      };
      return {
        ...runtime,
        id: layout.id,
        name: layout.name,
        x: layout.x,
        y: layout.y,
        placementStatus: "placed" as const
      };
    });
    // Common snapshots contain the authoritative placements. Runtime telemetry
    // may still contain pre-import coordinates until its next polling cycle.
    const runtimeOnlyFixtures = snapshot.mapDocument ? [] : fixtures.filter((fixture) =>
      !snapshotFixtureIds.has(fixture.id) && fixture.placementStatus !== "unplaced"
    );
    return [...snapshotFixtures, ...runtimeOnlyFixtures];
  }, [fixtures, snapshot.fixtures, snapshot.mapDocument]);

  const sceneRef = useRef<HTMLDivElement>(null);
  const markerAnchors = useRef(new Map<string, HTMLButtonElement>());
  const markerPress = useRef<{ pointerId: number; id: string; x: number; y: number; cancelled: boolean } | null>(null);
  const [hoveredMarkerId, setHoveredMarkerId] = useState<string | null>(null);
  const markerScope = JSON.stringify([
    snapshot.floorId, snapshot.revision, snapshot.width, snapshot.height,
    renderedFixtures.map(({ id, x, y }) => [id, x, y]),
    selection.kind, selection.kind === "multiple" ? [...selection.disabledFixtureIds].sort() : []
  ]);

  // Coordinates are measured at each input event, after live camera/scroll/resize
  // changes. Paint order, focus and eligibility never determine geometric intent.
  function markerHit(x: number, y: number) {
    return resolveMarkerHit({ x, y }, [...markerAnchors.current].map(([id, anchor]) => {
      const { left, top, width, height } = anchor.getBoundingClientRect();
      return { id, left, top, width, height };
    }));
  }

  useEffect(() => {
    markerPress.current = null;
    setHoveredMarkerId(null);
    if (!coarsePointer) return;
    const cancel = () => { markerPress.current = null; };
    const down = (event: PointerEvent) => {
      const press = markerPress.current;
      if (press && press.pointerId !== event.pointerId) press.cancelled = true;
    };
    const move = (event: PointerEvent) => {
      const press = markerPress.current;
      if (press?.pointerId === event.pointerId &&
          pointerDistance(press, { x: event.clientX, y: event.clientY }) >= MAP_DRAG_THRESHOLD_PX) press.cancelled = true;
    };
    const upOutside = (event: PointerEvent) => {
      if (markerPress.current?.pointerId === event.pointerId && !sceneRef.current?.contains(event.target as Node)) cancel();
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
    // Window capture also observes a second touch outside the scene and releases
    // outside a marker. It never prevents the viewport's existing pinch/pan input.
    window.addEventListener("pointerdown", down, true);
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", upOutside, true);
    window.addEventListener("pointercancel", cancel, true);
    window.addEventListener("lostpointercapture", cancel, true);
    window.addEventListener("blur", cancel);
    window.addEventListener("keydown", escape, true);
    return () => {
      cancel();
      window.removeEventListener("pointerdown", down, true);
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", upOutside, true);
      window.removeEventListener("pointercancel", cancel, true);
      window.removeEventListener("lostpointercapture", cancel, true);
      window.removeEventListener("blur", cancel);
      window.removeEventListener("keydown", escape, true);
    };
  }, [coarsePointer, markerScope]);

  function handleMarkerPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (!coarsePointer || event.button !== 0 || markerPress.current) return;
    const id = markerHit(event.clientX, event.clientY);
    if (id) markerPress.current = { pointerId: event.pointerId, id, x: event.clientX, y: event.clientY, cancelled: false };
  }

  function handleMarkerPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const press = markerPress.current;
    if (!coarsePointer || press?.pointerId !== event.pointerId) return;
    markerPress.current = null;
    if (press.cancelled || pointerDistance(press, { x: event.clientX, y: event.clientY }) >= MAP_DRAG_THRESHOLD_PX ||
        markerHit(event.clientX, event.clientY) !== press.id) return;
    const actualHit = document.elementFromPoint(event.clientX, event.clientY);
    const anchor = markerAnchors.current.get(press.id);
    // Clipping, a dialog or a CAD error overlay must not activate a covered pin.
    if (!actualHit || !sceneRef.current?.contains(actualHit) ||
        (actualHit !== sceneRef.current && !actualHit.closest("[data-spatial-map-marker]")) || !anchor || anchor.disabled) return;
    anchor.focus({ preventScroll: true });
    onFixturePress?.(press.id, anchor);
  }

  return (
    <div ref={sceneRef} className="relative h-full w-full"
      onPointerDownCapture={handleMarkerPointerDown}
      onPointerUpCapture={handleMarkerPointerUp}
      onPointerMoveCapture={event => {
        if (coarsePointer && event.pointerType !== "touch") setHoveredMarkerId(markerHit(event.clientX, event.clientY));
      }}
      onPointerLeave={() => setHoveredMarkerId(null)}
      onClickCapture={event => {
        // Physical pointer activation was resolved on pointerup, including when
        // the browser originally hit a disabled overlapping button. detail=0
        // keeps native Enter/Space and assistive activation on their exact pin.
        if (coarsePointer && event.detail > 0 && (event.target as Element).closest("[data-spatial-map-marker]")) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      data-floor-scene="" data-map-objects-interactive={interactive ? "true" : "false"}>
      {commonMap ? <CommonMapReadOnlyLayer snapshot={snapshot} /> : null}
      {nativeCad && snapshot.cadScene
        ? <CadSceneReadOnlyLayer descriptor={snapshot.cadScene} mapRevision={snapshot.revision} />
        : null}
      {backgroundUrl ? <img className="pointer-events-none absolute inset-0 z-0 h-full w-full object-contain" src={backgroundUrl} alt={`${floorName ?? "층"} 도면`} draggable={false} /> : null}
      {/* Konva owns generated child canvas dimensions; the stable hook is the documented library geometry exception. */}
      {!commonMap ? <div ref={objectCanvasHost} className="floor-scene-canvas pointer-events-none absolute inset-0 z-1 h-full w-full overflow-hidden" aria-hidden="true">
        {/* Logical CAD maps can be 32768 units wide. Rasterizing that extent
            before CSS scaling exhausts browser canvas memory; scale geometry
            into the measured display surface instead. */}
        <Stage width={objectCanvasSize.width} height={objectCanvasSize.height}
          scaleX={objectCanvasSize.width / snapshot.width} scaleY={objectCanvasSize.height / snapshot.height}
          listening={interactive}>
          <Layer listening={interactive}>
            {objects.map((object) => (
              <FloorMapObjectNode key={object.id} object={object} interactive={interactive} />
            ))}
          </Layer>
        </Stage>
      </div> : null}
      <div className="sr-only" aria-hidden="true">
        {objects.map((object) => (
          <span key={object.id} data-testid={`map-object-${object.id}`}>{object.type}</span>
        ))}
      </div>
      {renderedFixtures.map((fixture) => {
        const unobserved = unobservedFixtureIds?.has(fixture.id) ?? false;
        // FloorMap injects the monitoring presenter result. Editor callers omit it and retain
        // their compact legacy status label without owning monitoring cause precedence.
        const mapState = unobserved ? "unknown" : fixture.statusPresentation?.mapState ?? (fixture.statusReason === "provisioning_waiting_state" ? "waiting" : fixture.status);
        const awaitingState = mapState === "waiting";
        const statusLabel = unobserved ? "조명 정보 확인 전" : fixture.statusPresentation?.label ?? (awaitingState ? "상태 확인 대기" : fixtureStatusLabels[fixture.status]);
        const brightnessLevel = fixtureBrightnessLevel(fixture.brightness);
        // Marker position is stored in map coordinates and must scale with the live snapshot.
        const markerStyle = {
          "--fixture-left": `${(fixture.x / snapshot.width) * 100}%`,
          "--fixture-top": `${(fixture.y / snapshot.height) * 100}%`,
          // The center must leave room for the entire 48px coarse hit target, including at saved map edges.
          left: coarsePointer ? "clamp(1.5rem, var(--fixture-left), calc(100% - 1.5rem))" : "clamp(1rem, var(--fixture-left), calc(100% - 1rem))",
          top: coarsePointer ? "clamp(1.5rem, var(--fixture-top), calc(100% - 1.5rem))" : "clamp(1rem, var(--fixture-top), calc(100% - 1rem))"
        } satisfies FixtureMarkerStyle;
        const markerStateClass = unobserved ? "border-2! border-dotted! border-fixture-inspection-border! bg-surface-inset shadow-none" : awaitingState
          ? "border-2! border-dotted! border-fixture-inspection-border! bg-fixture-inspection-background shadow-none"
          : mapState === "offline"
            ? "border-2! border-dashed! border-fixture-offline-border! bg-fixture-offline-background shadow-none"
            : cn(fixtureBrightnessClasses[brightnessLevel], mapState === "fault" ? "border-2! border-fixture-fault!" : "border-2! border-fixture-connected!");
        const StatusIcon = mapState === "fault" ? TriangleAlert : mapState === "offline" ? CircleX : awaitingState || unobserved ? Clock3 : null;
        const selected = selection.kind !== "none" && selection.selectedFixtureIds.has(fixture.id);
        const disabled = selection.kind === "multiple" && selection.disabledFixtureIds.has(fixture.id);
        const disabledReason = selection.kind === "multiple" ? selection.disabledReasons?.get(fixture.id) : undefined;
        const accessibleState = selection.kind === "multiple"
          ? [
              selected ? "선택됨" : null,
              disabled ? `선택 불가${disabledReason ? `: ${disabledReason}` : ""}` : null
            ].filter((value): value is string => value !== null).join(" ")
          : "";

        return (
          <Button
            key={fixture.id}
            ref={anchor => {
              if (anchor) markerAnchors.current.set(fixture.id, anchor);
              else markerAnchors.current.delete(fixture.id);
              onFixtureAnchorChange?.(fixture.id, anchor);
            }}
            type="button"
            variant="ghost"
            size="sm"
            data-spatial-map-marker="true"
            data-brightness-level={brightnessLevel}
            className={cn(
              "absolute z-2 block! -translate-x-1/2 -translate-y-1/2 cursor-pointer rounded-pill! border-0! bg-transparent! p-0! transition-[background-color,box-shadow] duration-150 motion-reduce:duration-[0.01ms] hover:z-4 focus-visible:z-4 focus-visible:outline-3 focus-visible:outline-offset-4 focus-visible:outline-fixture-selected",
              // Leave a pixel-rounding buffer beyond the 44px coarse-pointer minimum so every edge remains reachable in browser layout.
              coarsePointer ? "size-12! min-h-12!" : "size-5! min-h-5!",
              selected && "z-3",
              emphasizedFixtureIds && !emphasizedFixtureIds.has(fixture.id) && "opacity-30"
            )}
            style={coarsePointer && hoveredMarkerId !== null
              ? { ...markerStyle, zIndex: hoveredMarkerId === fixture.id ? 4 : selected ? 3 : 2 }
              : markerStyle}
            title={markerTitle?.(fixture) ?? `${fixture.name} ${statusLabel}${unobserved ? "" : ` ${fixture.brightness}%`}`}
            aria-label={`${fixture.name} ${statusLabel}${unobserved ? "" : ` ${fixture.brightness}%`}${accessibleState ? ` ${accessibleState}` : ""}`}
            aria-current={selection.kind === "single" && selected ? "true" : undefined}
            aria-pressed={selection.kind === "multiple" ? selected : undefined}
            disabled={disabled && !inspectDisabledFixtures}
            data-selected={selected ? "true" : "false"}
            data-disabled={disabled ? "true" : "false"}
            data-disabled-reason={disabledReason}
            onClick={(event) => onFixturePress?.(fixture.id, event.currentTarget)}
          >
            {/* The marker dot stays 20px; only its transparent button target expands for coarse pointers. */}
            <span data-spatial-map-marker-dot="true" className={cn("pointer-events-none absolute left-1/2 top-1/2 grid size-5 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-pill! border! border-fixture-offline! transition-[background-color,box-shadow] duration-150 motion-reduce:duration-[0.01ms]", markerStateClass, selected && "outline-3 outline-offset-4 outline-fixture-selected")}>
              {StatusIcon ? <StatusIcon size={12} aria-hidden="true" className="text-content-primary" /> : null}
            </span>
          </Button>
        );
      })}
    </div>
  );
}

function CommonMapReadOnlyLayer({ snapshot }: { snapshot: FloorMapSnapshot }) {
  const overlay = useFloorMapViewportOverlay();
  const queryClient = useQueryClient();
  const scope = useMapDocumentReadScope(snapshot.floorId);
  const authScope = scope?.authScope;
  const [frame, setFrame] = useState<FloorMapCameraFrame | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [active, setActive] = useState(() => initialNativeAppState() === "active" && window.document.visibilityState !== "hidden");
  useEffect(() => {
    let nativeState = initialNativeAppState();
    const reconcile = () => setActive(nativeState === "active" && window.document.visibilityState !== "hidden");
    const onLifecycle = (event: Event) => {
      const state = (event as CustomEvent<{ state?: string }>).detail?.state;
      if (state !== "active" && state !== "background" && state !== "inactive") return;
      nativeState = state;
      reconcile();
    };
    window.addEventListener("led-control:webview-lifecycle", onLifecycle);
    window.document.addEventListener("visibilitychange", reconcile);
    return () => {
      window.removeEventListener("led-control:webview-lifecycle", onLifecycle);
      window.document.removeEventListener("visibilitychange", reconcile);
    };
  }, []);
  const document = snapshot.mapDocument!;
  const key = JSON.stringify([authScope, snapshot.floorId, document.generationId, document.revision, attempt]);
  const source = useMemo(() => authScope ? createMapDocumentSource({ floorId: snapshot.floorId, authScope }) : null,
    [authScope, snapshot.floorId, attempt, active]);
  useLayoutEffect(() => overlay?.subscribe(setFrame), [overlay]);
  const failed = failedKey === key;
  return <>
    {active && overlay?.overlayRoot && frame && source && !failed ? createPortal(<Suspense fallback={null}><MapSceneCanvas
      source={source} documentRef={document} camera={frame.camera} readOnly
      platform={isMobileWebView() ? "mobile" : "desktop"}
      onError={() => setFailedKey(key)}
      style={{ position: "absolute", left: frame.left, top: frame.top, width: frame.width, height: frame.height }}
    /></Suspense>, overlay.overlayRoot) : null}
    {failed || !authScope ? <div className="absolute inset-x-3 top-3 z-5" role="alert">
      <UiText>맵을 표시하지 못했습니다.</UiText>
      <Button variant="secondary" onClick={() => {
        if (scope) void queryClient.invalidateQueries({ queryKey: ["floor-map", scope.siteId, snapshot.floorId], exact: true });
        setAttempt(value => value + 1);
      }}>맵 다시 불러오기</Button>
    </div> : null}
  </>;
}

function CadSceneReadOnlyLayer({ descriptor, mapRevision }: { descriptor: CadSceneDescriptor; mapRevision: number }) {
  const overlay = useFloorMapViewportOverlay();
  const canvasHostRef = useRef<HTMLDivElement>(null);
  const [loadState, setLoadState] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [retryAttempt, setRetryAttempt] = useState(0);

  // CAD edits advance the map revision without replacing the scene descriptor.
  useEffect(() => {
    const canvasHost = canvasHostRef.current;
    if (!canvasHost || !overlay?.overlayRoot) return;
    let activeCanvas: HTMLCanvasElement | null = null;
    let disposed = false;
    let generation = 0;
    let controller: AbortController | null = null;
    let renderer: ReadOnlyCadSceneRenderer | null = null;
    let unsubscribeCamera: (() => void) | null = null;
    let running = false;
    let nativeAppState = initialNativeAppState();
    let pageVisible = document.visibilityState !== "hidden";

    const stop = () => {
      generation += 1;
      running = false;
      controller?.abort();
      controller = null;
      unsubscribeCamera?.();
      unsubscribeCamera = null;
      renderer?.destroy();
      renderer = null;
      activeCanvas?.remove();
      activeCanvas = null;
    };

    const fail = (run: number) => {
      if (disposed || run !== generation) return;
      stop();
      if (!disposed) setLoadState("error");
    };

    const canRun = () => nativeAppState === "active" && pageVisible;

    const start = async () => {
      if (disposed || running || !canRun()) return;
      stop();
      running = true;
      const run = ++generation;
      setLoadState("loading");
      controller = new AbortController();
      const signal = controller.signal;
      // Pixi destroy() loses the WebGL context. Reinitializing that same DOM
      // canvas can hang shader probing, so every lifecycle/revision/retry
      // generation owns a new canvas and removes it with the old renderer.
      const canvas = document.createElement("canvas");
      canvas.dataset.testid = "cad-scene-canvas";
      canvas.className = "pointer-events-none absolute block";
      canvas.setAttribute("aria-hidden", "true");
      canvas.style.visibility = "hidden";
      activeCanvas = canvas;
      canvasHost.append(canvas);
      try {
        const [manifestPayload, statePayload] = await Promise.all([
          fetchJson(descriptor.manifestContentPath, signal),
          fetchJson(descriptor.statePath, signal)
        ]);
        const manifest = cadSceneManifestSchema.parse(manifestPayload);
        const state = cadSceneStateSchema.parse(statePayload);
        if (new Set(state.overrides.map(item => item.elementId)).size !== state.overrides.length ||
            new Set(state.layers.map(item => item.layerName)).size !== state.layers.length) {
          throw new Error("CAD scene state contains duplicate entries");
        }
        assertManifestMatchesDescriptor(manifest, descriptor);
        assertStateMatchesDescriptor(state, descriptor);
        if (disposed || signal.aborted || run !== generation) return;
        const overrides = new Map(state.overrides.map((override) => [override.elementId, override]));
        const { createReadOnlyCadSceneRenderer } = await import("./cad-scene-readonly-runtime");
        if (disposed || signal.aborted || run !== generation) return;
        const nextRenderer = await createReadOnlyCadSceneRenderer({
          manifest,
          platform: isMobileWebView() ? "mobile" : "desktop",
          devicePixelRatio: window.devicePixelRatio,
          loadTile: (tile, tileSignal) => fetchBinary(tilePath(descriptor, tile), tileSignal),
          onError: () => fail(run)
        }, overrides);
        if (disposed || signal.aborted || run !== generation) {
          nextRenderer.destroy();
          return;
        }
        renderer = nextRenderer;
        const initialFrame = overlay.getFrame();
        if (initialFrame) applyCameraFrame(canvas, initialFrame);
        await nextRenderer.mount(canvas);
        if (disposed || signal.aborted || run !== generation) {
          nextRenderer.destroy();
          return;
        }
        nextRenderer.setLayerStates(new Map(
          state.layers.map((layer) => [layer.layerName, { visible: layer.visible }])
        ));
        setLoadState("ready");
        canvas.style.visibility = "visible";
        unsubscribeCamera = overlay.subscribe((frame) => {
          if (!frame || renderer !== nextRenderer) {
            canvas.style.visibility = "hidden";
            return;
          }
          canvas.style.visibility = "visible";
          applyCameraFrame(canvas, frame);
          void nextRenderer.setCamera(frame.camera).catch(() => fail(run));
        });
      } catch (error: unknown) {
        if (!signal.aborted) fail(run);
      }
    };

    const reconcile = () => {
      if (canRun()) void start();
      else {
        stop();
        if (!disposed) setLoadState("idle");
      }
    };

    const handleLifecycle = (event: Event) => {
      const state = (event as CustomEvent<{ state?: string }>).detail?.state;
      if (state !== "active" && state !== "background" && state !== "inactive") return;
      nativeAppState = state;
      reconcile();
    };
    const handleVisibility = () => {
      pageVisible = document.visibilityState !== "hidden";
      reconcile();
    };

    window.addEventListener("led-control:webview-lifecycle", handleLifecycle);
    document.addEventListener("visibilitychange", handleVisibility);
    reconcile();
    return () => {
      disposed = true;
      stop();
      window.removeEventListener("led-control:webview-lifecycle", handleLifecycle);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [descriptor, mapRevision, overlay, retryAttempt]);

  if (!overlay?.overlayRoot) return null;
  return (
    <>
      {createPortal(
        <div
          ref={canvasHostRef}
          className="pointer-events-none absolute inset-0"
          aria-hidden="true"
        />,
        overlay.overlayRoot
      )}
      {loadState === "loading" ? (
        <div role="status" className="pointer-events-none absolute inset-0 z-5 grid place-items-center">
          <UiText variant="body-sm" weight="bold" tone="secondary">CAD 도면을 불러오는 중입니다.</UiText>
        </div>
      ) : null}
      {loadState === "error" ? (
        <div role="alert" className="absolute inset-0 z-5 grid place-items-center bg-surface-panel/95 p-4 text-center">
          <div className="space-y-3">
            <UiText variant="body-sm" weight="bold">CAD 도면을 불러오지 못했습니다.</UiText>
            <Button type="button" variant="secondary" onClick={() => setRetryAttempt((attempt) => attempt + 1)} aria-label="CAD 도면 다시 시도">
              다시 시도
            </Button>
          </div>
        </div>
      ) : null}
    </>
  );
}

function initialNativeAppState(): "active" | "background" | "inactive" {
  if (!isMobileWebView()) return "active";
  const state = document.documentElement.dataset.ledControlNativeAppState ??
    (window as Window & { __LED_CONTROL_NATIVE_APP_STATE__?: string }).__LED_CONTROL_NATIVE_APP_STATE__;
  return state === "active" || state === "background" || state === "inactive" ? state : "inactive";
}

function applyCameraFrame(canvas: HTMLCanvasElement, frame: FloorMapCameraFrame): void {
  canvas.style.left = `${frame.left}px`;
  canvas.style.top = `${frame.top}px`;
  canvas.style.width = `${frame.width}px`;
  canvas.style.height = `${frame.height}px`;
}

async function fetchJson(path: string, signal: AbortSignal): Promise<unknown> {
  const response = await fetch(apiPath(path), { credentials: "include", signal });
  if (!response.ok) throw new Error(`CAD scene request failed with ${response.status}`);
  return readCadSceneJson(response, CAD_SCENE_MAX_MANIFEST_BYTES);
}

async function fetchBinary(path: string, signal: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(apiPath(path), { credentials: "include", signal });
  if (!response.ok) throw new Error(`CAD scene tile request failed with ${response.status}`);
  return readCadSceneBytes(response, CAD_SCENE_MAX_TILE_BYTE_SIZE);
}

function apiPath(path: string): string {
  return path.startsWith("/api/") ? path : `/api${path}`;
}

function tilePath(descriptor: CadSceneDescriptor, tile: Pick<CadSceneTile, "lod" | "tileX" | "tileY" | "part">): string {
  return descriptor.tileContentPathTemplate
    .replace("{lod}", String(tile.lod))
    .replace("{tileX}", String(tile.tileX))
    .replace("{tileY}", String(tile.tileY))
    .replace("{part}", String(tile.part));
}

function assertManifestMatchesDescriptor(
  manifest: CadSceneManifest,
  descriptor: CadSceneDescriptor
): void {
  if (manifest.sceneId !== descriptor.id || manifest.manifestAssetId !== descriptor.manifestAssetId ||
      manifest.width !== descriptor.width || manifest.height !== descriptor.height ||
      manifest.tileSize !== descriptor.tileSize || manifest.primitiveCount !== descriptor.primitiveCount ||
      manifest.tileCount !== descriptor.tileCount) {
    throw new Error("CAD scene manifest does not match the applied floor scene");
  }
}


function assertStateMatchesDescriptor(state: CadSceneState, descriptor: CadSceneDescriptor): void {
  const scene = state.scene;
  if (scene.id !== descriptor.id || scene.version !== descriptor.version ||
      scene.sourceImportJobId !== descriptor.sourceImportJobId || scene.width !== descriptor.width ||
      scene.height !== descriptor.height || scene.tileSize !== descriptor.tileSize ||
      scene.primitiveCount !== descriptor.primitiveCount || scene.tileCount !== descriptor.tileCount ||
      scene.manifestAssetId !== descriptor.manifestAssetId ||
      scene.manifestContentPath !== descriptor.manifestContentPath ||
      scene.tileContentPathTemplate !== descriptor.tileContentPathTemplate ||
      scene.statePath !== descriptor.statePath) {
    throw new Error("CAD scene state does not match the applied floor scene revision");
  }
}


function isMobileWebView(): boolean {
  return Boolean(
    (window as Window & { __LED_CONTROL_MOBILE_WEBVIEW__?: boolean }).__LED_CONTROL_MOBILE_WEBVIEW__ ||
    document.documentElement.dataset.ledControlMobileWebview === "true"
  );
}

function fixtureBrightnessLevel(brightness: number): keyof typeof fixtureBrightnessClasses {
  const finiteBrightness = Number.isFinite(brightness) ? brightness : 0;
  const clampedBrightness = Math.min(100, Math.max(0, finiteBrightness));
  return Math.min(10, Math.floor(clampedBrightness / 10) + 1) as keyof typeof fixtureBrightnessClasses;
}

export function FloorMapObjectNode({
  object,
  interactive,
  selected = false,
  preview = false,
  setNodeRef,
  onSelect,
  onDragStart,
  onDragMove,
  onChange,
  onTransformEnd
}: {
  object: SceneMapObject;
  interactive: boolean;
  selected?: boolean;
  preview?: boolean;
  setNodeRef?: (node: Konva.Node | null) => void;
  onSelect?: () => void;
  onDragStart?: () => void;
  onDragMove?: (node: Konva.Node) => void;
  onChange?: (patch: { x?: number; y?: number }) => void;
  onTransformEnd?: (node: Konva.Node) => void;
}) {
  const interactiveProps = interactive && !preview && !object.locked
    ? {
        draggable: true,
        onClick: onSelect,
        onTap: onSelect,
        onDragStart: () => {
          onSelect?.();
          onDragStart?.();
        },
        onDragMove: (event: Konva.KonvaEventObject<globalThis.DragEvent>) => onDragMove?.(event.target),
        onDragEnd: (event: Konva.KonvaEventObject<globalThis.DragEvent>) => onChange?.({
          x: event.target.x(),
          y: event.target.y()
        }),
        onTransformEnd: (event: Konva.KonvaEventObject<Event>) => onTransformEnd?.(event.target)
      }
    : { draggable: false, listening: false };
  const common = {
    ...interactiveProps,
    ref: setNodeRef,
    name: `map-object-${object.id}`,
    x: object.x,
    y: object.y,
    rotation: object.rotation,
    opacity: preview ? 0.6 : 1
  };
  const selectedStroke = selected ? themeColor("fixture-editor-selected") || object.strokeColor : object.strokeColor;
  // Konva needs a transparent fill to keep the complete object interior hit-testable in the editor.
  const hitTestableFill = object.fillColor ?? "transparent";

  if (object.type === "line") {
    return <Line {...common} points={[0, 0, object.width, 0]} stroke={object.strokeColor} strokeWidth={Math.max(object.strokeWidth, 6)} hitStrokeWidth={18} lineCap="round" />;
  }

  if (object.type === "triangle") {
    const points = (object.points ?? trianglePoints(object.width, object.height)).flatMap((point) => [point.x, point.y]);
    return <Line {...common} points={points} closed fill={hitTestableFill} stroke={selectedStroke} strokeWidth={object.strokeWidth} />;
  }

  if (object.type === "text") {
    return (
      <Group {...common}>
        <Rect width={object.width} height={object.height} fill={hitTestableFill} stroke={selectedStroke} strokeWidth={object.strokeWidth} />
        <Text x={8} y={8} width={Math.max(object.width - 16, 1)} height={Math.max(object.height - 16, 1)} text={object.text || "텍스트"} fontSize={object.fontSize ?? 16} fill={object.strokeColor} />
      </Group>
    );
  }

  return <Rect {...common} width={object.width} height={object.height} fill={hitTestableFill} stroke={selectedStroke} strokeWidth={object.strokeWidth} />;
}

export function trianglePoints(width: number, height: number) {
  return [
    { x: width / 2, y: 0 },
    { x: width, y: height },
    { x: 0, y: height }
  ];
}
