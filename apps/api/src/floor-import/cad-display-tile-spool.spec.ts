import { createHash, randomUUID } from "node:crypto";
import * as fsPromises from "node:fs/promises";
import { mkdtemp, readFile, readdir, rm, symlink, truncate, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { buildCanonicalCadScene } from "./cad-canonical-spool";
import { createCadDisplayTileSpool, readCadDisplayTileIndex, withCadDisplayTileFile } from "./cad-display-tile-spool";

jest.mock("node:fs/promises", () => ({ ...jest.requireActual("node:fs/promises"),
  open: jest.fn(jest.requireActual("node:fs/promises").open) }));

const hash = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const maximum = 16 * 1024 * 1024;

describe("internal display tile spool", () => {
  let directory: string;
  beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "cad-tile-spool-")); });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  async function fixture() {
    const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    return buildCanonicalCadScene({ version: 1, bounds, blocks: [], entities: [{ type: "line",
      sourceEntityId: "line", layer: "wall", start: { x: 0, y: 0, z: 0 }, end: { x: 100, y: 100, z: 0 } }] },
    { regionId: "region", bounds, area: 10000, primitiveCount: 1, textCount: 0, lightCandidateCount: 0 },
    randomUUID(), directory);
  }

  it("restores identical raw bytes one tile at a time and cleans scratch after success or failure", async () => {
    const { built } = await fixture();
    const claims: number[] = [];
    const spool = createCadDisplayTileSpool(directory, bytes => { claims.push(bytes); });
    for (const tile of built.tiles) spool.write(tile);
    const artifact = spool.finish();
    expect(artifact).toMatchObject({ codec: "gzip", version: 1 });
    const index = await readCadDisplayTileIndex(directory, artifact, built.manifest);
    expect(index!.size).toBe(built.tiles.length);
    expect(spool.rawByteSize).toBe(built.tiles.reduce((n, tile) => n + tile.payload.length, 0));
    expect(claims.reduce((a, b) => a + b, 0)).toBe(spool.physicalByteSize);
    const before = (await readdir(directory)).sort();
    for (const tile of built.tiles.slice(0, 2)) {
      await withCadDisplayTileFile(directory, tile.descriptor, index, async (path, bytes) => {
        expect(bytes).toEqual(tile.payload);
        expect(await readFile(path)).toEqual(tile.payload);
        expect((await readdir(directory)).filter(name => name.endsWith(".bin"))).toHaveLength(1);
      });
      expect((await readdir(directory)).sort()).toEqual(before);
    }
    await expect(withCadDisplayTileFile(directory, built.tiles[0].descriptor, index,
      async () => { throw new Error("upload failed"); })).rejects.toThrow("upload failed");
    expect((await readdir(directory)).sort()).toEqual(before);
    await expect(withCadDisplayTileFile(directory, built.tiles[0].descriptor, index,
      async () => undefined, AbortSignal.abort())).rejects.toThrow();
    expect((await readdir(directory)).sort()).toEqual(before);
  });

  it("rejects codec/version/index integrity and exact membership or decoded descriptor mismatch", async () => {
    const { built } = await fixture();
    const spool = createCadDisplayTileSpool(directory, () => undefined);
    built.tiles.forEach(spool.write);
    const artifact = spool.finish();
    for (const bad of [{ ...artifact, codec: "plain" }, { ...artifact, version: 2 },
      { ...artifact, sha256: "0".repeat(64) }, { ...artifact, filename: "../index" }]) {
      await expect(readCadDisplayTileIndex(directory, bad as typeof artifact, built.manifest)).rejects.toThrow();
    }
    const original = JSON.parse((await readFile(join(directory, artifact.filename))).toString());
    for (const tiles of [original.tiles.slice(1), [...original.tiles, original.tiles[0]],
      original.tiles.map((tile: any, i: number) => i ? tile : { ...tile, decodedByteSize: maximum + 1 }),
      original.tiles.map((tile: any, i: number) => i ? tile : { ...tile, decodedSha256: "0".repeat(64) })]) {
      const bytes = Buffer.from(JSON.stringify({ ...original, tiles }));
      await writeFile(join(directory, artifact.filename), bytes);
      await expect(readCadDisplayTileIndex(directory, { ...artifact, byteSize: bytes.length, sha256: hash(bytes) }, built.manifest))
        .rejects.toThrow();
    }
  });

  it("rejects truncated, trailing, concatenated, corrupt and oversized gzip before invoking upload", async () => {
    const { built } = await fixture();
    const spool = createCadDisplayTileSpool(directory, () => undefined);
    built.tiles.forEach(spool.write);
    const index = (await readCadDisplayTileIndex(directory, spool.finish(), built.manifest))!;
    const tile = built.tiles[0], entry = index.get(tile.descriptor.assetId)!;
    const original = await readFile(join(directory, entry.filename));
    const corrupt = Buffer.from(original); corrupt[corrupt.length - 8] ^= 1;
    const variants = [original.subarray(0, -1), Buffer.concat([original, Buffer.from([0])]),
      Buffer.concat([original, gzipSync(Buffer.alloc(0))]), corrupt, gzipSync(Buffer.alloc(tile.payload.length + 1))];
    const upload = jest.fn();
    for (const bytes of variants) {
      await writeFile(join(directory, entry.filename), bytes);
      index.set(tile.descriptor.assetId, { ...entry, byteSize: bytes.length, sha256: hash(bytes) });
      await expect(withCadDisplayTileFile(directory, tile.descriptor, index, upload)).rejects.toThrow();
    }
    index.set(tile.descriptor.assetId, entry);
    await writeFile(join(directory, entry.filename), original);
    index.set(tile.descriptor.assetId, { ...entry, sha256: "0".repeat(64) });
    await expect(withCadDisplayTileFile(directory, tile.descriptor, index, upload)).rejects.toThrow();
    expect(upload).not.toHaveBeenCalled();
    expect((await readdir(directory)).filter(name => name.endsWith(".bin"))).toEqual([]);
  });

  it("fails physical claims before writing, preserves raw caps, and refuses symbolic links", async () => {
    const { built } = await fixture();
    const tile = built.tiles[0];
    const before = await readdir(directory);
    const blocked = createCadDisplayTileSpool(directory, () => { throw new Error("temp budget"); });
    expect(() => blocked.write(tile)).toThrow("temp budget");
    expect(await readdir(directory)).toEqual(before);
    const spool = createCadDisplayTileSpool(directory, () => undefined);
    expect(() => spool.write({ ...tile, descriptor: { ...tile.descriptor, byteSize: maximum + 1 } })).toThrow();
    built.tiles.forEach(spool.write);
    const index = (await readCadDisplayTileIndex(directory, spool.finish(), built.manifest))!;
    const entry = index.get(tile.descriptor.assetId)!;
    const original = await readFile(join(directory, entry.filename));
    await rm(join(directory, entry.filename));
    const target = join(directory, "target"); await writeFile(target, original);
    await symlink(target, join(directory, entry.filename));
    await expect(withCadDisplayTileFile(directory, tile.descriptor, index, async () => undefined)).rejects.toThrow();
  });

  it("checks remaining temp space before restore and cleans a partially written scratch file", async () => {
    const { built } = await fixture();
    const spool = createCadDisplayTileSpool(directory, () => undefined);
    built.tiles.forEach(spool.write);
    const index = await readCadDisplayTileIndex(directory, spool.finish(), built.manifest);
    const filler = join(directory, "filler");
    await writeFile(filler, ""); await truncate(filler, 448 * 1024 * 1024);
    const upload = jest.fn();
    await expect(withCadDisplayTileFile(directory, built.tiles[0].descriptor, index, upload)).rejects.toThrow(/temporary disk/);
    expect(upload).not.toHaveBeenCalled();
    await rm(filler);
    const originalOpen: typeof fsPromises.open = jest.requireActual("node:fs/promises").open;
    const open = jest.mocked(fsPromises.open).mockImplementation(async (...args) => {
      const handle = await originalOpen(...args);
      if (args[1] === "wx") {
        const write = handle.writeFile.bind(handle);
        handle.writeFile = async () => { await write(Buffer.from("partial")); throw new Error("disk write failed"); };
      }
      return handle;
    });
    try {
      await expect(withCadDisplayTileFile(directory, built.tiles[0].descriptor, index, upload)).rejects.toThrow("disk write failed");
      expect((await readdir(directory)).filter(name => name.endsWith(".bin"))).toEqual([]);
      expect(upload).not.toHaveBeenCalled();
    } finally { open.mockImplementation(originalOpen); }
  });
});
