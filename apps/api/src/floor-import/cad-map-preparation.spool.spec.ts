import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CadMapPreparationService } from "./cad-map-preparation.service";
import { buildCanonicalCadScene } from "./cad-canonical-spool";
import { createCadDisplayTileSpool } from "./cad-display-tile-spool";

it.each([false, true])("prepares raw public assets from internal gzip with bounded cleanup (upload failure=%s)", async fail => {
  const directory = await mkdtemp(join(tmpdir(), "cad-preparation-spool-"));
  try {
    const bounds = { minX: 0, minY: 0, maxX: 100, maxY: 100 };
    const { built, canonical } = await buildCanonicalCadScene({ version: 1, bounds, blocks: [], entities: [{ type: "line",
      sourceEntityId: "A", layer: "wall", start: { x: 0, y: 0, z: 0 }, end: { x: 100, y: 100, z: 0 } }] },
    { regionId: "region", bounds, area: 10000, primitiveCount: 1, textCount: 0, lightCandidateCount: 0 }, randomUUID(), directory);
    const spool = createCadDisplayTileSpool(directory, () => undefined);
    built.tiles.forEach(spool.write); canonical.displayTiles = spool.finish();
    const uploads: Buffer[] = [], elements: unknown[] = [];
    const ref = { generationId: randomUUID(), revision: 1, formatVersion: 1, width: built.manifest.width,
      height: built.manifest.height, gridSize: built.manifest.gridSize, elementCount: 1,
      manifest: { assetId: randomUUID(), byteSize: 1, decodedByteSize: 1, sha256: "a".repeat(64) } };
    const store = { prepareGeneration: async (_floor: string, input: AsyncIterable<unknown>) => {
      for await (const element of input) elements.push(element);
      return ref;
    }, attachDisplayAssets: jest.fn(), discardPreparedGeneration: jest.fn() };
    const prisma = { floorAsset: { create: jest.fn() },
      $transaction: async (run: (tx: unknown) => Promise<unknown>) => run({ $queryRaw: jest.fn(),
        floorAsset: { updateMany: async () => ({ count: 1 }) } }) };
    const storage = { putCadSceneObjectFile: async (_key: string, path: string, expected: any) => {
      const bytes = await readFile(path);
      expect(bytes.length).toBe(expected.sizeBytes);
      expect(createHash("sha256").update(bytes).digest("hex")).toBe(expected.sha256);
      expect(expected.contentEncoding).toBeUndefined();
      if (expected.contentType === "application/octet-stream") {
        expect((await readdir(directory)).filter(name => name.endsWith(".bin"))).toHaveLength(1);
        uploads.push(bytes);
        if (fail) throw new Error("upload failed");
      }
    }, verifyCadSceneObject: jest.fn() };
    const service = new CadMapPreparationService(prisma as any, storage as any, store as any);
    const result = service.prepare(randomUUID(), directory, canonical, built.manifest);
    if (fail) {
      await expect(result).rejects.toThrow("upload failed");
      expect(store.discardPreparedGeneration).toHaveBeenCalledTimes(1);
      expect(store.attachDisplayAssets).not.toHaveBeenCalled();
    } else {
      await expect(result).resolves.toEqual(ref);
      expect(uploads).toEqual(built.tiles.map(tile => tile.payload));
      expect(elements).toHaveLength(1);
      expect(store.attachDisplayAssets).toHaveBeenCalledTimes(1);
      expect(store.discardPreparedGeneration).not.toHaveBeenCalled();
    }
    expect((await readdir(directory)).filter(name => name.endsWith(".bin"))).toEqual([]);
  } finally { await rm(directory, { force: true, recursive: true }); }
});
