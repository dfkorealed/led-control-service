import type { FloorMapSnapshot } from "@led-control/shared";
import { isMapViewportCamera, type MapViewportCamera } from "../floor-map/map-camera";
export interface MonitoringCameraScope { principal: string; siteId: string; floorId: string }
interface Entry { siteId: string; floorId: string; identity: string; camera: MapViewportCamera; savedAt: number }
const namespace = "led-monitoring-camera:v1:";
const ttl = 30 * 86400000;
const memory = new Map<string, Entry[]>();
export function monitoringMapIdentity(snapshot: FloorMapSnapshot): string {
  return JSON.stringify([snapshot.mapDocument?.generationId ?? `legacy:${snapshot.revision}`, snapshot.width, snapshot.height]);
}
function validEntry(value: unknown, now: number): value is Entry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Entry;
  return typeof entry.siteId === "string" && typeof entry.floorId === "string" && typeof entry.identity === "string"
    && Number.isFinite(entry.savedAt) && now - entry.savedAt <= ttl && entry.savedAt <= now + 300000 && isMapViewportCamera(entry.camera);
}
function read(principal: string, now: number): Entry[] {
  let entries = memory.get(principal) ?? [];
  try {
    const raw = localStorage.getItem(namespace + encodeURIComponent(principal));
    if (raw && raw.length < 100000) {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) entries = parsed.filter(entry => validEntry(entry, now)).slice(-50);
    }
  } catch {
    // Embedded browsers/private mode may disable storage; retain only in-session camera memory.
  }
  return entries.filter(entry => validEntry(entry, now));
}
export const monitoringCameraStore = {
  load(scope: MonitoringCameraScope, identity: string, now = Date.now()): MapViewportCamera | null {
    const entry = read(scope.principal, now).find(entry => entry.siteId === scope.siteId && entry.floorId === scope.floorId && entry.identity === identity);
    return entry ? { ...entry.camera } : null;
  },
  save(scope: MonitoringCameraScope, identity: string, camera: MapViewportCamera, now = Date.now()): void {
    if (!isMapViewportCamera(camera) || !Number.isFinite(now)) return;
    const entries = read(scope.principal, now).filter(entry => entry.siteId !== scope.siteId || entry.floorId !== scope.floorId);
    entries.push({ siteId: scope.siteId, floorId: scope.floorId, identity, camera: { ...camera }, savedAt: now });
    const retained = entries.slice(-50);
    memory.set(scope.principal, retained);
    try { localStorage.setItem(namespace + encodeURIComponent(scope.principal), JSON.stringify(retained)); }
    catch { /* Memory above remains available without making persistence a monitoring dependency. */ }
  },
  clearMemory() { memory.clear(); }
};
