import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { MapElement } from "@led-control/shared";
import { MapDocumentStore, needsMapCheckpoint } from "./map-document-store";
import { FloorAssetCleanupService } from "./floor-asset-cleanup.service";
import { MapDocumentAssetReferences } from "./map-document-asset-references";

const url = process.env.FLOOR_EDITOR_TEST_DATABASE_URL;
const postgres = url ? describe : describe.skip;
const element = (id: string): MapElement => ({ id, type: "line", layerId: "default", groupId: null,
  zIndex: 0, visible: true, locked: false, provenance: null,
  geometry: { start: { x: 0, y: 0 }, end: { x: 100, y: 100 } },
  transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
  style: { strokeColor: "#000000", fillColor: null, strokeWidth: 1, opacity: 1 } });
async function* elements(ids: string[]) { for (const id of ids) yield element(id); }
const seed = { width: 16_384, height: 16_384, gridSize: 10, groups: [],
  layers: [{ id: "default", name: "기본", order: 0, locked: false, visible: true }] };

postgres("MapDocumentStore isolated PostgreSQL", () => {
  const prisma = new PrismaClient(url ? { datasources: { db: { url } } } : undefined);
  const objects = new Map<string, Buffer>();
  const storage = {
    putCadSceneObjectFile: jest.fn(async (key: string, file: string) => { objects.set(key, await readFile(file)); }),
    verifyCadSceneObject: jest.fn(async () => undefined),
    downloadFloorAssetToFile: jest.fn(async (key: string, file: string) => {
      const value = objects.get(key); if (!value) throw new Error("missing object");
      await writeFile(file, value, { flag: "wx" });
    }),
    deleteObject: jest.fn(async (key: string) => { objects.delete(key); })
  };
  const store = new MapDocumentStore(prisma as never, storage as never);
  let floorId: string;
  let siteId: string;
  let userId: string;

  beforeAll(async () => {
    // A URL variable alone is not authorization to mutate a developer's database.
    const target = new URL(url!);
    if (!/^\/led_u3_test_[a-z0-9_]+$/.test(target.pathname) ||
      !["localhost", "127.0.0.1"].includes(target.hostname) || target.searchParams.has("schema")) {
      throw new Error("U3 tests require an exact disposable local database identity");
    }
    const [identity] = await prisma.$queryRaw<Array<{ database: string }>>`SELECT current_database() AS database`;
    if (`/${identity.database}` !== target.pathname) throw new Error("U3 database identity mismatch");
  });
  beforeEach(async () => {
    const suffix = randomUUID();
    const organization = await prisma.organization.create({ data: { name: `u3-${suffix}`, type: "customer" } });
    const user = await prisma.user.create({ data: { organizationId: organization.id, loginId: `u3-${suffix}`,
      name: "U3", passwordHash: "test-only", role: "admin" } });
    userId = user.id;
    const site = await prisma.site.create({ data: { name: "U3", organizationId: organization.id, adminUserId: userId } });
    siteId = site.id;
    const floor = await prisma.floor.create({ data: { siteId, name: "U3", level: 1 } });
    floorId = floor.id;
    objects.clear(); jest.clearAllMocks();
  });
  afterEach(async () => { if (siteId) await prisma.site.delete({ where: { id: siteId } }); });
  afterAll(async () => { await prisma.$disconnect(); });

  it("prepares and reads bounded chunks/index shards without activating a document", async () => {
    const ref = await store.prepareGeneration(floorId, elements(["a", "b", "c"]), { ...seed, chunkBytes: 700 });
    expect(ref.elementCount).toBe(3);
    expect(ref.revision).toBe(1);
    expect(await prisma.floorMapDocument.findUnique({ where: { floorId } })).toBeNull();
    expect((await prisma.floor.findUniqueOrThrow({ where: { id: floorId } })).mapRevision).toBe(0);
    expect(await store.getElement(floorId, ref, "b")).toEqual(element("b"));
    expect(await store.getElement(floorId, ref, "missing")).toBeNull();
    const read: MapElement[] = [];
    for await (const value of store.iterateGeneration(floorId, ref)) read.push(value);
    expect(read.map(value => value.id)).toEqual(["a", "b", "c"]);
    expect(await prisma.floorMapChunk.count({ where: { generationId: ref.generationId } })).toBeGreaterThan(1);
    await expect(store.getElement("other-floor", ref, "a")).rejects.toThrow();
  });

  it("leaves the current generation/revision intact on mid-stream and upload failures", async () => {
    const ref = await activate(["original"]);
    async function* broken() { yield element("new"); throw new Error("source failed"); }
    await expect(store.prepareGeneration(floorId, broken(), { ...seed, chunkBytes: 500 })).rejects.toThrow("source failed");
    storage.putCadSceneObjectFile.mockRejectedValueOnce(new Error("PUT failed"));
    await expect(store.prepareGeneration(floorId, elements(["new"]), seed)).rejects.toThrow("PUT failed");
    expect((await prisma.floorMapDocument.findUniqueOrThrow({ where: { floorId } })).activeGenerationId).toBe(ref.generationId);
    expect(await prisma.floorMapGeneration.count({ where: { floorId, status: "failed" } })).toBe(2);
    expect(await prisma.floorMapChunk.count({ where: { generation: { floorId, status: "failed" } } })).toBe(0);
  });

  it("detects cross-chunk duplicate IDs and recursively splits colliding hash prefixes", async () => {
    const { createHash } = await import("node:crypto");
    const ids: string[] = [];
    for (let i = 0; ids.length < 6; i++) {
      const id = `collision-${i}`;
      if (createHash("sha256").update(id).digest("hex").startsWith("aa")) ids.push(id);
    }
    const ref = await store.prepareGeneration(floorId, elements(ids), { ...seed, chunkBytes: 700, indexBytes: 100 });
    const shards = await prisma.floorMapIndexShard.findMany({ where: { generationId: ref.generationId } });
    expect(shards.every(shard => shard.prefix.length > 2)).toBe(true);
    for (const id of ids) expect((await store.getElement(floorId, ref, id))?.id).toBe(id);
    await expect(store.prepareGeneration(floorId, elements([...ids, ids[0]]), { ...seed, chunkBytes: 700, indexBytes: 100 })).rejects.toThrow(/duplicate/i);
    await expect(prisma.floorMapIndexShard.create({ data: { ...shards[0], id: randomUUID() } })).rejects.toThrow();
  });

  it("enforces decoded document and single-element budgets before partial publication", async () => {
    await expect(store.prepareGeneration(floorId, elements(["a", "b"]), { ...seed, documentBytes: 600 })).rejects.toThrow(/budget/i);
    await expect(store.prepareGeneration(floorId, elements(["a"]), { ...seed, chunkBytes: 100 })).rejects.toThrow(/budget/i);
    expect(await prisma.floorMapDocument.count({ where: { floorId } })).toBe(0);
  });

  it("preserves explicit structure metadata and refuses missing or cyclic references", async () => {
    const groups = [{ id: "group", name: "그룹", parentId: null, locked: false, visible: true }];
    const value = { ...element("grouped"), groupId: "group" };
    async function* source() { yield value; }
    await expect(store.prepareGeneration(floorId, source(), seed)).rejects.toThrow(/missing group/);
    await expect(store.prepareGeneration(floorId, elements(["a"]), { ...seed, layers: [] })).rejects.toThrow(/missing group/);
    await expect(store.prepareGeneration(floorId, source(), { ...seed, groups: [{ ...groups[0], parentId: "group" }] })).rejects.toThrow();
    const ref = await store.prepareGeneration(floorId, source(), { ...seed, groups });
    expect((await store.readManifest(floorId, ref)).groups).toEqual(groups);
  });

  it("preserves fractional and extreme finite geometry/stroke through PostgreSQL without clipping", async () => {
    const values: MapElement[] = [
      { ...element("fractional"), type: "line", geometry: { start: { x: 0.123456789012345, y: 0.987654321098765 },
        end: { x: 10.234567890123456, y: 20.345678901234567 } } },
      { ...element("extreme"), type: "line", geometry: { start: { x: 1e200, y: 0 }, end: { x: 2e200, y: 10 } },
        style: { ...element("x").style, strokeWidth: 1e200 } }
    ];
    async function* source() { yield* values; }
    const ref = await store.prepareGeneration(floorId, source(), { ...seed, chunkBytes: 500 });
    expect(await store.getElement(floorId, ref, "fractional")).toEqual(values[0]);
    expect(await store.getElement(floorId, ref, "extreme")).toEqual(values[1]);
  });

  it("protects distinct display manifest/tile descriptors for manual-only documents", async () => {
    const ref = await store.prepareGeneration(floorId, elements(["manual"]), seed);
    const manifest = await createAsset("map_display_manifest");
    const tile = await createAsset("map_display_tile");
    const bounds = { minX: 0.123456789012345, minY: 0.987654321098765, maxX: 10.234567890123456, maxY: 20.345678901234567 };
    await store.attachDisplayAssets(floorId, ref, { manifest: manifest.ref, tiles: [{
      asset: tile.ref, tileX: 0, tileY: 0, lod: 0, part: 0, bounds
    }] });
    const rows = await prisma.floorMapDisplayAsset.findMany({ where: { generationId: ref.generationId } });
    expect(rows.map(row => row.role).sort()).toEqual(["manifest", "tile"]);
    const canonical = await store.readManifest(floorId, ref);
    expect(canonical.chunks.every(chunk => chunk.asset.assetId !== tile.ref.assetId)).toBe(true);
    storage.downloadFloorAssetToFile.mockClear();
    expect((await store.readDisplayAssets(floorId, ref))?.tiles).toEqual([{ asset: tile.ref, tileX: 0, tileY: 0, lod: 0, part: 0, bounds }]);
    expect(storage.downloadFloorAssetToFile).not.toHaveBeenCalled();
    const cleanup = new FloorAssetCleanupService(prisma as never, storage as never, new MapDocumentAssetReferences(prisma as never));
    expect((await cleanup.processPending()).deleted).toBe(0);
    await expect(store.attachDisplayAssets(floorId, ref, { manifest: manifest.ref, tiles: [] })).rejects.toThrow();
  });

  it("protects prepared and history-pinned assets from both cleanup phases", async () => {
    const ref = await activate(["keep"]);
    const revision = await prisma.floorMapRevision.create({ data: { floorId, revision: ref.revision, snapshot: {},
      snapshotSha256: "0".repeat(64), changeSummary: {}, changedBy: userId } });
    await prisma.$transaction(tx => store.pinRevision(tx, floorId, revision.id, ref));
    const assets = await prisma.floorAsset.findMany({ where: { floorId } });
    expect(await prisma.floorMapRevisionAsset.count({ where: { revisionId: revision.id } })).toBe(assets.length);
    await prisma.floorAsset.updateMany({ where: { floorId }, data: { readyAt: new Date(0), createdAt: new Date(0) } });
    const cleanup = new FloorAssetCleanupService(prisma as never, storage as never, new MapDocumentAssetReferences(prisma as never));
    expect((await cleanup.processPending()).deleted).toBe(0);
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it("prepares checkpoints outside transactions, CAS swaps only the expected head, and rolls back", async () => {
    const old = await activate(["old"]);
    await prisma.floorMapDocument.update({ where: { floorId }, data: { changesSinceCheckpoint: 100 } });
    const next = await store.prepareCheckpoint(floorId, old, elements(["next"]));
    expect(next.revision).toBe(old.revision);
    await expect(prisma.$transaction(async tx => {
      await store.commitCheckpoint(tx, floorId, old, next);
      throw new Error("rollback");
    })).rejects.toThrow("rollback");
    expect((await prisma.floorMapDocument.findUniqueOrThrow({ where: { floorId } })).activeGenerationId).toBe(old.generationId);
    await prisma.$transaction(tx => store.commitCheckpoint(tx, floorId, old, next));
    expect((await prisma.floorMapDocument.findUniqueOrThrow({ where: { floorId } })).activeGenerationId).toBe(next.generationId);
    await expect(prisma.$transaction(tx => store.commitCheckpoint(tx, floorId, old, next))).rejects.toThrow(/conflict/i);
    expect((await prisma.floor.findUniqueOrThrow({ where: { id: floorId } })).mapRevision).toBe(old.revision);
  });

  it("retires expired abandoned preparations but never active/history generations", async () => {
    const active = await activate(["active"]);
    const abandoned = await store.prepareGeneration(floorId, elements(["abandoned"]), seed);
    await prisma.floorMapGeneration.updateMany({ where: { floorId }, data: { expiresAt: new Date(0) } });
    expect(await store.reapExpiredPreparations()).toBe(1);
    expect((await prisma.floorMapGeneration.findUniqueOrThrow({ where: { id: abandoned.generationId } })).status).toBe("failed");
    expect((await prisma.floorMapGeneration.findUniqueOrThrow({ where: { id: active.generationId } })).status).toBe("active");
    await prisma.floorAsset.updateMany({ where: { floorId }, data: { readyAt: new Date(0), createdAt: new Date(0) } });
    const cleanup = new FloorAssetCleanupService(prisma as never, storage as never, new MapDocumentAssetReferences(prisma as never));
    expect((await cleanup.processPending()).deleted).toBeGreaterThan(0);
    expect(await store.getElement(floorId, active, "active")).toEqual(element("active"));
  });

  it("lets publication win against an already selected cleanup candidate", async () => {
    const ref = await store.prepareGeneration(floorId, elements(["a"]), seed);
    const manifest = await createAsset("map_display_manifest");
    const locked = deferred(), release = deferred(), selected = deferred();
    const publishingPrisma = new Proxy(prisma, { get(target, key) {
      if (key === "$transaction") return (work: (tx: any) => Promise<unknown>) => target.$transaction(async tx => {
        await tx.$queryRaw`SELECT "id" FROM "Floor" WHERE "id" = ${floorId} FOR UPDATE`;
        locked.resolve(); await release.promise;
        return work(tx);
      });
      return Reflect.get(target, key);
    } });
    const cleanupPrisma = new Proxy(prisma, { get(target, key) {
      if (key === "$queryRaw") return async (sql: any) => {
        const rows = await target.$queryRaw(sql);
        if (sql.strings.join(" ").includes('WHERE asset."status" = \'ready\'')) selected.resolve();
        return rows;
      };
      return Reflect.get(target, key);
    } });
    const publishing = new MapDocumentStore(publishingPrisma as never, storage as never)
      .attachDisplayAssets(floorId, ref, { manifest: manifest.ref, tiles: [] });
    await locked.promise;
    const cleanup = new FloorAssetCleanupService(cleanupPrisma as never, storage as never, new MapDocumentAssetReferences(prisma as never));
    const sweeping = cleanup.processPending();
    await selected.promise;
    release.resolve();
    await publishing;
    expect((await sweeping).deleted).toBe(0);
    expect(storage.deleteObject).not.toHaveBeenCalled();
  });

  it("refuses publication after cleanup has claimed an asset", async () => {
    const ref = await store.prepareGeneration(floorId, elements(["a"]), seed);
    const manifest = await createAsset("map_display_manifest");
    const claimed = deferred(), release = deferred();
    storage.deleteObject.mockImplementationOnce(async key => { claimed.resolve(); await release.promise; objects.delete(key); });
    const cleanup = new FloorAssetCleanupService(prisma as never, storage as never, new MapDocumentAssetReferences(prisma as never));
    const sweeping = cleanup.processPending();
    await claimed.promise;
    try { await expect(store.attachDisplayAssets(floorId, ref, { manifest: manifest.ref, tiles: [] })).rejects.toThrow(/ledger|cleanup/); }
    finally { release.resolve(); }
    expect((await sweeping).deleted).toBe(1);
    expect(await prisma.floorMapDisplayAsset.count({ where: { generationId: ref.generationId } })).toBe(0);
  });

  it("pins a later revision's deltas and committed stage parts without changing the base generation", async () => {
    const ref = await activate(["base"]);
    const forward = await createAsset("map_changeset"), inverse = await createAsset("map_changeset"), part = await createAsset("map_stage_part");
    const requestId = randomUUID();
    await prisma.floorMapChangeSet.create({ data: { floorId, generationId: ref.generationId, requestId, baseRevision: ref.revision, resultRevision: ref.revision + 1,
      payloadHash: forward.ref.sha256, payloadAssetId: forward.asset.id, inverseAssetId: inverse.asset.id,
      decodedBytes: forward.ref.decodedByteSize, inverseDecodedBytes: inverse.ref.decodedByteSize } });
    const stage = await prisma.floorMapStage.create({ data: { floorId, generationId: ref.generationId, requestId, userId,
      leaseTokenHash: "b".repeat(64), leaseFence: 1, requestHash: "d".repeat(64), metadata: {},
      baseRevision: ref.revision, expiresAt: new Date(0), status: "committed", partCount: 1, decodedBytes: part.ref.decodedByteSize } });
    await prisma.floorMapStagePart.create({ data: { floorId, stageId: stage.id, part: 0, assetId: part.asset.id,
      sha256: part.ref.sha256, decodedBytes: part.ref.decodedByteSize } });
    const revision = await prisma.floorMapRevision.create({ data: { floorId, revision: ref.revision + 1, snapshot: {}, snapshotSha256: "0".repeat(64),
      changeSummary: {}, changedBy: userId } });
    await prisma.$transaction(tx => store.pinRevision(tx, floorId, revision.id, { ...ref, revision: ref.revision + 1, elementCount: 2 }));
    expect(await prisma.floorMapRevisionAsset.count({ where: { revisionId: revision.id, assetId: { in: [forward.asset.id, inverse.asset.id, part.asset.id] } } })).toBe(3);
    // Stage expiry/removal cannot reclaim an inverse operation still in history.
    await prisma.floorMapStage.delete({ where: { id: stage.id } });
    const cleanup = new FloorAssetCleanupService(prisma as never, storage as never, new MapDocumentAssetReferences(prisma as never));
    expect((await cleanup.processPending()).deleted).toBe(0);
  });

  it("enforces DB request, range, identity and cross-floor ownership constraints", async () => {
    const ref = await store.prepareGeneration(floorId, elements(["a"]), seed);
    const payload = await createAsset("map_changeset");
    const data = { floorId, generationId: ref.generationId, requestId: "request", baseRevision: 0, resultRevision: 1,
      payloadHash: payload.ref.sha256, payloadAssetId: payload.asset.id, inverseAssetId: payload.asset.id, decodedBytes: 20, inverseDecodedBytes: 20 };
    await prisma.floorMapChangeSet.create({ data });
    await expect(prisma.floorMapChangeSet.create({ data: { ...data, baseRevision: 1, resultRevision: 2 } })).rejects.toThrow();
    await expect(prisma.floorMapChangeSet.create({ data: { ...data, requestId: "gap", resultRevision: 3 } })).rejects.toThrow();
    await expect(prisma.floorMapGeneration.create({ data: { id: ref.generationId, floorId, baseRevision: 0, width: 512, height: 512, gridSize: 10, expiresAt: new Date() } })).rejects.toThrow();
    await expect(prisma.floorMapChunk.updateMany({ where: { generationId: ref.generationId }, data: { floorId: "other-floor" } })).rejects.toThrow();
    await expect(prisma.floorAsset.delete({ where: { id: payload.asset.id } })).rejects.toThrow();
    await expect(prisma.floorMapGeneration.update({ where: { id: ref.generationId }, data: { manifestDecodedBytes: null } })).rejects.toThrow();
    await expect(prisma.floorMapGeneration.update({ where: { id: ref.generationId }, data: { sourceGenerationId: "source", sourceRevision: null } })).rejects.toThrow();
    const stage = await prisma.floorMapStage.create({ data: { floorId, generationId: ref.generationId, requestId: "stage", userId,
      leaseTokenHash: "c".repeat(64), leaseFence: 1, requestHash: "d".repeat(64), metadata: {}, baseRevision: 0, expiresAt: new Date() } });
    await expect(prisma.floorMapStagePart.create({ data: { floorId, stageId: stage.id, part: 1024, assetId: payload.asset.id,
      sha256: payload.ref.sha256, decodedBytes: 20 } })).rejects.toThrow();
  });

  async function activate(ids: string[]) {
    const ref = await store.prepareGeneration(floorId, elements(ids), seed);
    await prisma.floorMapGeneration.update({ where: { id: ref.generationId }, data: { status: "active" } });
    await prisma.floorMapDocument.create({ data: { floorId, activeGenerationId: ref.generationId, revision: ref.revision } });
    await prisma.floor.update({ where: { id: floorId }, data: { mapRevision: ref.revision } });
    return ref;
  }

  async function createAsset(kind: "map_display_manifest" | "map_display_tile" | "map_changeset" | "map_stage_part") {
    const id = randomUUID();
    const bytes = kind === "map_display_manifest" ? Buffer.from("{}") : Buffer.alloc(20);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const asset = await prisma.floorAsset.create({ data: { id, floorId, kind, status: "ready", objectKey: `floors/${floorId}/${id}.bin`,
      mimeType: kind === "map_display_manifest" ? "application/json" : "application/octet-stream", sizeBytes: bytes.length,
      sha256, readyAt: new Date(0), createdAt: new Date(0) } });
    objects.set(asset.objectKey, bytes);
    return { asset, ref: { assetId: id, byteSize: bytes.length, decodedByteSize: bytes.length, sha256 } };
  }
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe("checkpoint thresholds", () => {
  it("uses count OR decoded delta size", () => {
    expect(needsMapCheckpoint(99, 32 * 1024 * 1024 - 1)).toBe(false);
    expect(needsMapCheckpoint(100, 1)).toBe(true);
    expect(needsMapCheckpoint(0, 32 * 1024 * 1024)).toBe(true);
  });
});
