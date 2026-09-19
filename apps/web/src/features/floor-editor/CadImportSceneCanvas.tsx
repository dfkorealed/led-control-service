import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { TriangleAlert } from "lucide-react";
import type { CadSceneManifest } from "@led-control/shared";
import { getCadSceneManifest, getCadSceneTile } from "../../api/floor-editor";
import { Button, FeedbackState } from "../../components/ui";
import { createReadOnlyCadSceneRenderer, type ReadOnlyCadSceneRenderer } from "../floor-map/cad-scene-readonly-runtime";
import { editorTransformToCadCamera } from "./cad-editor-runtime";
import type { CadImportReviewState } from "./editor-types";
import type { Point } from "./geometry";

function scenePath(floorId: string, jobId: string) {
  return `/floors/${encodeURIComponent(floorId)}/import-jobs/${encodeURIComponent(jobId)}/scene`;
}

export function useCadImportScene(floorId: string, review: CadImportReviewState | null) {
  const regionId = review?.scene?.kind === "native" ? review.scene.regionId : null;
  const jobId = review?.job.jobId;
  return useQuery({
    queryKey: ["cad-import-preview", floorId, jobId, regionId],
    enabled: Boolean(jobId && regionId && review?.job.floorId === floorId),
    retry: false,
    staleTime: Infinity,
    queryFn: async ({ signal }) => {
      const manifest = await getCadSceneManifest(`${scenePath(floorId, jobId!)}/manifest/content`, signal);
      if (manifest.regionId !== regionId) throw new Error("CAD review region mismatch");
      return manifest;
    }
  });
}

interface CadImportSceneCanvasProps {
  floorId: string;
  jobId: string;
  manifest: CadSceneManifest;
  pan: Point;
  zoom: number;
  viewport: { width: number; height: number };
}

// A draft scene has no applied-floor state or persisted overrides. Both the
// review background and its candidates already use the manifest's map frame.
export function CadImportSceneCanvas({ floorId, jobId, manifest, pan, zoom, viewport }: CadImportSceneCanvasProps) {
  const host = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<ReadOnlyCadSceneRenderer | null>(null);
  const camera = editorTransformToCadCamera(pan, zoom, viewport);
  const latestCamera = useRef(camera);
  latestCamera.current = camera;
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!host.current) return;
    const controller = new AbortController();
    let renderer: ReadOnlyCadSceneRenderer | null = null;
    let disposed = false;
    const canvas = document.createElement("canvas");
    canvas.dataset.testid = "cad-scene-canvas";
    canvas.className = "pointer-events-none absolute inset-0 h-full w-full";
    canvas.style.visibility = "hidden";
    host.current.append(canvas);
    setFailed(false);
    const fail = () => {
      if (disposed) return;
      canvas.style.visibility = "hidden";
      setFailed(true);
    };
    void (async () => {
      try {
        const next = await createReadOnlyCadSceneRenderer({
          manifest,
          // The preview shares a page with the editor; retain its 32 MiB policy.
          platform: "mobile",
          devicePixelRatio: window.devicePixelRatio,
          loadTile: (tile, signal) => getCadSceneTile(
            `${scenePath(floorId, jobId)}/tiles/${tile.lod}/${tile.tileX}/${tile.tileY}/${tile.part}/content`,
            signal
          ),
          onError: fail
        }, new Map());
        if (disposed) { next.destroy(); return; }
        renderer = next;
        await next.mount(canvas);
        if (disposed) return;
        rendererRef.current = next;
        await next.setCamera(latestCamera.current);
        if (!disposed && !controller.signal.aborted) canvas.style.visibility = "visible";
      } catch { fail(); }
    })();
    return () => {
      disposed = true;
      controller.abort();
      if (rendererRef.current === renderer) rendererRef.current = null;
      renderer?.destroy();
      canvas.remove();
    };
  }, [floorId, jobId, manifest, attempt]);

  useEffect(() => {
    const renderer = rendererRef.current;
    let current = true;
    if (renderer) void renderer.setCamera(camera).catch(() => {
      if (current && rendererRef.current === renderer) setFailed(true);
    });
    return () => { current = false; };
  }, [pan.x, pan.y, zoom, viewport.width, viewport.height, manifest]);

  return <>
    <div ref={host} className="pointer-events-none absolute inset-0" hidden={failed} />
    {failed ? <div className="absolute inset-x-3 top-3 z-20">
      <FeedbackState tone="danger" icon={TriangleAlert} title="선택한 CAD 도면을 표시하지 못했습니다."
        action={<Button variant="secondary" onClick={() => setAttempt(value => value + 1)}>도면 다시 불러오기</Button>} />
    </div> : null}
  </>;
}
