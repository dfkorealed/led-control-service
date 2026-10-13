import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useFloorMapSnapshot } from "../../../api/queries";
import { Button, Text } from "../../../components/ui";
import { MapLoadingHost, MapLoadingOverlay } from "../../../components/ui/MapLoadingOverlay";
import { FloorMapViewport, type FloorMapViewportHandle } from "../../floor-map/FloorMapViewport";
import { FloorScene } from "../../floor-map/FloorScene";

interface FloorPlanPreviewProps {
  floorId: string;
  siteId: string;
  floorName: string;
  active: boolean;
}

export function FloorPlanPreview({ floorId, siteId, floorName, active }: FloorPlanPreviewProps) {
  // Disabled observers retain React Query's scoped cache, without acquiring editor state or a lease.
  const snapshot = useFloorMapSnapshot(active ? floorId : undefined, siteId);
  const viewport = useRef<FloorMapViewportHandle>(null);
  const fitted = useRef<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [loadingRoot, setLoadingRoot] = useState<HTMLDivElement | null>(null);
  const identity = `${floorId}:${snapshot.data?.revision}:${attempt}`;
  const fit = useCallback(() => {
    if (fitted.current === identity) return;
    fitted.current = identity;
    viewport.current?.fit();
  }, [identity]);
  useEffect(() => { if (!active) fitted.current = null; }, [active]);
  const unobserved = useMemo(() => new Set(snapshot.data?.fixtures?.map(fixture => fixture.id) ?? []), [snapshot.data]);
  if (!active) return <div className="grid h-44 place-items-center bg-surface-inset"><Text tone="secondary" variant="body-sm">화면에 표시되면 미리보기를 불러옵니다.</Text></div>;
  return <div className="grid gap-2">
    <MapLoadingHost container={loadingRoot}>
    <div className="relative h-44 overflow-hidden rounded-control bg-surface-inset">
      <div role="img" aria-label={`${floorName} 도면 미리보기`} className="h-44">
      {snapshot.data ? <div {...{ inert: "" }} aria-hidden="true" className="h-full" key={attempt}>
        <FloorMapViewport ref={viewport} snapshot={snapshot.data} ariaLabel={`${floorName} 도면`} showControls={false} maintainCameraOnResize onCameraReady={fit}>
          {/* The snapshot has placement, not telemetry: never invent online/offline colors. */}
          <FloorScene snapshot={snapshot.data} fixtures={[]} interactive={false} unobservedFixtureIds={unobserved} />
        </FloorMapViewport>
      </div> : snapshot.error ? <div className="grid h-full place-items-center p-3"><Text variant="body-sm" tone="danger">도면 미리보기를 불러오지 못했습니다.</Text></div> : null}
      </div>
      <MapLoadingOverlay loading={!snapshot.data && !snapshot.error} />
      <div ref={setLoadingRoot} className="absolute inset-0 z-20" />
    </div>
    </MapLoadingHost>
    {snapshot.error ? <Text role="alert" tone="danger" variant="body-sm">도면 조회 오류가 발생했습니다.</Text> : null}
    <Button size="sm" variant="ghost" onClick={() => { fitted.current = null; setAttempt(value => value + 1); void snapshot.refetch(); }} aria-label={`${floorName} 미리보기 다시 불러오기`}>미리보기 다시 불러오기</Button>
  </div>;
}
