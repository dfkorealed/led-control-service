import { useEffect, useMemo, type RefObject } from "react";
import type { FloorMapSnapshot } from "@led-control/shared";
import type { FloorMapViewportHandle } from "../floor-map/FloorMapViewport";
import type { MapViewportCamera } from "../floor-map/map-camera";
import { monitoringCameraStore, monitoringMapIdentity, type MonitoringCameraScope } from "./monitoring-camera-storage";

export function useMonitoringCameraMemory(scope: MonitoringCameraScope | null, snapshot: FloorMapSnapshot, viewport: RefObject<FloorMapViewportHandle | null>) {
  const identity = monitoringMapIdentity(snapshot);
  const principal = scope?.principal, siteId = scope?.siteId, floorId = scope?.floorId;
  const state = useMemo(() => {
    const capturedScope = principal && siteId && floorId ? { principal, siteId, floorId } : null;
    let ready = false;
    let latest: MapViewportCamera | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const flush = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (ready && latest && capturedScope) monitoringCameraStore.save(capturedScope, identity, latest);
      latest = null;
    };
    return {
      flush,
      release() { flush(); ready = false; },
      onCameraReady() {
        if (ready || !viewport.current?.getCamera()) return;
        const saved = capturedScope ? monitoringCameraStore.load(capturedScope, identity) : null;
        // The initial fit camera must never overwrite a saved camera before restore.
        if (saved) viewport.current?.restoreCamera(saved);
        else viewport.current?.fit();
        ready = true;
      },
      onCameraSettled(camera: MapViewportCamera) {
        if (!ready) return;
        latest = camera;
        if (timer) clearTimeout(timer);
        timer = setTimeout(flush, 300);
      }
    };
  }, [principal, siteId, floorId, identity, viewport]);
  useEffect(() => () => state.release(), [state]);
  return state;
}
