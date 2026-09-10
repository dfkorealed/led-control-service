import type { FloorMapSnapshot } from "@led-control/shared";
import { CircleCheck, CircleX, Clock3, Hand, Maximize, Minus, Plus, TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import { Dashboard } from "../../api/queries";
import { FloorScene } from "../floor-map/FloorScene";

interface FloorMapProps {
  floor: Dashboard["floors"][number];
  snapshot: FloorMapSnapshot;
  selectedFixtureId: string | null;
  onSelectFixture: (fixtureId: string) => void;
}

export function FloorMap({ floor, snapshot, selectedFixtureId, onSelectFixture }: FloorMapProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; x: number; y: number; left: number; top: number } | null>(null);
  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [zoom, setZoom] = useState(1);
  const padding = 24;
  const hasViewportSize = viewportSize.width > 0 && viewportSize.height > 0;
  const fitScale = hasViewportSize
    ? Math.min(
        Math.max(1, viewportSize.width - padding * 2) / snapshot.width,
        Math.max(1, viewportSize.height - padding * 2) / snapshot.height
      )
    : 1;
  const renderedWidth = snapshot.width * fitScale * zoom;
  const renderedHeight = snapshot.height * fitScale * zoom;
  const mapStyle = {
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
    setZoom(1);
    if (!viewportRef.current) return;
    viewportRef.current.scrollLeft = 0;
    viewportRef.current.scrollTop = 0;
  }, [snapshot.floorId]);

  const changeZoom = useCallback((nextZoom: number, anchor?: { x: number; y: number }) => {
    const viewport = viewportRef.current;
    const boundedZoom = Math.round(Math.min(4, Math.max(0.1, nextZoom)) * 10) / 10;
    if (boundedZoom === zoom) return;
    const anchorX = anchor?.x ?? (viewport?.clientWidth ?? 0) / 2;
    const anchorY = anchor?.y ?? (viewport?.clientHeight ?? 0) / 2;
    const contentX = ((viewport?.scrollLeft ?? 0) + anchorX) / zoom;
    const contentY = ((viewport?.scrollTop ?? 0) + anchorY) / zoom;
    setZoom(boundedZoom);
    requestAnimationFrame(() => {
      if (!viewport) return;
      viewport.scrollLeft = contentX * boundedZoom - anchorX;
      viewport.scrollTop = contentY * boundedZoom - anchorY;
    });
  }, [zoom]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    // React 18 delegates wheel events through a passive root listener. A native non-passive
    // listener is required so map zoom does not also trigger the browser's Ctrl/Cmd+wheel zoom.
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const bounds = viewport.getBoundingClientRect();
      changeZoom(zoom * (event.deltaY > 0 ? 1 / 1.1 : 1.1), {
        x: event.clientX - bounds.left,
        y: event.clientY - bounds.top
      });
    };
    viewport.addEventListener("wheel", handleWheel, { passive: false });
    return () => viewport.removeEventListener("wheel", handleWheel);
  }, [changeZoom, zoom]);

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    // Marker buttons keep their click interaction; dragging begins only on empty map space.
    if (event.button > 0 || (event.target as Element).closest("button")) return;
    dragRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      left: event.currentTarget.scrollLeft,
      top: event.currentTarget.scrollTop
    };
    event.currentTarget.setPointerCapture?.(event.pointerId);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    event.currentTarget.scrollLeft = drag.left - (event.clientX - drag.x);
    event.currentTarget.scrollTop = drag.top - (event.clientY - drag.y);
  }

  function finishPointerDrag(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    event.currentTarget.releasePointerCapture?.(event.pointerId);
  }

  return (
    <div className="monitoring-map-shell" role="region" aria-label="층 도면" data-zoom={zoom}>
      <div
        ref={viewportRef}
        className="monitoring-map-viewport"
        data-testid="monitoring-map-viewport"
        tabIndex={0}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={finishPointerDrag}
        onPointerCancel={finishPointerDrag}
        aria-label="상하좌우로 이동하고 확대 축소할 수 있는 지도"
      >
        <div className="monitoring-map-stage" style={stageStyle}>
          <div className="floor-map monitoring-map-card" style={mapStyle}>
            <FloorScene
              snapshot={snapshot}
              fixtures={floor.fixtures}
              interactive={false}
              floorName={floor.name}
              selectedFixtureId={selectedFixtureId}
              onSelectFixture={onSelectFixture}
            />
          </div>
        </div>
      </div>
      <ul className="floor-map-legend" aria-label="조명 상태 범례">
        <li><CircleCheck size={14} aria-hidden="true" /><span>정상</span></li>
        <li><TriangleAlert size={14} aria-hidden="true" /><span>장애</span></li>
        <li><CircleX size={14} aria-hidden="true" /><span>오프라인</span></li>
        <li><Clock3 size={14} aria-hidden="true" /><span>상태 확인 대기</span></li>
      </ul>
      <span className="monitoring-map-pan-hint"><Hand size={14} aria-hidden="true" />드래그 또는 스크롤로 이동</span>
      <div className="monitoring-map-zoom-controls" role="group" aria-label="지도 확대 축소">
        <button type="button" aria-label="지도 축소" disabled={zoom <= 0.1} onClick={() => changeZoom(zoom - 0.1)}><Minus size={16} aria-hidden="true" /></button>
        <button type="button" aria-label={`지도 배율 ${Math.round(zoom * 100)}%`} onClick={() => changeZoom(1)}>{Math.round(zoom * 100)}%</button>
        <button type="button" aria-label="지도 확대" disabled={zoom >= 4} onClick={() => changeZoom(zoom + 0.1)}><Plus size={16} aria-hidden="true" /></button>
        <button type="button" aria-label="지도 화면 맞춤" onClick={() => changeZoom(1)}><Maximize size={16} aria-hidden="true" /></button>
      </div>
    </div>
  );
}
