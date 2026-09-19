import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { TriangleAlert } from "lucide-react";
import type { MapDocumentRef } from "@led-control/shared/map-document-contracts";
import { createMapDocumentSource, type MapDocumentSource } from "../../api/map-document";
import { Button, FeedbackState } from "../../components/ui";
import { MapSceneCanvas } from "../map-scene/MapSceneCanvas";
import { useMapDocumentReadScope } from "./editor-monitoring-cache";
import type { CadImportReviewState } from "./editor-types";
import type { Point } from "./geometry";

export type PreparedImportScene = MapDocumentRef & { source: MapDocumentSource };

export function useCadImportScene(floorId: string, review: CadImportReviewState | null) {
  const queryClient = useQueryClient();
  const scope = useMapDocumentReadScope(floorId);
  const authScope = scope?.authScope;
  const regionId = review?.scene?.kind === "native" ? review.scene.regionId : null;
  const jobId = review?.job.jobId;
  const enabled = Boolean(authScope && jobId && regionId && review?.job.floorId === floorId);
  const source = useMemo(() => authScope && jobId
    ? createMapDocumentSource({ floorId, authScope, jobId }) : null, [floorId, authScope, jobId]);
  const query = useQuery({
    queryKey: ["cad-import-preview", authScope, scope?.siteId, floorId, jobId, regionId, review?.job.updatedAt],
    enabled,
    retry: false,
    staleTime: 0,
    queryFn: async ({ signal }): Promise<MapDocumentRef> => {
      if (!authScope || !jobId || !enabled) throw new Error("Prepared import scope is unavailable");
      // Verification must not supersede the renderer's in-flight manifest or
      // replace its tile pin. Each query attempt owns a separate provider epoch.
      const verificationSource = createMapDocumentSource({ floorId, authScope, jobId });
      const document = await verificationSource.getDocument(signal);
      if (!document) throw new Error("Prepared import document is unavailable");
      const manifest = await verificationSource.getManifest(document, signal);
      if (manifest.display.regionId !== regionId) throw new Error("Prepared import region mismatch");
      signal.throwIfAborted();
      // The root query is only a mutable reference lookup. Immutable document
      // cache entries are partitioned by principal, tenant, job, generation/revision.
      queryClient.setQueryData(["map-document", authScope, scope?.siteId, floorId, "import", jobId,
        document.generationId, document.revision], document);
      return document;
    }
  });
  const data = useMemo<PreparedImportScene | undefined>(() =>
    enabled && !query.isError && query.data && source ? { ...query.data, source } : undefined,
  [enabled, query.isError, query.data, source]);
  return { ...query, data };
}

interface CadImportSceneCanvasProps {
  floorId: string;
  jobId: string;
  manifest: PreparedImportScene;
  pan: Point;
  zoom: number;
  viewport: { width: number; height: number };
}

// Prepared geometry and candidate markers already share logical map coordinates.
// Never fetch the active floor document or apply CAD normalization a second time.
export function CadImportSceneCanvas({ floorId, jobId, manifest, pan, zoom, viewport }: CadImportSceneCanvasProps) {
  const queryClient = useQueryClient();
  const scope = useMapDocumentReadScope(floorId);
  const authScope = scope?.authScope;
  const expectedSource = useMemo(() => authScope ? createMapDocumentSource({ floorId, jobId, authScope }) : null,
    [floorId, jobId, authScope]);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const { source, ...documentRef } = manifest;
  const key = JSON.stringify([source.scopeKey, manifest.generationId, manifest.revision, attempt]);
  const authorized = expectedSource?.scopeKey === source.scopeKey;
  const failed = failedKey === key;
  const measured = viewport.width > 0 && viewport.height > 0 && Number.isFinite(zoom) && zoom > 0;
  return <>
    {authorized && measured && !failed ? <MapSceneCanvas key={key}
      source={source} documentRef={documentRef} readOnly platform="mobile"
      camera={{ centerX: (viewport.width / 2 - pan.x) / zoom, centerY: (viewport.height / 2 - pan.y) / zoom,
        zoom, viewportWidth: viewport.width, viewportHeight: viewport.height }}
      onError={() => setFailedKey(key)} style={{ position: "absolute", inset: 0 }} /> : null}
    {failed || !authorized ? <div className="absolute inset-x-3 top-3 z-20">
      <FeedbackState tone="danger" icon={TriangleAlert} title="선택한 CAD 도면을 표시하지 못했습니다."
        // The host disables editing during review; this read-only retry remains available.
        action={<Button variant="secondary" aria-disabled={false} onClick={() => {
          if (scope) void queryClient.invalidateQueries({ queryKey: ["cad-import-preview", authScope, scope.siteId, floorId, jobId] });
          setAttempt(value => value + 1);
        }}>도면 다시 불러오기</Button>} />
    </div> : null}
  </>;
}
