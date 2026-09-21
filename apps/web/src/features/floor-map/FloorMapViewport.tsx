import type { FloorMapSnapshot } from "@led-control/shared";
import { Maximize, Minus, Plus } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";
import { Button, IconButton } from "../../components/ui";
import {
  anchoredScrollPosition,
  clampMapZoom,
  mapPointFromSurface,
  normalizeSelectionRect,
  pointerDistance,
  pointerMidpoint,
  scrollAdjustmentForMapAnchor,
  type MapInteractionMode,
  type MapPoint,
  type MapSelectionRect
} from "./map-gestures";
import type { CadSceneCamera } from "../cad-scene/cad-scene-camera";

export interface FloorMapCameraFrame {
  camera: CadSceneCamera;
  left: number;
  top: number;
  width: number;
  height: number;
}

interface FloorMapViewportOverlay {
  overlayRoot: HTMLDivElement | null;
  getFrame: () => FloorMapCameraFrame | null;
  subscribe: (listener: (frame: FloorMapCameraFrame | null) => void) => () => void;
}

const FloorMapViewportOverlayContext = createContext<FloorMapViewportOverlay | null>(null);

export function useFloorMapViewportOverlay(): FloorMapViewportOverlay | null {
  return useContext(FloorMapViewportOverlayContext);
}

interface FloorMapViewportProps {
  snapshot: FloorMapSnapshot;
  ariaLabel: string;
  mode?: MapInteractionMode;
  children: ReactNode;
  onAreaSelect?: (rect: MapSelectionRect) => void;
  showControls?: boolean;
  onZoomChange?: (zoom: number) => void;
  viewportTestId?: string;
}

interface PanGesture {
  pointerId: number;
  point: MapPoint;
  scroll: MapPoint;
}

interface AreaGesture {
  pointerId: number;
  start: MapPoint;
}

interface PinchGesture {
  startDistance: number;
  startZoom: number;
  mapAnchor: MapPoint;
  startScroll: MapPoint;
}

export function FloorMapViewport({
  snapshot,
  ariaLabel,
  mode = "pan",
  children,
  onAreaSelect,
  showControls = true,
  onZoomChange,
  viewportTestId
}: FloorMapViewportProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const activePointers = useRef(new Map<number, MapPoint>());
  const pan = useRef<PanGesture | null>(null);
  const area = useRef<AreaGesture | null>(null);
  const pinch = useRef<PinchGesture | null>(null);
  const zoomRef = useRef(1);
  const onZoomChangeRef = useRef(onZoomChange);
  const suppressNextClick = useRef(false);
  const suppressClickTimeout = useRef<number | null>(null);
  const cameraFrame = useRef<FloorMapCameraFrame | null>(null);
  const cameraListeners = useRef(new Set<(frame: FloorMapCameraFrame | null) => void>());
  const cameraAnimationFrame = useRef<number | null>(null);
  const zoomCommitTimer = useRef<number | null>(null);
  const pendingZoom = useRef<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [selection, setSelection] = useState<MapSelectionRect | null>(null);
  const [overlayRoot, setOverlayRoot] = useState<HTMLDivElement | null>(null);
  onZoomChangeRef.current = onZoomChange;
  const padding = 24;
  const hasViewportSize = viewportSize.width > 0 && viewportSize.height > 0;
  const fitScale = hasViewportSize
    ? Math.min(
        Math.max(1, viewportSize.width - padding * 2) / snapshot.width,
        Math.max(1, viewportSize.height - padding * 2) / snapshot.height
      )
    : 1;
  const mapMetrics = useRef({ width: snapshot.width, height: snapshot.height, fitScale });
  mapMetrics.current = { width: snapshot.width, height: snapshot.height, fitScale };
  const renderedWidth = snapshot.width * fitScale * zoomRef.current;
  const renderedHeight = snapshot.height * fitScale * zoomRef.current;
  // The saved canvas ratio and measured viewport dimensions are runtime geometry.
  const surfaceStyle = {
    aspectRatio: `${snapshot.width} / ${snapshot.height}`,
    "--floor-map-aspect-ratio": snapshot.width / snapshot.height,
    ...(hasViewportSize ? { width: `${renderedWidth}px`, height: `${renderedHeight}px` } : {})
  } as CSSProperties;
  const stageStyle = hasViewportSize
    ? {
        width: `${Math.max(viewportSize.width, renderedWidth + padding * 2)}px`,
        height: `${Math.max(viewportSize.height, renderedHeight + padding * 2)}px`
      }
    : undefined;

  const publishCameraFrame = useCallback(() => {
    cameraAnimationFrame.current = null;
    const viewport = viewportRef.current;
    const surface = surfaceRef.current;
    let frame: FloorMapCameraFrame | null = null;
    if (viewport && surface) {
      const viewportBounds = viewport.getBoundingClientRect();
      const surfaceBounds = surface.getBoundingClientRect();
      // The surface has a symmetric border, while its overlay, Konva layer,
      // and fixture percentages all use the inner content box.
      const contentLeft = surfaceBounds.left + surface.clientLeft;
      const contentTop = surfaceBounds.top + surface.clientTop;
      const contentWidth = surfaceBounds.width - 2 * surface.clientLeft;
      const contentHeight = surfaceBounds.height - 2 * surface.clientTop;
      const left = Math.max(viewportBounds.left, contentLeft);
      const top = Math.max(viewportBounds.top, contentTop);
      const right = Math.min(viewportBounds.right, contentLeft + contentWidth);
      const bottom = Math.min(viewportBounds.bottom, contentTop + contentHeight);
      const width = right - left;
      const height = bottom - top;
      if (width > 0 && height > 0 && contentWidth > 0 && contentHeight > 0) {
        const scale = contentWidth / snapshot.width;
        frame = {
          left: left - contentLeft,
          top: top - contentTop,
          width,
          height,
          camera: {
            centerX: ((left + right) / 2 - contentLeft) / scale,
            centerY: ((top + bottom) / 2 - contentTop) / scale,
            zoom: scale,
            viewportWidth: width,
            viewportHeight: height
          }
        };
      }
    }
    cameraFrame.current = frame;
    cameraListeners.current.forEach((listener) => listener(frame));
  }, [snapshot.width, snapshot.height]);

  const scheduleCameraFrame = useCallback(() => {
    if (cameraAnimationFrame.current !== null) return;
    if (typeof requestAnimationFrame === "undefined") {
      publishCameraFrame();
      return;
    }
    cameraAnimationFrame.current = requestAnimationFrame(publishCameraFrame);
  }, [publishCameraFrame]);

  const subscribeToCamera = useCallback((listener: (frame: FloorMapCameraFrame | null) => void) => {
    cameraListeners.current.add(listener);
    listener(cameraFrame.current);
    return () => cameraListeners.current.delete(listener);
  }, []);

  const overlayContext = useMemo<FloorMapViewportOverlay>(() => ({
    overlayRoot,
    getFrame: () => cameraFrame.current,
    subscribe: subscribeToCamera
  }), [overlayRoot, subscribeToCamera]);

  const commitZoom = useCallback(() => {
    if (zoomCommitTimer.current !== null) {
      window.clearTimeout(zoomCommitTimer.current);
      zoomCommitTimer.current = null;
    }
    const nextZoom = pendingZoom.current;
    pendingZoom.current = null;
    if (nextZoom === null) return;
    setZoom(current => current === nextZoom ? current : nextZoom);
    onZoomChangeRef.current?.(nextZoom);
  }, []);

  const scheduleZoomCommit = useCallback(() => {
    if (zoomCommitTimer.current !== null) window.clearTimeout(zoomCommitTimer.current);
    zoomCommitTimer.current = window.setTimeout(() => {
      zoomCommitTimer.current = null;
      commitZoom();
    }, 120);
  }, [commitZoom]);

  const applySurfaceZoom = useCallback((nextZoom: number) => {
    const metrics = mapMetrics.current;
    const width = metrics.width * metrics.fitScale * nextZoom;
    const height = metrics.height * metrics.fitScale * nextZoom;
    const viewport = viewportRef.current;
    const surface = surfaceRef.current;
    const stage = stageRef.current;
    if (surface) {
      surface.style.width = `${width}px`;
      surface.style.height = `${height}px`;
    }
    if (stage && viewport) {
      stage.style.width = `${Math.max(viewport.clientWidth, width + padding * 2)}px`;
      stage.style.height = `${Math.max(viewport.clientHeight, height + padding * 2)}px`;
    }
    if (viewport) viewport.dataset.zoom = String(nextZoom);
  }, []);

  const changeZoom = useCallback((nextZoom: number, anchor?: MapPoint, settle = false) => {
    const viewport = viewportRef.current;
    const fromZoom = zoomRef.current;
    const toZoom = clampMapZoom(nextZoom);
    if (toZoom === fromZoom) return;

    const viewportAnchor = anchor ?? {
      x: (viewport?.clientWidth ?? 0) / 2,
      y: (viewport?.clientHeight ?? 0) / 2
    };
    const viewportBounds = viewport?.getBoundingClientRect();
    const mapAnchor = mapPointFromClient({
      x: (viewportBounds?.left ?? 0) + viewportAnchor.x,
      y: (viewportBounds?.top ?? 0) + viewportAnchor.y
    });
    const startScroll = { x: viewport?.scrollLeft ?? 0, y: viewport?.scrollTop ?? 0 };
    zoomRef.current = toZoom;
    pendingZoom.current = toZoom;
    applySurfaceZoom(toZoom);
    scheduleMapAnchor({ viewport, mapAnchor, anchor: viewportAnchor, startScroll, fromZoom, toZoom });
    if (settle) commitZoom(); else scheduleZoomCommit();
  }, [applySurfaceZoom, commitZoom, scheduleZoomCommit]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const updateSize = () => setViewportSize({ width: viewport.clientWidth, height: viewport.clientHeight });
    updateSize();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", updateSize);
      return () => window.removeEventListener("resize", updateSize);
    }
    const observer = new ResizeObserver(updateSize);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    scheduleCameraFrame();
  }, [scheduleCameraFrame, snapshot.floorId, viewportSize, zoom]);

  useEffect(() => () => {
    if (cameraAnimationFrame.current !== null && typeof cancelAnimationFrame !== "undefined") {
      cancelAnimationFrame(cameraAnimationFrame.current);
    }
    // StrictMode replays setup after cleanup using the same refs. A cancelled
    // frame must not keep the next setup from scheduling the initial camera.
    cameraAnimationFrame.current = null;
    if (zoomCommitTimer.current !== null) window.clearTimeout(zoomCommitTimer.current);
    zoomCommitTimer.current = null;
    pendingZoom.current = null;
    cameraListeners.current.clear();
  }, []);

  useLayoutEffect(() => {
    zoomRef.current = 1;
    pendingZoom.current = null;
    setZoom(1);
    onZoomChangeRef.current?.(1);
    if (!viewportRef.current) return;
    viewportRef.current.scrollLeft = 0;
    viewportRef.current.scrollTop = 0;
  }, [snapshot.floorId, snapshot.mapDocument?.generationId]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // React 18 delegates wheel events through a passive root listener. A native non-passive
    // listener is required so map zoom does not also trigger the browser's Ctrl/Cmd+wheel zoom.
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const bounds = viewport.getBoundingClientRect();
      changeZoom(zoomRef.current * (event.deltaY > 0 ? 1 / 1.1 : 1.1), {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top
      });
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [changeZoom]);

  function mapPoint(event: ReactPointerEvent<HTMLDivElement>): MapPoint {
    return mapPointFromClient({ x: event.clientX, y: event.clientY });
  }

  function mapPointFromClient(client: MapPoint): MapPoint {
    const bounds = surfaceRef.current?.getBoundingClientRect();
    const metrics = mapMetrics.current;
    if (bounds && bounds.width > 0 && bounds.height > 0) {
      return mapPointFromSurface({
        client,
        surface: bounds,
        mapSize: { width: metrics.width, height: metrics.height }
      });
    }
    const scale = metrics.fitScale * zoomRef.current;
    return {
      x: (client.x - (bounds?.left ?? 0)) / scale,
      y: (client.y - (bounds?.top ?? 0)) / scale
    };
  }

  function scheduleMapAnchor(input: {
    viewport: HTMLDivElement | null;
    mapAnchor: MapPoint;
    anchor: MapPoint;
    startScroll: MapPoint;
    fromZoom: number;
    toZoom: number;
  }) {
    const applyAnchoredScroll = () => {
      const viewport = input.viewport;
      const surface = surfaceRef.current;
      if (!viewport) return;
      const surfaceBounds = surface?.getBoundingClientRect();
      const viewportBounds = viewport.getBoundingClientRect();
      if (surfaceBounds && surfaceBounds.width > 0 && surfaceBounds.height > 0) {
        const metrics = mapMetrics.current;
        const adjustment = scrollAdjustmentForMapAnchor({
          mapPoint: input.mapAnchor,
          mapSize: { width: metrics.width, height: metrics.height },
          surface: surfaceBounds,
          viewport: viewportBounds,
          anchor: input.anchor
        });
        viewport.scrollLeft += adjustment.x;
        viewport.scrollTop += adjustment.y;
        scheduleCameraFrame();
        return;
      }
      viewport.scrollLeft = anchoredScrollPosition({
        scroll: input.startScroll.x,
        anchor: input.anchor.x,
        fromZoom: input.fromZoom,
        toZoom: input.toZoom
      });
      viewport.scrollTop = anchoredScrollPosition({
        scroll: input.startScroll.y,
        anchor: input.anchor.y,
        fromZoom: input.fromZoom,
        toZoom: input.toZoom
      });
      scheduleCameraFrame();
    };
    if (typeof requestAnimationFrame === "undefined") applyAnchoredScroll();
    else requestAnimationFrame(applyAnchoredScroll);
  }

  function startPinch(event: ReactPointerEvent<HTMLDivElement>) {
    const pointers = [...activePointers.current.values()];
    if (pointers.length < 2) return;
    const [left, right] = pointers;
    const startDistance = pointerDistance(left, right);
    if (startDistance === 0) return;
    pan.current = null;
    area.current = null;
    setSelection(null);
    const midpoint = pointerMidpoint(left, right);
    pinch.current = {
      startDistance,
      startZoom: zoomRef.current,
      mapAnchor: mapPointFromClient(midpoint),
      startScroll: {
        x: event.currentTarget.scrollLeft,
        y: event.currentTarget.scrollTop
      }
    };
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button > 0) return;
    activePointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (activePointers.current.size >= 2) {
      capturePointer(event);
      startPinch(event);
      return;
    }

    // Marker buttons keep their click interaction; single-pointer gestures begin on empty map space.
    if ((event.target as Element).closest("button")) return;
    capturePointer(event);
    if (mode === "pan") {
      pan.current = {
        pointerId: event.pointerId,
        point: { x: event.clientX, y: event.clientY },
        scroll: { x: event.currentTarget.scrollLeft, y: event.currentTarget.scrollTop }
      };
    }
    if (mode === "area") {
      const start = mapPoint(event);
      area.current = { pointerId: event.pointerId, start };
      setSelection(normalizeSelectionRect(start, start));
    }
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    if (!activePointers.current.has(event.pointerId)) return;
    activePointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    const activePinch = pinch.current;
    if (activePinch && activePointers.current.size >= 2) {
      const [left, right] = activePointers.current.values();
      const toZoom = clampMapZoom(activePinch.startZoom * pointerDistance(left, right) / activePinch.startDistance);
      const viewport = event.currentTarget;
      const midpoint = pointerMidpoint(left, right);
      const bounds = viewport.getBoundingClientRect();
      zoomRef.current = toZoom;
      pendingZoom.current = toZoom;
      applySurfaceZoom(toZoom);
      scheduleMapAnchor({
        viewport,
        mapAnchor: activePinch.mapAnchor,
        // Keep the original map-space point while following both zoom and finger translation.
        anchor: { x: midpoint.x - bounds.left, y: midpoint.y - bounds.top },
        startScroll: activePinch.startScroll,
        fromZoom: activePinch.startZoom,
        toZoom
      });
      return;
    }

    const activePan = pan.current;
    if (activePan?.pointerId === event.pointerId) {
      event.currentTarget.scrollLeft = activePan.scroll.x - (event.clientX - activePan.point.x);
      event.currentTarget.scrollTop = activePan.scroll.y - (event.clientY - activePan.point.y);
      scheduleCameraFrame();
      return;
    }

    const activeArea = area.current;
    if (activeArea?.pointerId === event.pointerId) setSelection(normalizeSelectionRect(activeArea.start, mapPoint(event)));
  }

  function finishPointer(event: ReactPointerEvent<HTMLDivElement>, cancelled = false) {
    const activeArea = area.current;
    if (!cancelled && activeArea?.pointerId === event.pointerId && !pinch.current) {
      onAreaSelect?.(normalizeSelectionRect(activeArea.start, mapPoint(event)));
    }
    activePointers.current.delete(event.pointerId);
    pan.current = null;
    area.current = null;
    setSelection(null);
    if (pinch.current) {
      pinch.current = null;
      commitZoom();
      suppressNextClick.current = true;
      if (suppressClickTimeout.current !== null) window.clearTimeout(suppressClickTimeout.current);
      suppressClickTimeout.current = window.setTimeout(() => {
        suppressNextClick.current = false;
        suppressClickTimeout.current = null;
      }, 0);
      // A remaining touch remains tracked only for its eventual release; it must not inherit a pan origin.
      for (const [pointerId, point] of activePointers.current) activePointers.current.set(pointerId, { ...point });
    }
    releasePointer(event);
  }

  function capturePointer(event: ReactPointerEvent<HTMLDivElement>) {
    try {
      event.currentTarget.setPointerCapture?.(event.pointerId);
    } catch {
      // Browser-dispatched synthetic PointerEvents are not registered as active pointers.
      // Keep gesture state functional for browser regression coverage; native touches still capture.
    }
  }

  function releasePointer(event: ReactPointerEvent<HTMLDivElement>) {
    try {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    } catch {
      // Matches the synthetic capture fallback above; an uncaptured pointer has nothing to release.
    }
  }

  function handleClickCapture(event: React.MouseEvent<HTMLDivElement>) {
    if (!suppressNextClick.current) return;
    suppressNextClick.current = false;
    if (suppressClickTimeout.current !== null) window.clearTimeout(suppressClickTimeout.current);
    suppressClickTimeout.current = null;
    event.preventDefault();
    event.stopPropagation();
  }

  return (
    <FloorMapViewportOverlayContext.Provider value={overlayContext}>
    <div className="relative h-full min-h-0 min-w-0 overflow-hidden bg-surface-inset">
      <div
        ref={viewportRef}
        className="h-full min-h-0 w-full min-w-0 touch-none cursor-grab overflow-auto overscroll-contain bg-surface-inset focus-visible:outline-none focus-visible:shadow-focus active:cursor-grabbing"
        data-testid={viewportTestId}
        role="region"
        aria-label={ariaLabel}
        data-zoom={zoomRef.current}
        tabIndex={0}
        onClickCapture={handleClickCapture}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={(event) => finishPointer(event, true)}
        onScroll={scheduleCameraFrame}
      >
        <div ref={stageRef} className="grid min-h-full min-w-full place-items-center p-6" style={stageStyle}>
          <div ref={surfaceRef} className="relative h-auto w-full overflow-hidden rounded-panel border border-border-default bg-surface-panel shadow-none" style={surfaceStyle} data-floor-map-surface="">
            <div ref={setOverlayRoot} className="pointer-events-none absolute inset-0 z-0 overflow-hidden" data-floor-map-webgl-overlay="" aria-hidden="true" />
            {children}
            {selection ? (
              <div
                className="pointer-events-none absolute z-5 border border-border-focus bg-action-primary-soft"
                data-testid="map-area-selection"
                style={{
                  left: `${(selection.left / snapshot.width) * 100}%`,
                  top: `${(selection.top / snapshot.height) * 100}%`,
                  width: `${((selection.right - selection.left) / snapshot.width) * 100}%`,
                  height: `${((selection.bottom - selection.top) / snapshot.height) * 100}%`
                }}
              />
            ) : null}
          </div>
        </div>
      </div>
      {showControls ? (
        <div className="absolute right-3 bottom-3 z-6 flex items-center gap-1 rounded-control border border-border-default bg-surface-panel p-1 shadow-popover max-compact:right-2 max-compact:bottom-2" role="group" aria-label="지도 확대 축소">
          <IconButton type="button" variant="ghost" size="sm" className="max-compact:size-13" aria-label="지도 축소" disabled={zoom <= 0.1} onClick={() => changeZoom(zoomRef.current - 0.1, undefined, true)}><Minus size={16} aria-hidden="true" /></IconButton>
          <Button type="button" variant="ghost" size="sm" className="min-w-14 px-2 max-compact:min-h-13" aria-label={`지도 배율 ${Math.round(zoom * 100)}%`} onClick={() => changeZoom(1, undefined, true)}>{Math.round(zoom * 100)}%</Button>
          <IconButton type="button" variant="ghost" size="sm" className="max-compact:size-13" aria-label="지도 확대" disabled={zoom >= 4} onClick={() => changeZoom(zoomRef.current + 0.1, undefined, true)}><Plus size={16} aria-hidden="true" /></IconButton>
          <IconButton type="button" variant="ghost" size="sm" className="max-compact:size-13" aria-label="지도 화면 맞춤" onClick={() => changeZoom(1, undefined, true)}><Maximize size={16} aria-hidden="true" /></IconButton>
        </div>
      ) : null}
    </div>
    </FloorMapViewportOverlayContext.Provider>
  );
}

export type { MapInteractionMode, MapPoint, MapSelectionRect } from "./map-gestures";
