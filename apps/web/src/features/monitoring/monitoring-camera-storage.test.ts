import { afterEach, describe, expect, it, vi } from "vitest";
import { monitoringCameraStore, monitoringMapIdentity } from "./monitoring-camera-storage";
const scope = { principal: "p", siteId: "s", floorId: "f" };
const camera = { centerXRatio: .7, centerYRatio: .3, zoom: 2 };
afterEach(() => { localStorage.clear(); monitoringCameraStore.clearMemory(); vi.restoreAllMocks(); });
describe("scoped camera persistence", () => {
  it("isolates principal/site/floor and map generations", () => {
    monitoringCameraStore.save(scope, "g1", camera, 1000);
    expect(monitoringCameraStore.load(scope, "g1", 1000)).toEqual(camera);
    expect(monitoringCameraStore.load({ ...scope, principal: "p2" }, "g1", 1000)).toBeNull();
    expect(monitoringCameraStore.load({ ...scope, siteId: "s2" }, "g1", 1000)).toBeNull();
    expect(monitoringCameraStore.load({ ...scope, floorId: "f2" }, "g1", 1000)).toBeNull();
    expect(monitoringCameraStore.load(scope, "g2", 1000)).toBeNull();
  });
  it("rejects expired, future and invalid cameras", () => {
    monitoringCameraStore.save(scope, "g1", camera, 1000);
    expect(monitoringCameraStore.load(scope, "g1", 1000 + 31 * 86400000)).toBeNull();
    expect(monitoringCameraStore.load(scope, "g1", -400000)).toBeNull();
    monitoringCameraStore.save(scope, "g1", { ...camera, zoom: NaN }, 1000);
    expect(monitoringCameraStore.load(scope, "g1", 1000)).toEqual(camera);
  });
  it("falls back to memory if storage is blocked", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    monitoringCameraStore.save(scope, "g1", camera, 1000);
    expect(monitoringCameraStore.load(scope, "g1", 1000)).toEqual(camera);
  });
  it("uses generation and dimensions for common maps and revision for legacy maps", () => {
    const map = { floorId: "f", revision: 1, width: 100, height: 100, floorPlan: null, objects: [] };
    expect(monitoringMapIdentity(map)).not.toEqual(monitoringMapIdentity({ ...map, revision: 2 }));
    const common = { ...map, mapDocument: {
      formatVersion: 1 as const, generationId: "g1", revision: 1, width: 100, height: 100, gridSize: 10, elementCount: 0,
      manifest: { assetId: "asset", sha256: "a".repeat(64), byteSize: 1, decodedByteSize: 1 }
    } };
    expect(monitoringMapIdentity(common)).toEqual(monitoringMapIdentity({ ...common, revision: 2, mapDocument: { ...common.mapDocument, revision: 2 } }));
    expect(monitoringMapIdentity(common)).not.toEqual(monitoringMapIdentity({ ...common, width: 200 }));
    expect(monitoringMapIdentity(common)).not.toEqual(monitoringMapIdentity({ ...common, mapDocument: { ...common.mapDocument, generationId: "g2" } }));
  });
  it("caps each principal at the last 50 views", () => {
    for (let i = 0; i < 51; i++) monitoringCameraStore.save({ ...scope, floorId: String(i) }, "g", camera, 1000 + i);
    expect(monitoringCameraStore.load({ ...scope, floorId: "0" }, "g", 1051)).toBeNull();
    expect(monitoringCameraStore.load({ ...scope, floorId: "50" }, "g", 1051)).toEqual(camera);
  });
  it("ignores malformed stored values without breaking monitoring", () => {
    localStorage.setItem("led-monitoring-camera:v1:p", "{");
    expect(monitoringCameraStore.load(scope, "g", 1000)).toBeNull();
    localStorage.setItem("led-monitoring-camera:v1:p", JSON.stringify([{ siteId: "s", floorId: "f", identity: "g", savedAt: 1000, camera: { ...camera, centerXRatio: 5 } }]));
    expect(monitoringCameraStore.load(scope, "g", 1000)).toBeNull();
  });
});
