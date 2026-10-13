import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, type CSSProperties } from "react";
import type { Bounds, MapDocumentRef, MapElement, MapOp, Point } from "@led-control/shared/map-document-contracts";
import type { CadSceneCamera, CadRendererPlatform } from "../cad-scene/cad-scene-camera";
import type { CadSceneDegradation } from "../cad-scene/CadSceneRenderer";
import { MapSceneRenderer, type MapScenePickResult, type MapSceneRendererOptions } from "./MapSceneRenderer";
import type { MapSceneManifest, MapSceneSource } from "./map-scene-source";
import { MapLoadingOverlay, useMapPaintLoading } from "../../components/ui/MapLoadingOverlay";

export interface MapSceneCanvasHandle {
  /** Applies a transient camera transform without waiting for React props. */
  setCamera(camera: CadSceneCamera): void;
  pick(point: Point): Promise<MapScenePickResult | null>;
  getElements(ids: readonly string[]): Promise<readonly MapElement[]>;
  setPromotedElementIds(ids: readonly string[]): void;
  applyChanges(operations: MapOp[], changedBounds: Bounds[]): number;
  setDraftChanges(operations: MapOp[], changedBounds: Bounds[]): number;
  getDraftVersion(): number;
  acknowledge(ref: MapDocumentRef, throughVersion: number): Promise<void>;
}

export interface MapSceneCanvasProps {
  source: MapSceneSource;
  documentRef: MapDocumentRef;
  /** Host-measured viewport, never logical map dimensions or an initial guess. */
  camera: CadSceneCamera;
  readOnly?: boolean;
  platform?: CadRendererPlatform;
  promotedElementIds?: readonly string[];
  onManifest?: (manifest: MapSceneManifest) => void;
  onReady?: (handle: MapSceneCanvasHandle | null) => void;
  onPaintReady?: (ready: boolean) => void;
  onError?: (error: Error) => void;
  onDegraded?: (result: CadSceneDegradation) => void;
  className?: string;
  style?: CSSProperties;
  createRenderer?: (options: MapSceneRendererOptions) => MapSceneRenderer;
}

interface Session { renderer: MapSceneRenderer; mounted: Promise<void>; active: boolean; documentEpoch: number; documentKey: string | null }

/** A store-independent WebGL surface. The host owns camera input, selection,
 * history, localized error UI, and permission-aware provider identity. */
export const MapSceneCanvas = forwardRef<MapSceneCanvasHandle, MapSceneCanvasProps>(function MapSceneCanvas(props, ref) {
  const host = useRef<HTMLDivElement>(null);
  const latest = useRef(props); latest.current = props;
  const paint = useMapPaintLoading(JSON.stringify([props.source.scopeKey, props.documentRef.generationId]));
  const latestPaint = useRef(paint); latestPaint.current = paint;
  // Data providers are regularly recreated by React Query consumers. Keep the
  // renderer bound to one authenticated scope and delegate each request to the
  // current provider instead of treating a callback refresh as a new WebGL map.
  const sourceFacade = useRef<MapSceneSource | null>(null);
  if (!sourceFacade.current) {
    sourceFacade.current = {
      get scopeKey() { return latest.current.source.scopeKey; },
      getManifest: (document, signal) => latest.current.source.getManifest(document, signal),
      getChanges: (document, cursor, signal) => latest.current.source.getChanges(document, cursor, signal),
      loadDisplayTile: (tile, signal) => latest.current.source.loadDisplayTile(tile, signal),
      getElements: (document, ids, signal) => latest.current.source.getElements(document, ids, signal),
      get decodeDisplayTile() { return latest.current.source.decodeDisplayTile; }
    };
  }
  const session = useRef<Session | null>(null);
  const handle = useMemo<MapSceneCanvasHandle>(() => {
    const requireRenderer = (write = false) => {
      if (write && latest.current.readOnly) throw new Error("Map Canvas is read-only");
      if (!session.current?.active) throw new Error("Map Canvas is not ready");
      return session.current.renderer;
    };
    return {
      setCamera: camera => requireRenderer().setCamera(camera),
      pick: point => session.current?.active ? session.current.renderer.pick(point) : Promise.resolve(null),
      getElements: ids => session.current?.active ? session.current.renderer.getElements(ids) : Promise.resolve([]),
      setPromotedElementIds: ids => requireRenderer().setPromotedElementIds(ids),
      applyChanges: (operations, bounds) => requireRenderer(true).applyChanges(operations, bounds),
      setDraftChanges: (operations, bounds) => requireRenderer(true).setDraftChanges(operations, bounds),
      getDraftVersion: () => requireRenderer().getDraftVersion(),
      acknowledge: (document, throughVersion) => requireRenderer(true).acknowledge(document, throughVersion)
    };
  }, []);
  useImperativeHandle(ref, () => handle, [handle]);

  const { readOnly = false, platform = "desktop" } = props;
  const scopeKey = props.source.scopeKey;
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    // Pixi disposal loses its GL context. StrictMode replay and permission/
    // source changes must create a NEW native canvas, not reuse a lost one.
    const canvas = document.createElement("canvas");
    canvas.style.cssText = "display:block;width:100%;height:100%;pointer-events:none";
    canvas.setAttribute("aria-hidden", "true");
    parent.appendChild(canvas);
    let current: Session | undefined;
    const alive = () => current?.active && session.current === current;
    const renderer = (latest.current.createRenderer ?? (options => new MapSceneRenderer(options)))({ source: sourceFacade.current!, platform,
      onError: error => { if (alive()) { latestPaint.current.onError(); latest.current.onPaintReady?.(false); latest.current.onError?.(error); } },
      onDegraded: result => { if (alive()) latest.current.onDegraded?.(result); },
      onManifest: manifest => { if (alive()) latest.current.onManifest?.(manifest); },
      onPaintReady: ready => {
        if (alive() && (!ready || current!.documentKey === JSON.stringify(latest.current.documentRef))) {
          latestPaint.current.onPaintReady(ready);
          latest.current.onPaintReady?.(ready);
        }
      }
    });
    current = { renderer, mounted: renderer.mount(canvas), active: true, documentEpoch: 0, documentKey: null };
    session.current = current;
    latest.current.onPaintReady?.(false);
    // Mount errors also reach the host when the document effect is superseded.
    void current.mounted.catch(error => { if (alive()) { latestPaint.current.onError(); latest.current.onError?.(asError(error)); } });
    return () => {
      current!.active = false;
      renderer.dispose();
      canvas.remove();
      if (session.current === current) session.current = null;
      latest.current.onReady?.(null);
      latest.current.onPaintReady?.(false);
    };
  }, [scopeKey, platform]);

  const documentKey = JSON.stringify(props.documentRef);
  // Platform changes replace the session even if all its input values stay
  // unchanged. Every session-scoped effect must replay for the new renderer.
  useEffect(() => {
    const current = session.current;
    if (!current) return;
    const epoch = ++current.documentEpoch;
    const document = latest.current.documentRef;
    latest.current.onPaintReady?.(false);
    const alive = () => current.active && session.current === current && epoch === current.documentEpoch;
    void current.mounted.then(async () => {
      if (!alive()) return;
      try {
        current.documentKey = JSON.stringify(document);
        await current.renderer.setDocument(document);
        if (!alive()) return;
        current.renderer.setPromotedElementIds(latest.current.promotedElementIds ?? []);
        latest.current.onReady?.(handle);
      } catch (error) { if (alive()) { latestPaint.current.onError(); latest.current.onPaintReady?.(false); latest.current.onError?.(asError(error)); } }
    }, () => undefined);
    return () => { current.documentEpoch++; };
  }, [documentKey, scopeKey, platform, handle]);

  useEffect(() => {
    const current = session.current;
    if (!current) return;
    try { current.renderer.setCamera(props.camera); }
    catch (error) { latestPaint.current.onError(); latest.current.onError?.(asError(error)); }
  }, [props.camera, scopeKey, platform]);

  useEffect(() => {
    try { session.current?.renderer.setPromotedElementIds(props.promotedElementIds ?? []); }
    catch (error) { latestPaint.current.onError(); latest.current.onError?.(asError(error)); }
  }, [props.promotedElementIds, scopeKey, platform]);

  return <div className={props.className} aria-busy={paint.loading}
    style={{ position: "relative", width: "100%", height: "100%", minWidth: 0, minHeight: 0, ...props.style }}>
    <div ref={host} role="img" aria-label="맵 도형" style={{ width: "100%", height: "100%" }} />
    <MapLoadingOverlay loading={paint.loading} />
  </div>;
});

function asError(error: unknown): Error { return error instanceof Error ? error : new Error("Map Canvas failed"); }
