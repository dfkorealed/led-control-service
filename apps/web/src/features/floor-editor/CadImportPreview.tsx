import { TriangleAlert } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Image as KonvaImage, Layer, Stage } from "react-konva";
import { Button, FeedbackState } from "../../components/ui";
import { MapLoadingOverlay, useMapPaintLoading } from "../../components/ui/MapLoadingOverlay";
import { fitMapTransform } from "../floor-map/map-camera-geometry";
import { CadImportSceneCanvas, useCadImportScene } from "./CadImportSceneCanvas";
import type { CadImportReviewState } from "./editor-types";
import { useFloorPlanImage } from "./use-floor-plan-image";

const FIT_VIEWPORT_PADDING = 24;

interface CadImportPreviewProps {
  floorId: string;
  review: CadImportReviewState;
  onReadyChange: (ready: boolean) => void;
}

export function CadImportPreview({ floorId, review, onReadyChange }: CadImportPreviewProps) {
  const container = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const [attempt, setAttempt] = useState(0);
  const native = review.scene?.kind !== "legacy";
  const scene = useCadImportScene(floorId, native ? review : null);
  const image = useFloorPlanImage(native ? "" : review.job.renderedAssetPath ?? "");
  const identity = JSON.stringify([floorId, review.job.jobId, review.job.updatedAt,
    scene.data?.generationId, scene.data?.revision, review.job.renderedAssetPath, attempt]);
  const token = useMemo(() => ({ identity }), [identity]);
  const current = useRef(token); current.current = token;
  const [nativeDisplay, setNativeDisplay] = useState<{ token: typeof token; state: "loading" | "ready" | "error" } | null>(null);
  const legacyPaint = useMapPaintLoading(identity);
  const bounds = native ? scene.data : review.job.renderedViewport;
  const transform = useMemo(() => bounds ? fitMapTransform({
    bounds: { left: 0, top: 0, width: bounds.width, height: bounds.height }, viewport,
    padding: FIT_VIEWPORT_PADDING, minZoom: 0.000001, maxZoom: 4
  }) : null, [bounds?.width, bounds?.height, viewport]);
  const displayChange = useCallback((state: "loading" | "ready" | "error") => {
    if (current.current === token) setNativeDisplay({ token, state });
  }, [token]);
  const displayState = nativeDisplay?.token === token ? nativeDisplay.state : "loading";
  const failed = native ? scene.isError : image.status === "error" || !review.job.renderedAssetPath || !review.job.renderedViewport;
  const ready = Boolean(transform && (native ? scene.data && !scene.isError && displayState === "ready"
    : image.status === "ready" && !legacyPaint.loading));
  useEffect(() => { onReadyChange(ready); }, [ready, onReadyChange]);
  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const measure = () => {
      const rect = element.getBoundingClientRect();
      setViewport(current => current.width === rect.width && current.height === rect.height
        ? current : { width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  return <div ref={container} role="region" aria-label="CAD 도면 미리보기" data-testid="cad-import-preview"
    data-preview-kind={native ? "native" : "legacy"} data-preview-ready={ready} data-zoom={transform?.zoom}
    className="relative h-[min(48dvh,480px)] min-h-48 w-full overflow-hidden border border-border-default bg-surface-canvas">
    {native && scene.data && transform ? <CadImportSceneCanvas floorId={floorId} jobId={review.job.jobId}
      manifest={scene.data} pan={transform.pan} zoom={transform.zoom} viewport={viewport}
      onDisplayStateChange={displayChange} /> : null}
    {!native && transform && bounds ? <Stage width={viewport.width} height={viewport.height} style={{ position: "absolute", inset: 0 }}>
      {!native && image.image ? <Layer listening={false} onDraw={() => legacyPaint.onPaintReady(true)}
        x={transform.pan.x} y={transform.pan.y} scaleX={transform.zoom} scaleY={transform.zoom}>
        <KonvaImage image={image.image} width={bounds.width} height={bounds.height} />
      </Layer> : null}
    </Stage> : null}
    {failed ? <div className="absolute inset-x-3 top-3">
      <FeedbackState tone="danger" icon={TriangleAlert} title="선택한 CAD 도면을 표시하지 못했습니다."
        action={<Button variant="secondary" onClick={() => {
          setAttempt(value => value + 1);
          if (native) void scene.refetch();
          else image.retry();
        }}>도면 다시 불러오기</Button>} />
    </div> : null}
    {/* Once mounted, the native canvas owns its first-paint overlay. */}
    <MapLoadingOverlay loading={!failed && (native ? !scene.data || !transform : legacyPaint.loading)} />
  </div>;
}
