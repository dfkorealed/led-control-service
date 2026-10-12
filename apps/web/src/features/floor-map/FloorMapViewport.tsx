import type { FloorMapSnapshot } from "@led-control/shared";
import { Maximize, Minus, Plus } from "lucide-react";
import {
  createContext,
  forwardRef,
  useImperativeHandle,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEventHandler,
  type PointerEvent as ReactPointerEvent,
  type ReactNode
} from "react";
import { Button, IconButton, cn } from "../../components/ui";
import {
  MAP_DRAG_THRESHOLD_PX, MAP_LONG_PRESS_MS,
  type MapInteractionPolicy,
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
import { cameraFromBounds, isMapViewportCamera, type MapViewportCamera } from "./map-camera";
import { cameraFromTransform, screenToMapWorld } from "./map-camera-geometry";

export interface FloorMapViewportHandle {
  getCamera(): MapViewportCamera | null;
  restoreCamera(camera: MapViewportCamera): void;
  centerOn(point: MapPoint): void;
  fit(): void;
}

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

export interface FloorMapViewportProps {
  snapshot: FloorMapSnapshot;
  ariaLabel: string;
  mode?: MapInteractionMode;
  interactionPolicy?: MapInteractionPolicy;
  toolModePolicy?: "interaction-default" | "explicit" | "manual-cad";
  children: ReactNode;
  onAreaSelect?: (rect: MapSelectionRect) => void;
  showControls?: boolean;
  controlsPlacement?: "overlay" | "footer";
  footerStart?: ReactNode;
  /** Opt-in manual mobile chrome; geometry/gesture defaults are unchanged. */
  compactChrome?: boolean;
  wheelZoomWithoutModifier?: boolean;
  showFitControl?: boolean;
  resetControlFits?: boolean;
  controlAfterZoom?: ReactNode;
  onZoomChange?: (zoom: number) => void;
  viewportTestId?: string;
  onViewportKeyDown?: KeyboardEventHandler<HTMLDivElement>;
  maintainCameraOnResize?: boolean;
  onCameraSettled?: (camera: MapViewportCamera) => void;
  onCameraReady?: () => void;
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

export const FloorMapViewport = forwardRef<FloorMapViewportHandle, FloorMapViewportProps>(function FloorMapViewport({
  snapshot,
  ariaLabel,
  mode = "pan",
  interactionPolicy = "pan",
  toolModePolicy = "interaction-default",
  children,
  onAreaSelect,
  showControls = true,
  controlsPlacement = "overlay",
  footerStart,
  compactChrome = false,
  wheelZoomWithoutModifier = false,
  showFitControl = true,
  resetControlFits = false,
  controlAfterZoom,
  onZoomChange,
  viewportTestId,
  onViewportKeyDown,
  maintainCameraOnResize = false,
  onCameraSettled,
  onCameraReady
}, forwardedRef) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const activePointers = useRef(new Map<number, MapPoint>());
  const pan = useRef<PanGesture | null>(null);
  const area = useRef<AreaGesture | null>(null);
  const pinch = useRef<PinchGesture | null>(null);
  const candidate = useRef<{ pointerId: number; start: MapPoint; mapStart: MapPoint; scroll: MapPoint; kind: "area" | "pan" | "hold" | "marker"; moved: boolean } | null>(null);
  const holdTimer = useRef<number | null>(null);
  const spacePressed = useRef(false);
  const zoomRef = useRef(1);
  const onZoomChangeRef = useRef(onZoomChange);
  const suppressNextClick = useRef(false);
  const suppressClickTimeout = useRef<number | null>(null);
  const cameraFrame = useRef<FloorMapCameraFrame | null>(null);
  const cameraListeners = useRef(new Set<(frame: FloorMapCameraFrame | null) => void>());
  const cameraAnimationFrame = useRef<number | null>(null);
  const zoomCommitTimer = useRef<number | null>(null);
  const pendingZoom = useRef<number | null>(null);
  const lastLogicalCamera = useRef<MapViewportCamera | null>(null);
  const resizeCamera = useRef<MapViewportCamera | null>(null);
  const anchorFrames = useRef(new Set<number>());
  const callbacks = useRef({ onCameraSettled, onCameraReady, maintainCameraOnResize });
  callbacks.current = { onCameraSettled, onCameraReady, maintainCameraOnResize };
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

  const getCamera = useCallback(() => {
    const viewport = viewportRef.current;
    const surface = surfaceRef.current;
    if (!viewport || !surface) return null;
    const bounds = surface.getBoundingClientRect();
    return cameraFromBounds(viewport.getBoundingClientRect(), {
      left: bounds.left + surface.clientLeft, top: bounds.top + surface.clientTop,
      width: bounds.width - 2 * surface.clientLeft, height: bounds.height - 2 * surface.clientTop
    }, zoomRef.current);
  }, []);

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
        // The measured content scale already includes fitScale * relative zoom,
        // excluding the border. The overlay camera uses the clipped screen origin.
        const scale = contentWidth / snapshot.width;
        const camera = cameraFromTransform({ pan: { x: contentLeft - left, y: contentTop - top }, zoom: scale }, { width, height });
        if (camera) frame = {
          left: left - contentLeft,
          top: top - contentTop,
          width,
          height,
          camera
        };
      }
    }
    cameraFrame.current = frame;
    cameraListeners.current.forEach((listener) => listener(frame));
    const logical = getCamera();
    if (logical) {
      lastLogicalCamera.current = logical;
      callbacks.current.onCameraSettled?.(logical);
    }
  }, [snapshot.width, snapshot.height, getCamera]);

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

  function centerOn(point: MapPoint) {
    const viewport = viewportRef.current;
    if (!viewport || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return;
    scheduleMapAnchor({
      viewport, mapAnchor: point,
      anchor: { x: viewport.clientWidth / 2, y: viewport.clientHeight / 2 },
      startScroll: { x: viewport.scrollLeft, y: viewport.scrollTop },
      fromZoom: zoomRef.current, toZoom: zoomRef.current
    });
  }
  function restoreCamera(camera: MapViewportCamera) {
    if (!isMapViewportCamera(camera)) return;
    // An explicit fit/restore takes precedence before its next camera frame
    // publishes: resize must not restore the previous settled camera instead.
    lastLogicalCamera.current = { ...camera };
    resizeCamera.current = null;
    zoomRef.current = camera.zoom;
    pendingZoom.current = camera.zoom;
    applySurfaceZoom(camera.zoom);
    commitZoom();
    centerOn({ x: camera.centerXRatio * snapshot.width, y: camera.centerYRatio * snapshot.height });
  }
  function fit() {
    restoreCamera({ centerXRatio: .5, centerYRatio: .5, zoom: 1 });
  }
  useImperativeHandle(forwardedRef, () => ({ getCamera, restoreCamera, centerOn, fit }));

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const updateSize = () => setViewportSize(current => {
      const next = { width: viewport.clientWidth, height: viewport.clientHeight };
      if (current.width === next.width && current.height === next.height) return current;
      if (callbacks.current.maintainCameraOnResize) resizeCamera.current = lastLogicalCamera.current;
      return next;
    });
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
    anchorFrames.current.forEach(id => cancelAnimationFrame(id));
    anchorFrames.current.clear();
    zoomRef.current = 1;
    lastLogicalCamera.current = null;
    resizeCamera.current = null;
    pendingZoom.current = null;
    setZoom(1);
    onZoomChangeRef.current?.(1);
    if (!viewportRef.current) return;
    viewportRef.current.scrollLeft = 0;
    viewportRef.current.scrollTop = 0;
  }, [snapshot.floorId, snapshot.mapDocument?.generationId]);

  useLayoutEffect(() => {
    if (resizeCamera.current) {
      const camera = resizeCamera.current;
      resizeCamera.current = null;
      restoreCamera(camera);
    }
    if (hasViewportSize) callbacks.current.onCameraReady?.();
    scheduleCameraFrame();
  }, [scheduleCameraFrame, snapshot.floorId, snapshot.mapDocument?.generationId, viewportSize, zoom, onCameraReady]);

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
    anchorFrames.current.forEach(id => cancelAnimationFrame(id));
    anchorFrames.current.clear();
    cameraListeners.current.clear();
  }, []);


  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // React 18 delegates wheel events through a passive root listener. A native non-passive
    // listener is required so map zoom does not also trigger the browser's Ctrl/Cmd+wheel zoom.
    const handleWheel = (event: WheelEvent) => {
      if (!wheelZoomWithoutModifier && !event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      // A horizontal-only trackpad gesture must not pan or change map scale.
      if (event.deltaY === 0) return;
      const bounds = viewport.getBoundingClientRect();
      changeZoom(zoomRef.current * (event.deltaY > 0 ? 1 / 1.1 : 1.1), {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top
      });
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [changeZoom, wheelZoomWithoutModifier]);

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
    return screenToMapWorld(client, { pan: { x: bounds?.left ?? 0, y: bounds?.top ?? 0 }, zoom: scale });
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
    else {
      const id = requestAnimationFrame(() => {
        anchorFrames.current.delete(id);
        applyAnchoredScroll();
      });
      anchorFrames.current.add(id);
    }
  }

  function clearHold() {
    if (holdTimer.current !== null) window.clearTimeout(holdTimer.current);
    holdTimer.current = null;
  }

  function cancelGesture() {
    clearHold();
    if (candidate.current || activePointers.current.size || area.current || pinch.current) suppressNextClick.current = true;
    candidate.current = null; pan.current = null; area.current = null;
    if (pinch.current) { pinch.current = null; commitZoom(); }
    activePointers.current.clear(); spacePressed.current = false; setSelection(null);
  }

  useEffect(() => {
    window.addEventListener("blur", cancelGesture);
    return () => { window.removeEventListener("blur", cancelGesture); cancelGesture(); };
  }, [interactionPolicy, toolModePolicy, mode, snapshot.floorId]);

  function startPinch(event: ReactPointerEvent<HTMLDivElement>) {
    const pointers = [...activePointers.current.values()];
    if (pointers.length < 2) return;
    const [left, right] = pointers;
    clearHold(); candidate.current = null;
    const startDistance = pointerDistance(left, right);
    if (startDistance === 0) { cancelGesture(); return; }
    pan.current = null;
    area.current = null;
    setSelection(null);
    suppressNextClick.current = true;
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
    if (event.button > 0 && !((interactionPolicy === "direct-selection" || toolModePolicy === "manual-cad") && event.button === 1)) return;
    if (activePointers.current.size === 0) suppressNextClick.current = false;
    activePointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY });

    if (activePointers.current.size >= 2) {
      capturePointer(event);
      startPinch(event);
      return;
    }

    if (toolModePolicy === "manual-cad") {
      const kind = event.pointerType === "touch" || spacePressed.current || event.button === 1 ? "pan"
        : interactionPolicy === "direct-selection" ? "area" : "marker";
      if (event.button === 1) event.preventDefault();
      candidate.current = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, mapStart: mapPoint(event),
        scroll: { x: event.currentTarget.scrollLeft, y: event.currentTarget.scrollTop }, kind, moved: false };
      // Early capture would retarget pointerup and lose native FloorScene taps.
      // Marker gestures capture only after crossing the drag threshold.
      if (!(event.target as Element).closest("[data-spatial-map-marker]")) capturePointer(event);
      return;
    }
    // Marker buttons keep their click interaction; single-pointer gestures begin on empty map space.
    if ((event.target as Element).closest("button") && !(toolModePolicy === "explicit" && mode === "pan")) {
      // A moved touch that began on a pin is no longer a tap. It cannot become
      // an area selection or activate the pin through a synthesized click.
      if (interactionPolicy === "direct-selection" && event.pointerType === "touch" && (event.target as Element).closest("[data-spatial-map-marker]")) {
        candidate.current = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, mapStart: mapPoint(event),
          scroll: { x: event.currentTarget.scrollLeft, y: event.currentTarget.scrollTop }, kind: "marker", moved: false };
      }
      return;
    }
    capturePointer(event);
    if (interactionPolicy === "direct-selection") {
      // Explicit tools belong only to opt-in manual workspaces. Default direct
      // selection still uses drag/hold area and Space/middle-button navigation.
      const kind = toolModePolicy === "explicit"
        ? spacePressed.current || event.button === 1 || mode === "pan" ? "pan"
          : mode === "area" ? event.pointerType === "touch" ? "hold" : "area" : "marker"
        : event.pointerType === "touch" ? "hold" : spacePressed.current || event.button === 1 ? "pan" : "area";
      if (event.button === 1) event.preventDefault();
      candidate.current = { pointerId: event.pointerId, start: { x: event.clientX, y: event.clientY }, mapStart: mapPoint(event),
        scroll: { x: event.currentTarget.scrollLeft, y: event.currentTarget.scrollTop }, kind, moved: false };
      if (kind === "hold") holdTimer.current = window.setTimeout(() => {
        holdTimer.current = null;
        const current = candidate.current;
        if (!current || current.moved || activePointers.current.size !== 1) return;
        current.kind = "area";
        area.current = { pointerId: current.pointerId, start: current.mapStart };
        setSelection(normalizeSelectionRect(current.mapStart, current.mapStart));
        suppressNextClick.current = true;
      }, MAP_LONG_PRESS_MS);
      return;
    }
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

    const current = candidate.current;
    if (current?.pointerId === event.pointerId && !current.moved && pointerDistance(current.start, { x: event.clientX, y: event.clientY }) >= MAP_DRAG_THRESHOLD_PX) {
      current.moved = true; clearHold(); suppressNextClick.current = true;
      if (toolModePolicy === "manual-cad") capturePointer(event);
      if (current.kind === "hold") current.kind = "pan";
      if (current.kind === "pan") pan.current = { pointerId: event.pointerId, point: current.start, scroll: current.scroll };
      else if (current.kind === "area") area.current = { pointerId: event.pointerId, start: current.mapStart };
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
    if (cancelled) { cancelGesture(); releasePointer(event); return; }
    if (!cancelled && activeArea?.pointerId === event.pointerId && !pinch.current && (interactionPolicy !== "direct-selection" || candidate.current?.moved)) {
      onAreaSelect?.(normalizeSelectionRect(activeArea.start, mapPoint(event)));
    }
    clearHold(); candidate.current = null;
    activePointers.current.delete(event.pointerId);
    pan.current = null;
    area.current = null;
    setSelection(null);
    if (pinch.current) {
      pinch.current = null;
      commitZoom();
      suppressNextClick.current = true;
      if (suppressClickTimeout.current !== null) window.clearTimeout(suppressClickTimeout.current);
      if (interactionPolicy !== "direct-selection") suppressClickTimeout.current = window.setTimeout(() => {
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
    // Keyboard/assistive activation must not consume stale pointer suppression.
    if (toolModePolicy === "manual-cad" && event.detail === 0) return;
    if (toolModePolicy === "explicit" && mode !== "select" && (event.target as Element).closest("[data-spatial-map-marker]")) {
      event.preventDefault(); event.stopPropagation(); return;
    }
    if (!suppressNextClick.current) return;
    suppressNextClick.current = false;
    if (suppressClickTimeout.current !== null) window.clearTimeout(suppressClickTimeout.current);
    suppressClickTimeout.current = null;
    event.preventDefault();
    event.stopPropagation();
  }

  // Only an explicit footer slot opts in; overlay and existing footer callers
  // retain their placement. The viewport/renderer subtree never changes owner.
  const combinedFooter = controlsPlacement === "footer" && footerStart != null;
  // A rounded 44px frame has no continuous 44x44 hit square. The opt-in
  // camera chrome uses the existing 52px coarse frame without consuming a
  // map flow row; default/editor callers retain their original classes.
  const compactCameraIconClassName = "size-13 min-h-13!";
  const cameraControls = showControls ? (
    <div className={cn("flex items-center", compactChrome ? "gap-0" : "gap-1", combinedFooter ? "ml-auto shrink-0" : "rounded-control border border-border-default bg-surface-panel p-1", !combinedFooter && (controlsPlacement === "footer" ? "m-2 shrink-0 self-end" : "absolute right-3 bottom-3 z-6 shadow-popover max-compact:right-2 max-compact:bottom-2"))} role="group" aria-label={controlAfterZoom ? "지도 조작" : "지도 확대 축소"}>
      <IconButton type="button" variant="ghost" size="sm" className={compactChrome ? compactCameraIconClassName : "max-compact:size-13"} aria-label="지도 축소" disabled={zoom <= 0.1} onClick={() => changeZoom(zoomRef.current - 0.1, undefined, true)}><Minus size={16} aria-hidden="true" /></IconButton>
      <Button type="button" variant="ghost" size="sm" className={compactChrome ? "min-h-13! min-w-13 px-1" : "min-w-14 px-2 max-compact:min-h-13"} aria-label={`지도 배율 ${Math.round(zoom * 100)}%`} aria-description={resetControlFits ? "누르면 지도 가운데 100%로 재설정" : "누르면 100%로 재설정"} title={resetControlFits ? "가운데 100%로 재설정" : "100%로 재설정"} onClick={() => resetControlFits ? fit() : changeZoom(1, undefined, true)}>{Math.round(zoom * 100)}%</Button>
      <IconButton type="button" variant="ghost" size="sm" className={compactChrome ? compactCameraIconClassName : "max-compact:size-13"} aria-label="지도 확대" disabled={zoom >= 4} onClick={() => changeZoom(zoomRef.current + 0.1, undefined, true)}><Plus size={16} aria-hidden="true" /></IconButton>
      {controlAfterZoom}
      {showFitControl ? <IconButton type="button" variant="ghost" size="sm" className={compactChrome ? compactCameraIconClassName : "max-compact:size-13"} aria-label="지도 화면 맞춤" onClick={fit}><Maximize size={16} aria-hidden="true" /></IconButton> : null}
    </div>
  ) : null;

  return (
    <FloorMapViewportOverlayContext.Provider value={overlayContext}>
    <div className={cn("relative h-full min-h-0 min-w-0 overflow-hidden bg-surface-inset", controlsPlacement === "footer" && `flex ${compactChrome ? "min-h-0" : "min-h-min"} flex-col`)}>
      <div
        ref={viewportRef}
        className={cn("h-full min-h-0 w-full min-w-0 touch-none cursor-grab overflow-auto overscroll-contain bg-surface-inset focus-visible:outline-none focus-visible:shadow-focus active:cursor-grabbing", controlsPlacement === "footer" && `${compactChrome ? "min-h-0" : "min-h-[240px]"} flex-1 [contain:size]`)}
        data-testid={viewportTestId}
        onKeyDown={event => {
          if (event.target === event.currentTarget) {
            if (event.key === "Escape") cancelGesture();
            if ((interactionPolicy === "direct-selection" || toolModePolicy === "manual-cad") && event.key === " ") { spacePressed.current = true; event.preventDefault(); }
          }
          onViewportKeyDown?.(event);
        }}
        onKeyUp={event => { if (event.target === event.currentTarget && event.key === " ") spacePressed.current = false; }}
        onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) cancelGesture(); }}
        onLostPointerCapture={event => { if (activePointers.current.has(event.pointerId)) cancelGesture(); }}
        role="region"
        aria-label={ariaLabel}
        data-zoom={zoomRef.current}
        tabIndex={0}
        onClickCapture={handleClickCapture}
        onPointerDownCapture={event => {
          // Space navigation begins before FloorScene's physical marker owner.
          // It must not leave that owner with an unfinished selectable press.
          if (toolModePolicy === "manual-cad" && spacePressed.current && event.pointerType !== "touch") {
            handlePointerDown(event);
            event.stopPropagation();
          }
        }}
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
      {combinedFooter ? <div data-floor-map-footer="" className={cn("flex min-w-0 shrink-0 items-center justify-between border-t border-border-default bg-surface-panel", compactChrome ? "gap-1 px-1 py-1" : "flex-wrap gap-2 px-3.5 py-2.5")}>
        <div className="min-w-0">{footerStart}</div>{cameraControls}
      </div> : cameraControls}
    </div>
    </FloorMapViewportOverlayContext.Provider>
  );
});

export type { MapInteractionMode, MapInteractionPolicy, MapPoint, MapSelectionRect } from "./map-gestures";
