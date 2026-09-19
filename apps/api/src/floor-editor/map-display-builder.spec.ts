import { MapElement } from "@led-control/shared";
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
    const inputs = [3, 2, 1].map(i => ({ ...element(`e${i}`), zIndex: i, style: { ...element("x").style, fillColor: "#ff0000", opacity: 0.5 } }));
    const manifest = await buildMapDisplay({ ...ref, elementCount: inputs.length }, (async function* () { yield* inputs; })(),
      async tile => { payloads.push(tile.payload); });
    expect(manifest.orderedPages).toEqual({ version: 1 });
    expect(manifest.tiles.flatMap(t => t.pages ?? []).some(p => p.paintGroup)).toBe(true);
    for (let i = 0; i < payloads.length; i++) validateMapDisplayPageContent(manifest.tiles[i], decodeMapDisplayTile(payloads[i]), name => name);
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
