import { mkdtemp, rm, appendFile, writeFile, symlink, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { buildCanonicalCadScene, readCanonicalElements, readCanonicalMetadata, readVerifiedCadArtifact, remainingCadArtifactBytes } from "./cad-canonical-spool";
import { decodeMapDisplayTile } from "./cad-scene-codec";
import type { MapElement } from "@led-control/shared";

export const canonicalFixture = () => {
  const bounds = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
  return {
    document: { version: 1 as const, bounds, blocks: [], entities: ["A", "B"].map(sourceEntityId => ({
      type: "line" as const, sourceEntityId, layer: "WALL", start: { x: 0, y: 0, z: 0 }, end: { x: 1000, y: 1000, z: 0 }
    })) },
    region: { regionId: "region-0123456789abcdef01234567", bounds, primitiveCount: 2, textCount: 0, lightCandidateCount: 0, area: 1e6 }
  };
};

describe("bounded canonical spool", () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "u4b-spool-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  it("returns stored unclipped elements to binary binding, preserving coincident IDs and explicit metadata", async () => {
    const { document, region } = canonicalFixture();
    const { built, canonical } = await buildCanonicalCadScene(document, region, randomUUID(), directory);
    expect(built.manifest.version).toBe(2);
    const elements: MapElement[] = [];
    for await (const element of readCanonicalElements(directory, canonical)) elements.push(element);
    const metadata = await readCanonicalMetadata(directory, canonical);
    expect(elements).toHaveLength(2);
    expect(metadata.elementCount).toBe(2);
    expect(metadata.displayLayerBindings).toEqual([{ layerName: "WALL", layerId: elements[0].layerId }]);
    const primitives = built.tiles.flatMap(tile => decodeMapDisplayTile(tile.payload, tile.descriptor));
    expect(new Set(primitives.map(p => p.elementId))).toEqual(new Set(elements.map(e => e.id)));
    expect(primitives.length).toBeGreaterThan(elements.length);
    for (const primitive of primitives) expect(primitive.zIndex).toBe(elements.find(e => e.id === primitive.elementId)!.zIndex);
    for (const element of elements) {
      expect(element.type).toBe("line");
      if (element.type === "line") expect(Math.abs(element.geometry.end.x - element.geometry.start.x)).toBeGreaterThan(1000);
    }
  });

  it("rejects byte, count, digest, path and abort violations instead of preparing partial data", async () => {
    const { document, region } = canonicalFixture();
    await expect(buildCanonicalCadScene(document, region, randomUUID(), directory, { maxBytes: 10 })).rejects.toThrow(/byte/);
    const { canonical } = await buildCanonicalCadScene(document, region, randomUUID(), directory);
    const consume = async (artifact = canonical, signal?: AbortSignal) => {
      for await (const _ of readCanonicalElements(directory, artifact, signal)) { /* exhaust integrity checks */ }
    };
    await expect(consume({ ...canonical, elementCount: 1 })).rejects.toThrow(/count/);
    await expect(consume({ ...canonical, elements: { ...canonical.elements, sha256: "0".repeat(64) } })).rejects.toThrow(/integrity/);
    await expect(consume({ ...canonical, elements: { ...canonical.elements, filename: "../outside" } })).rejects.toThrow(/artifact/);
    await expect(consume(canonical, AbortSignal.abort())).rejects.toThrow(/abort/i);
    await appendFile(join(directory, canonical.elements.filename), "extra");
    await expect(consume()).rejects.toThrow(/size|integrity/);
  });

  it("bounds binary and metadata reads before buffering and refuses symbolic-link artifacts", async () => {
    const descriptor = { filename: `${randomUUID()}.bin`, byteSize: 1, sha256: "0".repeat(64) };
    await writeFile(join(directory, descriptor.filename), Buffer.alloc(1024));
    await expect(readVerifiedCadArtifact(directory, descriptor, 16)).rejects.toThrow(/size/);
    await expect(readVerifiedCadArtifact(directory, { ...descriptor, byteSize: 1024 }, 16)).rejects.toThrow(/descriptor/);
    const link = `${randomUUID()}.json`;
    await symlink(join(directory, descriptor.filename), join(directory, link));
    await expect(readVerifiedCadArtifact(directory, { ...descriptor, filename: link, byteSize: 1024 }, 1024)).rejects.toThrow();
  });

  it("charges existing temp artifacts against the unchanged 512 MiB volume and 64 MiB headroom", async () => {
    expect(await remainingCadArtifactBytes(directory)).toBe(448 * 1024 * 1024);
    const path = join(directory, "large.dxf");
    await writeFile(path, ""); await truncate(path, 449 * 1024 * 1024);
    expect(await remainingCadArtifactBytes(directory)).toBe(-1024 * 1024);
  });
});
