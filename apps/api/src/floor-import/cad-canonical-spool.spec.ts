import { mkdtemp, rm, appendFile, writeFile, readFile, symlink, truncate } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { gzipSync, gunzipSync } from "node:zlib";
import { buildCanonicalCadScene, readCanonicalElements, readCanonicalMetadata, readVerifiedCadArtifact, remainingCadArtifactBytes } from "./cad-canonical-spool";
import { decodeMapDisplayTile } from "./cad-scene-codec";
import type { MapElement } from "@led-control/shared";
import type { BuiltMapDisplayTile } from "./cad-scene-builder";

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

  it("streams exact raw display tiles without retaining scene payloads and charges physical canonical writes", async () => {
    const { document, region } = canonicalFixture();
    const jobId = randomUUID();
    const original = await buildCanonicalCadScene(document, region, jobId, directory);
    const received: BuiltMapDisplayTile[] = [];
    const claims: number[] = [];
    const limits = { maxBytes: 512 * 1024 * 1024,
      onTile: (tile: BuiltMapDisplayTile) => { received.push(tile); },
      onPhysicalBytes: (bytes: number) => { claims.push(bytes); } };
    const streamed = await buildCanonicalCadScene(document, region, jobId, directory, limits);
    expect(received).toHaveLength(original.built.tiles.length);
    expect(received.sort((a, b) => a.descriptor.assetId.localeCompare(b.descriptor.assetId)))
      .toEqual([...original.built.tiles].sort((a, b) => a.descriptor.assetId.localeCompare(b.descriptor.assetId)));
    expect(streamed.built.manifestPayload).toEqual(original.built.manifestPayload);
    expect(streamed.built).not.toHaveProperty("tiles");
    expect(claims.reduce((a, b) => a + b, 0)).toBe(streamed.canonical.elements.byteSize);
  });

  it("writes versioned bounded gzip frames with independent physical and decoded integrity", async () => {
    const { document, region } = canonicalFixture();
    document.entities = Array.from({ length: 600 }, (_, i) => ({ ...document.entities[0], sourceEntityId: String(i) }));
    const { canonical } = await buildCanonicalCadScene(document, region, randomUUID(), directory);
    expect(canonical.elements).toMatchObject({ codec: "gzip-frames", version: 1 });
    expect(canonical.elements.filename).toMatch(/\.ndjson\.gzf$/);
    const physical = await readFile(join(directory, canonical.elements.filename));
    const decoded: Buffer[] = [];
    for (let offset = 0; offset < physical.length;) {
      const compressedSize = physical.readUInt32LE(offset), decodedSize = physical.readUInt32LE(offset + 4);
      expect(decodedSize).toBeGreaterThan(0);
      expect(decodedSize).toBeLessThanOrEqual(256 * 1024);
      const bytes = gunzipSync(physical.subarray(offset + 8, offset + 8 + compressedSize));
      expect(bytes.length).toBe(decodedSize);
      decoded.push(bytes); offset += 8 + compressedSize;
    }
    expect(decoded.length).toBeGreaterThan(1);
    const bytes = Buffer.concat(decoded);
    const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
    expect(canonical.elements).toMatchObject({ byteSize: physical.length, sha256: hash(physical),
      decodedByteSize: bytes.length, decodedSha256: hash(bytes) });
    expect(physical.length).toBeLessThan(bytes.length / 2);
    const elements: MapElement[] = [];
    for await (const element of readCanonicalElements(directory, canonical)) elements.push(element);
    expect(elements).toEqual(bytes.toString("utf8").trimEnd().split("\n").map(line => JSON.parse(line)));
    const corrupted = Buffer.from(physical); corrupted[corrupted.length - 8] ^= 1;
    await writeFile(join(directory, canonical.elements.filename), corrupted);
    const iterator = readCanonicalElements(directory, { ...canonical,
      elements: { ...canonical.elements, sha256: hash(corrupted) } });
    // A later frame error must not force whole-file decoding before the first item.
    expect((await iterator.next()).value).toEqual(elements[0]);
    await expect((async () => { for await (const _ of iterator) { /* exhaust */ } })()).rejects.toThrow();
  });

  it("charges compressed physical bytes separately without reducing decoded geometry", async () => {
    const { document, region } = canonicalFixture();
    const job = randomUUID();
    const original = await buildCanonicalCadScene(document, region, job, directory);
    expect(original.canonical.elements.decodedByteSize).toBeGreaterThan(original.canonical.elements.byteSize);
    const bounded = await buildCanonicalCadScene(document, region, job, directory,
      { maxBytes: original.canonical.elements.byteSize });
    expect(bounded.canonical.elements.decodedSha256).toBe(original.canonical.elements.decodedSha256);
    await expect(buildCanonicalCadScene(document, region, job, directory,
      { maxBytes: original.canonical.elements.byteSize - 1 })).rejects.toThrow(/physical byte/);
  });

  it("bounds gzip output and unfinished NDJSON lines, and honors abort between yielded elements", async () => {
    const { document, region } = canonicalFixture();
    const { canonical } = await buildCanonicalCadScene(document, region, randomUUID(), directory);
    const abort = new AbortController();
    const iterator = readCanonicalElements(directory, canonical, abort.signal);
    expect((await iterator.next()).done).toBe(false);
    abort.abort();
    await expect(iterator.next()).rejects.toThrow(/abort/);
    const frame = (bytes: Buffer, declared = bytes.length) => {
      const gzip = gzipSync(bytes, { level: 1 }), header = Buffer.alloc(8);
      header.writeUInt32LE(gzip.length); header.writeUInt32LE(declared, 4);
      return Buffer.concat([header, gzip]);
    };
    const consume = async (physical: Buffer, decoded: Buffer) => {
      await writeFile(join(directory, canonical.elements.filename), physical);
      const hash = (b: Buffer) => createHash("sha256").update(b).digest("hex");
      const artifact = { ...canonical, elements: { ...canonical.elements, byteSize: physical.length,
        sha256: hash(physical), decodedByteSize: decoded.length, decodedSha256: hash(decoded) } };
      for await (const _ of readCanonicalElements(directory, artifact)) { /* exhaust */ }
    };
    const bomb = Buffer.alloc(256 * 1024 + 1, 65);
    await expect(consume(frame(bomb, 256 * 1024), bomb)).rejects.toThrow();
    const tooLong = Buffer.alloc(8 * 1024 * 1024, 65);
    const chunks = Array.from({ length: 32 }, (_, i) => frame(tooLong.subarray(i * 256 * 1024, (i + 1) * 256 * 1024)));
    await expect(consume(Buffer.concat(chunks), tooLong)).rejects.toThrow(/element byte/);
  });

  it("rejects wrong codec/version, decoded limits/hash/count, truncation and extra gzip members", async () => {
    const { document, region } = canonicalFixture();
    const { canonical } = await buildCanonicalCadScene(document, region, randomUUID(), directory);
    const consume = async (elements: unknown = canonical.elements, count = canonical.elementCount) => {
      for await (const _ of readCanonicalElements(directory, { ...canonical, elements, elementCount: count } as typeof canonical)) { /* verify to EOF */ }
    };
    const physical = await readFile(join(directory, canonical.elements.filename));
    const replace = async (bytes: Buffer) => {
      await writeFile(join(directory, canonical.elements.filename), bytes);
      return { ...canonical.elements, byteSize: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    };
    await expect(consume({ ...canonical.elements, codec: "plain" })).rejects.toThrow(/artifact/);
    await expect(consume({ ...canonical.elements, version: 2 })).rejects.toThrow(/artifact/);
    await expect(consume({ ...canonical.elements, decodedByteSize: 512 * 1024 * 1024 + 1 })).rejects.toThrow(/artifact/);
    await expect(consume({ ...canonical.elements, decodedByteSize: 1 })).rejects.toThrow(/decoded|size/);
    await expect(consume({ ...canonical.elements, decodedSha256: "0".repeat(64) })).rejects.toThrow(/integrity/);
    await expect(consume(canonical.elements, 3)).rejects.toThrow(/count/);
    await expect(consume(canonical.elements, 500001)).rejects.toThrow(/artifact/);
    await expect(consume(await replace(physical.subarray(0, -1)))).rejects.toThrow(/frame|truncat/);
    await expect(consume(await replace(Buffer.concat([physical, Buffer.from([0])])))).rejects.toThrow(/frame|truncat/);
    const extraMember = Buffer.concat([physical, gzipSync(Buffer.alloc(0))]);
    extraMember.writeUInt32LE(extraMember.length - 8, 0);
    await expect(consume(await replace(extraMember))).rejects.toThrow(/member|frame/);
    const crc = Buffer.from(physical); crc[crc.length - 8] ^= 1;
    await expect(consume(await replace(crc))).rejects.toThrow();
  });

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
