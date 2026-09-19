import { mkdtempSync, readdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import fs = require("node:fs");
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAP_DISPLAY_ORDERED_ASSET_MAX_BYTES, OrderedMapDisplayPrimitive, validateMapDisplayPageContent } from "@led-control/shared";
import { decodeMapDisplayTile, encodeMapDisplayTile } from "./cad-scene-codec";
import { createMapDisplayPageWriter } from "./map-display-page-writer";

const sceneId = "00000000-0000-4000-8000-000000000001";
const primitive = (i: number, layer = "raw"): OrderedMapDisplayPrimitive => ({ type: "line", elementId: `e${i}`,
  groupId: null, layerName: layer, sourceType: "LINE", zIndex: i, fragmentOrder: 0,
  bounds: { minX: 1, minY: 1, maxX: 10, maxY: 10 }, clipBounds: { minX: 0, minY: 0, maxX: 512, maxY: 512 },
  style: { strokeColor: "#000000", fillColor: null, strokeWidth: 1, opacity: 1 }, geometry: { start: { x: 1, y: 1 }, end: { x: 10, y: 10 } } });

describe("ordered display page writer", () => {
  let directory: string;
  beforeEach(() => { directory = mkdtempSync(join(tmpdir(), "map-pages-test-")); });
  afterEach(() => { jest.restoreAllMocks(); rmSync(directory, { recursive: true, force: true }); });
  it.each([[1, false], [2, false], [1, true], [2, true]] as const)(
    "rolls back every reservation when frame write %i fails (partial write: %s)", (failAt, partial) => {
      let physical = 0, writes = 0;
      const original = fs.writeFileSync;
      jest.spyOn(fs, "writeFileSync").mockImplementation((...args) => {
        if (++writes === failAt) {
          if (partial) original(args[0], Buffer.from(args[1] as Uint8Array).subarray(0, 16), args[2]);
          throw Object.assign(new Error("injected ENOSPC"), { code: "ENOSPC" });
        }
        return original(...args);
      });
      const writer = createMapDisplayPageWriter({ directory, sceneId, width: 512, height: 512,
        claimBytes: delta => { physical += delta; } });
      try {
        expect(() => {
          for (let i = 0; i < 1500; i++) writer.append({ tileX: 0, tileY: 0, lod: 0 }, primitive(i), "layer");
          [...writer.finish()];
        }).toThrow("injected ENOSPC");
        expect(readdirSync(directory)).toEqual([]);
        expect(physical).toBe(0);
        expect(() => writer.append({ tileX: 0, tileY: 0, lod: 0 }, primitive(1500), "layer")).toThrow(/finished/);
      } finally { writer.dispose(); }
      expect(physical).toBe(0);
      expect(readdirSync(directory)).toEqual([]);
    });
  it("packs sparse canonical layers in bounded assets and verifies every page against decoded records", () => {
    const writer = createMapDisplayPageWriter({ directory, sceneId, width: 512, height: 512 });
    for (let i = 0; i < 600; i++) writer.append({ tileX: 0, tileY: 0, lod: 0 }, primitive(i, `raw${i % 200}`), `layer${i % 200}`);
    const tiles = [...writer.finish()];
    expect(tiles).toHaveLength(1);
    expect(tiles[0].descriptor.pages).toHaveLength(200);
    expect(tiles[0].payload.length).toBeLessThanOrEqual(MAP_DISPLAY_ORDERED_ASSET_MAX_BYTES);
    for (const tile of tiles) validateMapDisplayPageContent(tile.descriptor, decodeMapDisplayTile(tile.payload, tile.descriptor), name => name.replace("raw", "layer"));
    expect(readdirSync(directory)).toEqual([]);
  });
  it("continues one canonical fill across pages without merging independent elements", () => {
    const writer = createMapDisplayPageWriter({ directory, sceneId, width: 512, height: 512, pageTargetBytes: 300, assetTargetBytes: 1000 });
    for (let i = 0; i < 20; i++) {
      const base = primitive(0);
      writer.append({ tileX: 0, tileY: 0, lod: 2 }, { ...base, type: "triangle", fragmentOrder: i,
        style: { ...base.style, strokeColor: null, fillColor: "#ff0000", opacity: 0.5 },
        geometry: { points: [{ x: 1, y: 1 }, { x: 10, y: 1 }, { x: 10, y: 10 }] } }, "layer", "fill-e0");
    }
    const tiles = [...writer.finish()], pages = tiles.flatMap(t => t.descriptor.pages!);
    expect(pages.length).toBeGreaterThan(2);
    expect(pages.map(p => p.paintGroup!.sequence)).toEqual(pages.map((_, i) => i));
    expect(pages.map(p => p.paintGroup!.final)).toEqual(pages.map((_, i) => i === pages.length - 1));
    for (const tile of tiles) validateMapDisplayPageContent(tile.descriptor, decodeMapDisplayTile(tile.payload, tile.descriptor), () => "layer");
  });
  it("fits the exact maximum 65536-point single record below the ordered hard cap", () => {
    const p = { ...primitive(0), type: "polyline" as const, elementId: "한".repeat(512), groupId: "글".repeat(512),
      layerName: "층".repeat(512), sourceType: "원".repeat(128),
      geometry: { closed: true, points: Array.from({ length: 65536 }, (_, i) => ({ x: i % 511, y: 1 })) } };
    const encoded = encodeMapDisplayTile([p]);
    // 48 header + 4 string count + 4 length prefixes + 4992 UTF-8 bytes
    // + 106 common/clip bytes + 8 ordering + 5 polyline bytes + 65536 XY doubles.
    expect(encoded.length).toBe(1_053_766);
    const writer = createMapDisplayPageWriter({ directory, sceneId, width: 512, height: 512 });
    writer.append({ tileX: 0, tileY: 0, lod: 1 }, p, "layer");
    const tiles = [...writer.finish()]; expect(tiles).toHaveLength(1);
    expect(tiles[0].payload.length).toBe(encoded.length);
    expect(decodeMapDisplayTile(tiles[0].payload, tiles[0].descriptor)[0]).toEqual(p);
  });
  it("rejects out-of-order fragments and cleans scratch on early iterator return", () => {
    const writer = createMapDisplayPageWriter({ directory, sceneId, width: 512, height: 512, assetTargetBytes: 150 });
    writer.append({ tileX: 0, tileY: 0, lod: 0 }, primitive(1), "layer");
    writer.append({ tileX: 0, tileY: 0, lod: 0 }, primitive(0), "layer");
    expect(() => [...writer.finish()]).toThrow(/order/);
    expect(readdirSync(directory)).toEqual([]);
    const another = createMapDisplayPageWriter({ directory, sceneId, width: 512, height: 512, assetTargetBytes: 150 });
    for (let i = 0; i < 5; i++) another.append({ tileX: 0, tileY: 0, lod: 0 }, primitive(i), "layer");
    for (const _tile of another.finish()) break;
    expect(readdirSync(directory)).toEqual([]);
  });
  it("enforces part and aggregate byte caps without truncating and releases the temporary ledger", () => {
    for (const limits of [{ maximumPartsPerCell: 1 }, { maximumTotalByteSize: 200 }]) {
      let physical = 0;
      const writer = createMapDisplayPageWriter({ directory, sceneId, width: 512, height: 512, assetTargetBytes: 150,
        claimBytes: delta => { physical += delta; }, ...limits });
      for (let i = 0; i < 5; i++) writer.append({ tileX: 0, tileY: 0, lod: 0 }, primitive(i), "layer");
      expect(() => [...writer.finish()]).toThrow(/limit/);
      expect(physical).toBe(0); expect(readdirSync(directory)).toEqual([]);
    }
  });
  it("rejects damaged temporary frames before publishing records", () => {
    const writer = createMapDisplayPageWriter({ directory, sceneId, width: 512, height: 512 });
    for (let i = 0; i < 1000; i++) writer.append({ tileX: 0, tileY: 0, lod: 0 }, primitive(i), "layer");
    const path = join(directory, readdirSync(directory)[0]);
    const bytes = readFileSync(path); bytes[30] ^= 1; writeFileSync(path, bytes);
    expect(() => [...writer.finish()]).toThrow(); expect(readdirSync(directory)).toEqual([]);
  });
});
