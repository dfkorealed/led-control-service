import { MapElement, getMapElementBounds, transformMapPoint } from "@led-control/shared";
import { nativeMapDisplayManifestSchema, validateMapDisplayPageContent } from "@led-control/shared";
import { buildMapDisplay } from "./map-display-builder";
import { decodeMapDisplayTile } from "../floor-import/cad-scene-codec";

const element = (id: string): MapElement => ({ id, type: "rectangle", geometry: { origin: { x: 10, y: 10 }, width: 20, height: 20 },
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, groupId: null, layerId: "map", zIndex: 0,
  visible: true, locked: false, style: { strokeWidth: 1, strokeColor: "#000000", fillColor: null, opacity: 1 }, provenance: null });
const ref = { formatVersion: 1 as const, generationId: "e91306ed-5ed2-4c75-92f4-7b51db86f773", revision: 3, width: 1200, height: 800, gridSize: 25, elementCount: 2101,
  manifest: { assetId: "asset", sha256: "a".repeat(64), byteSize: 1, decodedByteSize: 2 } };
describe("generic native map compact display", () => {
  it("streams nonempty compact tiles using the existing public CAD writer without CAD normalization", async () => {
    const payloads: Buffer[] = [];
    const manifest = await buildMapDisplay(ref, (async function* () { for (let i = 0; i < 2101; i++) yield element(String(i)); })(),
      async tile => { payloads.push(tile.payload); });
    expect(nativeMapDisplayManifestSchema.safeParse(manifest).success).toBe(true);
    expect(manifest).toMatchObject({ width: 1200, height: 800, gridSize: 25, padding: 0,
      transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 } });
    expect(manifest.primitiveCount).toBe(2101);
    expect(manifest.tileCount).toBe(payloads.length);
    expect(payloads.length).toBeGreaterThan(0);
    expect(manifest.version).toBe(2);
    expect(manifest.orderedPages).toEqual({ version: 1 });
    for (let i = 0; i < payloads.length; i++) validateMapDisplayPageContent(manifest.tiles[i], decodeMapDisplayTile(payloads[i]), name => name);
    const primitives = payloads.flatMap(payload => decodeMapDisplayTile(payload));
    expect(primitives.every(p => p.zIndex === 0 && Number.isInteger(p.fragmentOrder))).toBe(true);
  });
  it("emits ordered checkpoint pages for reverse paint-key input and explicit canonical fill groups", async () => {
    const payloads: Buffer[] = [];
    const inputs: MapElement[] = [3, 2, 1].map(i => ({ ...element(`e${i}`), type: "polygon", zIndex: i,
      geometry: { outer: [{ x: 10, y: 10 }, { x: 30, y: 10 }, { x: 30, y: 30 }, { x: 10, y: 30 }], holes: [] },
      style: { ...element("x").style, fillColor: "#ff0000", opacity: 0.5 } }));
    const manifest = await buildMapDisplay({ ...ref, elementCount: inputs.length }, (async function* () { yield* inputs; })(),
      async tile => { payloads.push(tile.payload); });
    expect(manifest.orderedPages).toEqual({ version: 1 });
    expect(manifest.tiles.flatMap(t => t.pages ?? []).some(p => p.paintGroup)).toBe(true);
    for (let i = 0; i < payloads.length; i++) validateMapDisplayPageContent(manifest.tiles[i], decodeMapDisplayTile(payloads[i]), name => name);
  });
  it("retains one transformed rectangle fill contour and separate closed stroke across cells", async () => {
    const input: MapElement = { ...element("rectangle"), type: "rectangle", groupId: "group", layerId: "layer", zIndex: -7,
      geometry: { origin: { x: 0, y: 0 }, width: 100, height: 80 },
      transform: { x: 510.25, y: 500.5, scaleX: 1.2, scaleY: 0.8, rotation: 17.5 },
      style: { strokeColor: "#000000", fillColor: "#FF0000", strokeWidth: 2, opacity: 0.4 } };
    const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 80 }, { x: 0, y: 80 }]
      .map(point => transformMapPoint(point, input.transform));
    const tiles: Parameters<Parameters<typeof buildMapDisplay>[2]>[0][] = [];
    const manifest = await buildMapDisplay({ ...ref, elementCount: 1 }, (async function* () { yield input; })(),
      async tile => { tiles.push(tile); });
    expect(manifest.primitiveCount).toBe(2);
    expect(new Set(tiles.map(t => `${t.descriptor.tileX}:${t.descriptor.tileY}`)).size).toBeGreaterThan(1);
    const decoded = tiles.flatMap(t => decodeMapDisplayTile(t.payload, t.descriptor));
    const fills = decoded.filter(p => p.style.fillColor !== null);
    const strokes = decoded.filter(p => p.style.strokeColor !== null);
    expect(fills.length).toBeGreaterThan(0); expect(strokes.length).toBeGreaterThan(0);
    for (const p of decoded) {
      expect(p).toMatchObject({ elementId: input.id, groupId: input.groupId, layerName: input.layerId, zIndex: input.zIndex,
        type: "polyline", geometry: { points, closed: true } });
      const bounds = getMapElementBounds(input), margin = p.style.strokeColor === null ? 0 : input.style.strokeWidth * 5;
      expect(p.clipBounds).not.toBeNull();
      expect(p.bounds).toEqual({ minX: Math.max(bounds.minX - margin, p.clipBounds!.minX),
        minY: Math.max(bounds.minY - margin, p.clipBounds!.minY),
        maxX: Math.min(bounds.maxX + margin, p.clipBounds!.maxX),
        maxY: Math.min(bounds.maxY + margin, p.clipBounds!.maxY) });
    }
    expect(new Set(fills.map(p => p.fragmentOrder))).toEqual(new Set([0]));
    expect(new Set(strokes.map(p => p.fragmentOrder))).toEqual(new Set([1]));
    expect(fills.every(p => p.style.strokeColor === null && p.style.opacity === input.style.opacity)).toBe(true);
    expect(strokes.every(p => p.style.fillColor === null)).toBe(true);
    expect(manifest.tiles.flatMap(t => t.pages ?? []).every(p => !p.paintGroup)).toBe(true);
  });
  it("supports truly empty maps and propagates failed uploads", async () => {
    const empty = await buildMapDisplay({ ...ref, elementCount: 0 }, (async function* () {})(), async () => {});
    expect(empty.tileCount).toBe(0);
    await expect(buildMapDisplay({ ...ref, elementCount: 1 }, (async function* () { yield element("one"); })(),
      async () => { throw Error("upload failed"); })).rejects.toThrow("upload failed");
  });
  it("checks canonical count and cancellation rather than silently dropping geometry", async () => {
    await expect(buildMapDisplay(ref, (async function* () { yield element("one"); })(), async () => {})).rejects.toThrow(/count/);
    await expect(buildMapDisplay(ref, (async function* () { yield element("one"); })(), async () => {},
      () => { throw Error("cancelled"); })).rejects.toThrow("cancelled");
  });
});
