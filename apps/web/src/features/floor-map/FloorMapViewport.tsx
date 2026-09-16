import type { FloorMapSnapshot } from "@led-control/shared";
import { Maximize, Minus, Plus } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
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
  anchor: MapPoint;
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
  const surfaceRef = useRef<HTMLDivElement>(null);
  const activePointers = useRef(new Map<number, MapPoint>());
  const pan = useRef<PanGesture | null>(null);
  const area = useRef<AreaGesture | null>(null);
  const pinch = useRef<PinchGesture | null>(null);
  const zoomRef = useRef(1);
  const onZoomChangeRef = useRef(onZoomChange);
  const suppressNextClick = useRef(false);
  const suppressClickTimeout = useRef<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [selection, setSelection] = useState<MapSelectionRect | null>(null);
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
  const renderedWidth = snapshot.width * fitScale * zoom;
  const renderedHeight = snapshot.height * fitScale * zoom;
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

  const changeZoom = useCallback((nextZoom: number, anchor?: MapPoint) => {
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
    setZoom(toZoom);
    onZoomChangeRef.current?.(toZoom);
    scheduleMapAnchor({ viewport, mapAnchor, anchor: viewportAnchor, startScroll, fromZoom, toZoom });
  }, []);

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
    zoomRef.current = 1;
    setZoom(1);
    onZoomChangeRef.current?.(1);
    if (!viewportRef.current) return;
    viewportRef.current.scrollLeft = 0;
    viewportRef.current.scrollTop = 0;
  }, [snapshot.floorId]);

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
    const viewportBounds = event.currentTarget.getBoundingClientRect();
    pinch.current = {
      startDistance,
      startZoom: zoomRef.current,
      anchor: { x: midpoint.x - viewportBounds.left, y: midpoint.y - viewportBounds.top },
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
    event.currentTarget.setPointerCapture?.(event.pointerId);

    if (activePointers.current.size >= 2) {
      startPinch(event);
      return;
    }

    // Marker buttons keep their click interaction; single-pointer gestures begin on empty map space.
    if ((event.target as Element).closest("button")) return;
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
      zoomRef.current = toZoom;
      setZoom(toZoom);
      onZoomChangeRef.current?.(toZoom);
      scheduleMapAnchor({
        viewport,
        mapAnchor: activePinch.mapAnchor,
        anchor: activePinch.anchor,
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
      suppressNextClick.current = true;
      if (suppressClickTimeout.current !== null) window.clearTimeout(suppressClickTimeout.current);
      suppressClickTimeout.current = window.setTimeout(() => {
        suppressNextClick.current = false;
        suppressClickTimeout.current = null;
      }, 0);
      // A remaining touch remains tracked only for its eventual release; it must not inherit a pan origin.
      for (const [pointerId, point] of activePointers.current) activePointers.current.set(pointerId, { ...point });
    }
    event.currentTarget.releasePointerCapture?.(event.pointerId);
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
    <div className="relative h-full min-h-0 min-w-0 overflow-hidden bg-surface-inset">
      <div
        ref={viewportRef}
        className="h-full min-h-0 w-full min-w-0 touch-none cursor-grab overflow-auto overscroll-contain bg-surface-inset focus-visible:outline-none focus-visible:shadow-focus active:cursor-grabbing"
        data-testid={viewportTestId}
        role="region"
        aria-label={ariaLabel}
        data-zoom={zoom}
        tabIndex={0}
        onClickCapture={handleClickCapture}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointer}
        onPointerCancel={(event) => finishPointer(event, true)}
      >
        <div className="grid min-h-full min-w-full place-items-center p-6" style={stageStyle}>
          <div ref={surfaceRef} className="relative h-auto w-full overflow-hidden rounded-panel border border-border-default bg-surface-panel shadow-none" style={surfaceStyle} data-floor-map-surface="">
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
          <IconButton type="button" variant="ghost" size="sm" className="max-compact:size-13" aria-label="지도 축소" disabled={zoom <= 0.1} onClick={() => changeZoom(zoomRef.current - 0.1)}><Minus size={16} aria-hidden="true" /></IconButton>
          <Button type="button" variant="ghost" size="sm" className="min-w-14 px-2 max-compact:min-h-13" aria-label={`지도 배율 ${Math.round(zoom * 100)}%`} onClick={() => changeZoom(1)}>{Math.round(zoom * 100)}%</Button>
          <IconButton type="button" variant="ghost" size="sm" className="max-compact:size-13" aria-label="지도 확대" disabled={zoom >= 4} onClick={() => changeZoom(zoomRef.current + 0.1)}><Plus size={16} aria-hidden="true" /></IconButton>
          <IconButton type="button" variant="ghost" size="sm" className="max-compact:size-13" aria-label="지도 화면 맞춤" onClick={() => changeZoom(1)}><Maximize size={16} aria-hidden="true" /></IconButton>
        </div>
      ) : null}
    </div>
  );
}

export type { MapInteractionMode, MapPoint, MapSelectionRect } from "./map-gestures";
