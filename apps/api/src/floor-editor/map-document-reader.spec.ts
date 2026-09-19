import { randomUUID, createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { mapDisplayManifestSchema, MapElement, MapDocumentRef } from "@led-control/shared";
import { SiteAccessService } from "../access/site-access.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PrismaService } from "../prisma/prisma.service";
import { ObjectStorageService } from "../storage/object-storage.service";
import { buildCadScene } from "../floor-import/cad-scene-builder";
import { buildMapDocumentSnapshot, hashFloorEditorSnapshot } from "./floor-editor-snapshot";
import { encodeMapPayload } from "./map-document-codec";
import { MapDocumentStore } from "./map-document-store";
import { MapDocumentRevisionData } from "./map-document-revision-data";
import { ConflictException, NotFoundException } from "@nestjs/common";
import { MapDocumentReader, MapQueryLedgerCache, MapQueryRevisionReader, MapQueryStagePreviewReader } from "./map-document-reader";

const viewer: AuthenticatedUser = { id: "viewer", organizationId: "org", organizationType: "customer",
  role: "viewer", status: "active", loginId: "viewer", name: "Viewer", mustChangePassword: false };
const admin = { ...viewer, id: "admin", role: "admin" as const };
function element(id: string): MapElement {
  return { id, type: "line", geometry: { start: { x: 10, y: 10 }, end: { x: 20, y: 20 } },
    groupId: "group", layerId: "layer", zIndex: 0, visible: true, locked: false, provenance: null,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 },
    style: { strokeColor: "#000000", fillColor: null, strokeWidth: 1, opacity: 1 } };
}

function fixture(count = 2, withDisplay = true) {
  const floorId = "floor", generationId = randomUUID();
  const bytes = new Map<string, Buffer>();
  const assets = new Map<string, any>();
  function asset(value: Buffer, kind: string, decodedByteSize = value.length) {
    const id = randomUUID(), sha256 = createHash("sha256").update(value).digest("hex");
    const objectKey = `floors/${floorId}/${id}`;
    assets.set(id, { id, floorId, objectKey, sha256, sizeBytes: BigInt(value.length), kind,
      status: "ready", cleanupStartedAt: null, mimeType: kind === "map_display_manifest" ? "application/json" : "application/octet-stream" });
    bytes.set(objectKey, value);
    return { assetId: id, sha256, byteSize: value.length, decodedByteSize };
  }
  const scene = buildCadScene({ version: 1, bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, blocks: [],
    entities: [{ type: "line", sourceEntityId: "source", layer: "WALL", start: { x: 0, y: 0, z: 0 }, end: { x: 100, y: 100, z: 0 } }] },
  { regionId: "region", bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 }, primitiveCount: 1, textCount: 0, lightCandidateCount: 0, area: 10000 },
  { sceneId: generationId, displayVersion: 2,
    onSemanticEntity: ({ primitives }) => primitives.map(primitive => element(primitive.elementId)) });
  const elements = Array.from({ length: count }, (_, i) => element(`e-${i}`));
  const chunkBytes = Buffer.from(JSON.stringify(elements));
  const chunk = asset(encodeMapPayload(chunkBytes), "map_chunk", chunkBytes.length);
  const indexBytes = Buffer.from(elements.map((e, i) => JSON.stringify([e.id, 0, i])).join("\n") + "\n");
  const index = asset(encodeMapPayload(indexBytes), "map_index", indexBytes.length);
  const manifest = { formatVersion: 1 as const, generationId, baseRevision: 1,
    width: scene.manifest.width, height: scene.manifest.height, gridSize: scene.manifest.gridSize,
    elementCount: count, groups: [{ id: "group", parentId: null, name: "Group", locked: false, visible: true }],
    layers: [{ id: "layer", name: "Layer", order: 0, locked: false, visible: true }],
    chunks: [{ ordinal: 0, asset: chunk, elementCount: count, bounds: { minX: 10, minY: 10, maxX: 20, maxY: 20 } }],
    indexes: [{ prefix: "", asset: index, elementCount: count }] };
  const manifestBytes = Buffer.from(JSON.stringify(manifest));
  const canonical = asset(encodeMapPayload(manifestBytes), "map_manifest", manifestBytes.length);
  const ref: MapDocumentRef = { formatVersion: 1, generationId, revision: 1, width: manifest.width, height: manifest.height,
    gridSize: manifest.gridSize, elementCount: count, manifest: canonical };
  const tiles = scene.tiles.map(t => ({ ...t.descriptor, assetId: asset(Buffer.from(t.payload), "map_display_tile").assetId }));
  const displayId = randomUUID();
  const { byteSize: _b, sha256: _s, ...rawScene } = scene.manifest;
  const raw = { formatVersion: 1, scene: { ...rawScene, manifestAssetId: displayId, tiles },
    displayLayerBindings: [{ layerName: "WALL", layerId: "layer" }], unsupportedEntityCounts: {}, unconvertedEntityCounts: {} };
  const display = asset(Buffer.from(JSON.stringify(raw)), "map_display_manifest");
  // Builder raw files omit their own size/hash; publication assigns the ledger ID.
  raw.scene.manifestAssetId = display.assetId;
  const rewritten = Buffer.from(JSON.stringify(raw)), row = assets.get(display.assetId);
  display.byteSize = display.decodedByteSize = rewritten.length;
  display.sha256 = row.sha256 = createHash("sha256").update(rewritten).digest("hex");
  row.sizeBytes = BigInt(rewritten.length); bytes.set(row.objectKey, rewritten);
  const head = { activeGenerationId: generationId, revision: 1 };
  const job = { id: "job", floorId, status: "review_required", preparedMapGenerationId: generationId };
  const generation = { ...manifest, id: generationId, floorId, status: "active", manifest: assets.get(canonical.assetId),
    manifestAssetId: canonical.assetId, manifestDecodedBytes: canonical.decodedByteSize };
  const prisma = {
    floor: { findUnique: jest.fn(async () => ({ id: floorId, siteId: "site", status: "active" })) },
    site: { findUnique: jest.fn(async () => ({ id: "site", organizationId: "org", adminUserId: "admin", memberships: [{ id: "member", accessLevel: "read" }] })) },
    floorMapDocument: { findUnique: jest.fn(async () => head) },
    floorMapRevision: { findUniqueOrThrow: jest.fn(async () => {
      const snapshot = buildMapDocumentSnapshot({ document: ref, fixtures: [], lightSlots: [] });
      return { snapshot, snapshotSha256: hashFloorEditorSnapshot(snapshot) };
    }) },
    floorMapGeneration: { findFirst: jest.fn(async () => generation) },
    floorImportJob: { findFirst: jest.fn(async () => job) },
    floorAsset: { findUnique: jest.fn(async ({ where }: any) => assets.get(where.id) ?? null) }
  };
  const store = { readManifest: jest.fn(async () => manifest), readDisplayAssets: jest.fn(async () => withDisplay ? ({ manifest: display,
    tiles: tiles.map(t => ({ asset: { assetId: t.assetId, sha256: t.sha256, byteSize: t.byteSize, decodedByteSize: t.byteSize },
      tileX: t.tileX, tileY: t.tileY, lod: t.lod, part: t.part, bounds: t.bounds })) }) : null) };
  const storage = {
    verifyCadSceneObject: jest.fn(async () => {}),
    downloadFloorAssetToFile: jest.fn(async (key: string, path: string, expected: any) => {
      const body = bytes.get(key)!;
      if (body.length !== expected.expectedBytes || createHash("sha256").update(body).digest("hex") !== expected.expectedSha256) throw Error("integrity mismatch");
      await writeFile(path, body);
    })
  };
  const access = new SiteAccessService(prisma as unknown as PrismaService);
  const auth = jest.spyOn(access, "assert");
  const create = (revisionReader?: MapQueryRevisionReader, stageReader?: MapQueryStagePreviewReader) => new MapDocumentReader(prisma as unknown as PrismaService,
    access, storage as unknown as ObjectStorageService, store as unknown as MapDocumentStore, revisionReader, stageReader);
  return { create, floorId, generationId, ref, manifest, prisma, storage, store, auth, assets, bytes, display, tiles, job, head, generation, elements };
}

describe("MapDocumentReader", () => {
  it("resolves a ready stage before and after every query without looking up arbitrary prepared generations", async () => {
    const f = fixture(200, false), scope = { stageId: "stage" };
    const resolvePreview = jest.fn(async () => f.ref), reader = f.create(undefined, { resolvePreview });
    expect(await reader.getDocument(admin, f.floorId, scope)).toEqual(f.ref);
    expect((await reader.getManifest(admin, f.floorId, f.ref, scope)).display.tiles).toEqual([]);
    expect(await reader.getElements(admin, f.floorId, f.ref, { ids: ["e-0"] }, scope)).toEqual([f.elements[0]]);
    expect((await reader.select(admin, f.floorId, f.ref, { groupId: "group" }, scope)).ids).toHaveLength(128);
    expect((await reader.getChanges(admin, f.floorId, f.ref, undefined, scope)).operations).toHaveLength(128);
    expect(resolvePreview).toHaveBeenCalledTimes(10);
    for (const call of resolvePreview.mock.calls) expect(call).toEqual([f.floorId, "stage", admin]);
    expect(f.prisma.floorImportJob.findFirst).not.toHaveBeenCalled();
    expect(f.prisma.floorMapGeneration.findFirst).not.toHaveBeenCalled();
    expect(f.prisma.floorMapDocument.findUnique).not.toHaveBeenCalled();
  });

  it("rechecks stage pins on warm tiles and refuses a late revoked lease", async () => {
    const f = fixture(), scope = { stageId: "stage" };
    const resolvePreview = jest.fn(async () => f.ref), reader = f.create(undefined, { resolvePreview });
    const bytes = await reader.getTile(admin, f.floorId, f.ref, f.tiles[0].assetId, scope);
    expect(bytes.length).toBe(f.tiles[0].byteSize);
    resolvePreview.mockResolvedValueOnce(f.ref).mockRejectedValueOnce(new ConflictException("stage lease expired"));
    await expect(reader.getTile(admin, f.floorId, f.ref, f.tiles[0].assetId, scope)).rejects.toMatchObject({ status: 409 });
    expect(resolvePreview).toHaveBeenCalledTimes(4);
    expect(f.store.readManifest).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["cross-floor", 404], ["other actor", 404], ["expired lease", 409], ["stale fence", 409],
    ["expired stage", 409], ["not ready", 409], ["wrong generation pin", 409]
  ] as const)("does not bypass the stage helper's %s denial", async (_reason, status) => {
    const f = fixture(), denial = status === 404 ? new NotFoundException() : new ConflictException();
    const resolvePreview = jest.fn(async () => { throw denial; });
    await expect(f.create(undefined, { resolvePreview }).getManifest(admin, f.floorId, f.ref, { stageId: "stage" }))
      .rejects.toMatchObject({ status });
    expect(resolvePreview).toHaveBeenCalledWith(f.floorId, "stage", admin);
    expect(f.storage.verifyCadSceneObject).not.toHaveBeenCalled();
    expect(f.store.readManifest).not.toHaveBeenCalled();
  });

  it("requires current manage access and refuses an unconnected stage adapter", async () => {
    const f = fixture(), scope = { stageId: "stage" }, resolvePreview = jest.fn(async () => f.ref);
    await expect(f.create(undefined, { resolvePreview }).getDocument(viewer, f.floorId, scope)).rejects.toMatchObject({ status: 403 });
    expect(resolvePreview).not.toHaveBeenCalled();
    await expect(f.create().getDocument(admin, f.floorId, scope)).rejects.toMatchObject({ status: 503 });
    expect(f.prisma.floorMapGeneration.findFirst).not.toHaveBeenCalled();
  });

  it("rejects arbitrary stage generation queries and scope-swapped page cursors", async () => {
    const f = fixture(200, false), scope = { stageId: "stage" };
    const reader = f.create(undefined, { resolvePreview: async () => f.ref });
    await expect(reader.getManifest(admin, f.floorId, { ...f.ref, generationId: randomUUID() }, scope)).rejects.toMatchObject({ status: 409 });
    expect(f.store.readManifest).not.toHaveBeenCalled();
    const page = await reader.select(admin, f.floorId, f.ref, { groupId: "group" }, scope);
    await expect(reader.select(admin, f.floorId, f.ref, { groupId: "group", cursor: page.nextCursor! }, { stageId: "other-stage" }))
      .rejects.toMatchObject({ status: 400 });
    const changes = await reader.getChanges(admin, f.floorId, f.ref, undefined, scope);
    await expect(reader.getChanges(admin, f.floorId, f.ref, changes.nextCursor!, { stageId: "other-stage" })).rejects.toMatchObject({ status: 400 });
    expect((await reader.getChanges(admin, f.floorId, f.ref, changes.nextCursor!, scope)).operations).toHaveLength(72);
  });

  it("coalesces 20 concurrent ledger decodes but authorizes all 20 tile requests", async () => {
    const f = fixture(), reader = f.create(), tile = f.tiles[0];
    const results = await Promise.all(Array.from({ length: 20 }, (_, i) => reader.getTile({ ...viewer, id: `viewer-${i}` }, f.floorId, f.ref, tile.assetId)));
    expect(results.every(bytes => bytes.byteLength === tile.byteSize)).toBe(true);
    expect(f.store.readManifest).toHaveBeenCalledTimes(1);
    expect(f.auth).toHaveBeenCalledTimes(20);
    expect(new Set(f.auth.mock.calls.map(([user]) => user.id)).size).toBe(20);
    expect(f.storage.verifyCadSceneObject).toHaveBeenCalled();
  });

  it("returns exact JSON DTO with ledger-filled size/hash from real builder output", async () => {
    const f = fixture(), result = await f.create().getManifest(viewer, f.floorId, f.ref);
    expect(mapDisplayManifestSchema.parse(JSON.parse(JSON.stringify(result)).display)).toMatchObject({
      version: 2, manifestAssetId: f.display.assetId, byteSize: f.display.byteSize, sha256: f.display.sha256 });
    expect(Object.keys(result).sort()).toEqual(["canonical", "display", "displayLayerBindings", "generationId", "groups", "layers", "revision"].sort());
  });

  it("rejects a legacy v1 common manifest instead of inferring missing paint order", async () => {
    const f = fixture(), row = f.assets.get(f.display.assetId);
    const raw = JSON.parse(f.bytes.get(row.objectKey)!.toString("utf8"));
    raw.scene.version = 1;
    for (const tile of raw.scene.tiles) tile.version = 1;
    const bytes = Buffer.from(JSON.stringify(raw));
    f.bytes.set(row.objectKey, bytes); row.sha256 = f.display.sha256 = createHash("sha256").update(bytes).digest("hex");
    row.sizeBytes = BigInt(bytes.length); f.display.byteSize = f.display.decodedByteSize = bytes.length;
    await expect(f.create().getManifest(viewer, f.floorId, f.ref)).rejects.toThrow();
  });

  it("delegates current reference resolution to the committed U6 reader before and after I/O", async () => {
    const f = fixture(), current = { ...f.ref, revision: 4 };
    const currentRef = jest.fn(async () => current);
    const reader = f.create({ currentRef, readRevision: async () => ({ document: current, groups: [], layers: [], overlay: [], deletedIds: [] }) });
    expect(await reader.getDocument(viewer, f.floorId)).toEqual(current);
    expect(currentRef).toHaveBeenCalledTimes(2);
  });

  it("also uses U6 reference semantics when instantiated without the optional revision adapter", async () => {
    const f = fixture(), lookup = jest.spyOn(MapDocumentRevisionData.prototype, "currentRef").mockResolvedValue(f.ref);
    try {
      expect(await f.create().getDocument(viewer, f.floorId)).toEqual(f.ref);
      expect(lookup).toHaveBeenCalledTimes(2);
    } finally { lookup.mockRestore(); }
  });

  it("reads a shard/chunk once for a 128-ID batch, not once per ID", async () => {
    const f = fixture(128), result = await f.create().getElements(viewer, f.floorId, f.ref, { ids: f.elements.map(e => e.id) });
    expect(result).toEqual(f.elements);
    expect(f.storage.downloadFloorAssetToFile).toHaveBeenCalledTimes(2);
  });

  it("rejects over-limit, duplicate and malformed ID requests", async () => {
    const f = fixture(), reader = f.create();
    for (const ids of [Array.from({ length: 129 }, (_, i) => `e-${i}`), ["e-0", "e-0"], [""]]) {
      await expect(reader.getElements(viewer, f.floorId, f.ref, { ids })).rejects.toThrow();
    }
  });

  it("allows viewer reads but rejects a wrong-site organization even with a warm cache", async () => {
    const f = fixture(), reader = f.create();
    await reader.getManifest(viewer, f.floorId, f.ref);
    await expect(reader.getManifest({ ...viewer, organizationId: "other" }, f.floorId, f.ref)).rejects.toThrow();
    expect(f.auth).toHaveBeenCalledTimes(2);
  });

  it("rejects arbitrary prepared generation IDs and viewer review requests", async () => {
    const f = fixture(), reader = f.create(); f.generation.status = "prepared";
    await expect(reader.getManifest(viewer, f.floorId, f.ref, "job")).rejects.toThrow();
    await expect(reader.getManifest(admin, f.floorId, { ...f.ref, generationId: randomUUID() }, "job")).rejects.toThrow();
    expect((await reader.getManifest(admin, f.floorId, f.ref, "job")).generationId).toBe(f.generationId);
    f.job.status = "cancelled";
    await expect(reader.getManifest(admin, f.floorId, f.ref, "job")).rejects.toThrow();
  });

  it.each(["sha256", "cleanup", "wrongFloor", "missing"])("rechecks %s on warm asset reads", async fault => {
    const f = fixture(), reader = f.create(); await reader.getManifest(viewer, f.floorId, f.ref);
    const row = f.assets.get(f.display.assetId);
    if (fault === "sha256") row.sha256 = null;
    if (fault === "cleanup") row.cleanupStartedAt = new Date();
    if (fault === "wrongFloor") row.floorId = "other";
    if (fault === "missing") f.assets.delete(row.id);
    await expect(reader.getManifest(viewer, f.floorId, f.ref)).rejects.toThrow();
  });

  it("evicts rejected in-flight loads and rejects late generation replacement", async () => {
    const f = fixture(), reader = f.create();
    f.store.readManifest.mockRejectedValueOnce(new Error("broken ledger"));
    await expect(reader.getManifest(viewer, f.floorId, f.ref)).rejects.toThrow("broken ledger");
    await expect(reader.getManifest(viewer, f.floorId, f.ref)).resolves.toMatchObject({ generationId: f.generationId });
    const download = f.storage.downloadFloorAssetToFile.getMockImplementation()!;
    f.storage.downloadFloorAssetToFile.mockImplementationOnce(async (...args) => {
      await download(...args);
      f.head.activeGenerationId = f.ref.generationId = randomUUID();
    });
    await expect(reader.getElements(viewer, f.floorId, f.ref, { ids: ["e-0"] })).rejects.toThrow("reference changed");
  });

  it("pages a group beyond 128 IDs without making 128 a group membership cap", async () => {
    const f = fixture(300), reader = f.create(), ids: string[] = []; let cursor: string | undefined;
    do {
      const page = await reader.select(viewer, f.floorId, f.ref, { groupId: "group", cursor });
      ids.push(...page.ids); cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(ids).toEqual(f.elements.map(e => e.id));
    expect(new Set(ids).size).toBe(300);
  });

  it("binds selection cursors to scope, revision and filter", async () => {
    const f = fixture(200), reader = f.create();
    const page = await reader.select(viewer, f.floorId, f.ref, { groupId: "group" });
    await expect(reader.select(viewer, f.floorId, f.ref, { layerId: "layer", cursor: page.nextCursor! })).rejects.toThrow();
    await expect(reader.select(viewer, f.floorId, f.ref, { groupId: "group", limit: 64, cursor: page.nextCursor! })).rejects.toThrow();
    await expect(reader.getChanges(viewer, f.floorId, f.ref, page.nextCursor!)).rejects.toThrow("invalid map cursor");
    const other = fixture(200);
    await expect(other.create().select(viewer, other.floorId, other.ref, { groupId: "group", cursor: page.nextCursor! })).rejects.toThrow("invalid map cursor");
    f.generation.status = "prepared";
    await expect(reader.select(admin, f.floorId, f.ref, { groupId: "group", cursor: page.nextCursor! }, "job")).rejects.toThrow("invalid map cursor");
  });

  it("validates stateless cursor encoding, version and position against the referenced data", async () => {
    const f = fixture(200), reader = f.create();
    const page = await reader.select(viewer, f.floorId, f.ref, { groupId: "group" });
    const envelope = JSON.parse(Buffer.from(page.nextCursor!, "base64url").toString("utf8"));
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    for (const cursor of [page.nextCursor + "=", encode({ ...envelope, version: 2 }),
      encode({ ...envelope, position: { phase: 2, chunk: 0, index: 201 } }),
      encode({ ...envelope, position: { phase: 1, chunk: 1, index: 0 } }),
      encode({ ...envelope, position: { phase: 2, chunk: 2, index: 0 } })]) {
      await expect(reader.select(viewer, f.floorId, f.ref, { groupId: "group", cursor })).rejects.toThrow("invalid map cursor");
    }
  });

  it("continues group and change pages across reader instances without turning the cursor into authorization", async () => {
    const f = fixture(200, false), firstReader = f.create(), secondReader = f.create();
    const first = await firstReader.select(viewer, f.floorId, f.ref, { groupId: "group" });
    const second = await secondReader.select(viewer, f.floorId, f.ref, { groupId: "group", cursor: first.nextCursor! });
    expect([...first.ids, ...second.ids]).toEqual(f.elements.map(e => e.id));
    const changes = await firstReader.getChanges(viewer, f.floorId, f.ref);
    expect((await secondReader.getChanges(viewer, f.floorId, f.ref, changes.nextCursor!)).operations).toHaveLength(72);
    await expect(secondReader.select({ ...viewer, organizationId: "other" }, f.floorId, f.ref,
      { groupId: "group", cursor: first.nextCursor! })).rejects.toThrow();
    expect(f.auth).toHaveBeenCalledTimes(5);
  });

  it("serves display-free base elements through bounded change pages", async () => {
    const f = fixture(200, false), reader = f.create();
    const manifest = await reader.getManifest(viewer, f.floorId, f.ref);
    expect(manifest.display.version).toBe(2);
    expect(manifest.display.tiles).toEqual([]);
    expect(mapDisplayManifestSchema.safeParse(manifest.display).success).toBe(true);
    const first = await reader.getChanges(viewer, f.floorId, f.ref);
    expect(first.operations).toHaveLength(128);
    expect(first.operations[0]).toEqual({ kind: "add", element: f.elements[0] });
    const second = await reader.getChanges(viewer, f.floorId, f.ref, first.nextCursor!);
    expect(second.operations).toHaveLength(72); expect(second.nextCursor).toBeNull();
  });

  it("returns current editable layers separately from immutable retired base bindings", async () => {
    const f = fixture(); f.ref.revision = f.head.revision = 2;
    const reader = f.create({ readRevision: async () => ({ document: f.ref, groups: [], layers: [], overlay: [], deletedIds: ["e-0", "e-1"] }) });
    const result = await reader.getManifest(viewer, f.floorId, f.ref);
    expect(result.layers).toEqual([]);
    expect(result.displayLayerBindings).toEqual([{ layerName: "WALL", layerId: "layer" }]);
  });

  it.each([false, true])("validates a future native nonempty display against canonical dimensions/grid (mismatch=%s)", async mismatch => {
    const f = fixture(), row = f.assets.get(f.display.assetId);
    const raw = JSON.parse(f.bytes.get(row.objectKey)!.toString("utf8"));
    Object.assign(raw.scene, { padding: 0, gridSize: mismatch ? 200 : f.ref.gridSize,
      sourceBounds: { minX: 0, minY: 0, maxX: f.ref.width, maxY: f.ref.height },
      transform: { scaleX: 1, scaleY: 1, translateX: 0, translateY: 0 } });
    const bytes = Buffer.from(JSON.stringify(raw));
    f.bytes.set(row.objectKey, bytes); row.sha256 = f.display.sha256 = createHash("sha256").update(bytes).digest("hex");
    row.sizeBytes = BigInt(bytes.length); f.display.byteSize = f.display.decodedByteSize = bytes.length;
    const result = f.create().getManifest(viewer, f.floorId, f.ref);
    if (mismatch) await expect(result).rejects.toThrow("display ledger mismatch");
    else expect(mapDisplayManifestSchema.safeParse((await result).display).success).toBe(true);
  });

  it("rejects an 8 MiB element batch and splits the same persisted overlay into byte-bounded pages", async () => {
    const f = fixture(); f.ref.revision = f.head.revision = 2;
    const overlay = Array.from({ length: 128 }, (_, i): MapElement => ({ ...element(`text-${i}`), type: "text",
      geometry: { position: { x: 10, y: 10 }, text: "x".repeat(65536), width: 100, height: 20, fontSize: 10 } }));
    const reader = f.create({ readRevision: async () => ({ document: f.ref, groups: f.manifest.groups,
      layers: f.manifest.layers, overlay, deletedIds: [] }) });
    await expect(reader.getElements(viewer, f.floorId, f.ref, { ids: overlay.map(e => e.id) })).rejects.toThrow("byte limit");
    const first = await reader.getChanges(viewer, f.floorId, f.ref);
    expect(first.operations.length).toBeLessThan(128);
    expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThanOrEqual(8 * 1024 * 1024);
    const second = await reader.getChanges(viewer, f.floorId, f.ref, first.nextCursor!);
    expect(first.operations.length + second.operations.length).toBe(128);
    expect(second.nextCursor).toBeNull();
  });

  it("composes persisted additions/deletions on fresh reads and does not cache authorization or delta state", async () => {
    const f = fixture(); f.ref.revision = f.head.revision = 2;
    const added = element("new");
    const revisions: MapQueryRevisionReader = { readRevision: jest.fn(async () => ({ document: f.ref,
      groups: f.manifest.groups, layers: f.manifest.layers, overlay: [added], deletedIds: ["e-0"] })) };
    const reader = f.create(revisions);
    expect(await reader.getElements(viewer, f.floorId, f.ref, { ids: ["e-0", "e-1", "new"] })).toEqual([f.elements[1], added]);
    expect((await reader.getChanges(viewer, f.floorId, f.ref)).operations).toEqual([
      { kind: "delete", id: "e-0" }, { kind: "add", element: added }]);
    expect(revisions.readRevision).toHaveBeenCalledTimes(2);
  });

  it("rejects corrupted tile bytes, stale revision and non-referenced assets", async () => {
    const f = fixture(), reader = f.create();
    await expect(reader.getElements(viewer, f.floorId, { ...f.ref, revision: 0 }, { ids: ["e-0"] })).rejects.toThrow("reference changed");
    await expect(reader.getTile(viewer, f.floorId, f.ref, f.manifest.chunks[0].asset.assetId)).rejects.toThrow("not referenced");
    const row = f.assets.get(f.tiles[0].assetId), bytes = f.bytes.get(row.objectKey)!;
    bytes[bytes.length - 1] ^= 1;
    await expect(reader.getTile(viewer, f.floorId, f.ref, row.id)).rejects.toThrow("integrity mismatch");
  });

  it("does not skip HEAD verification on a warm metadata cache", async () => {
    const f = fixture(), reader = f.create(); await reader.getManifest(viewer, f.floorId, f.ref);
    f.storage.verifyCadSceneObject.mockRejectedValueOnce(new Error("HEAD integrity mismatch"));
    await expect(reader.getManifest(viewer, f.floorId, f.ref)).rejects.toThrow("HEAD integrity mismatch");
  });

  it("does not combine two valid metadata assets into an oversized single cache entry", async () => {
    const f = fixture(), group = { id: "g-000000", parentId: null, name: "g".repeat(200), visible: true, locked: false };
    const groupBytes = Buffer.byteLength(JSON.stringify(group)) + 1;
    f.manifest.groups = Array.from({ length: Math.floor((8 * 1024 * 1024 - 4096) / groupBytes) }, (_, i) => ({ ...group, id: `g-${i.toString().padStart(6, "0")}` }));
    const raw = Buffer.from(JSON.stringify(f.manifest)); expect(raw.length).toBeLessThan(8 * 1024 * 1024);
    const encoded = encodeMapPayload(raw), row = f.assets.get(f.ref.manifest.assetId);
    f.bytes.set(row.objectKey, encoded); row.sha256 = f.ref.manifest.sha256 = createHash("sha256").update(encoded).digest("hex");
    row.sizeBytes = BigInt(encoded.length); f.ref.manifest.byteSize = encoded.length; f.ref.manifest.decodedByteSize = raw.length;
    const result = await f.create().getTile(viewer, f.floorId, f.ref, f.tiles[0].assetId);
    expect(result.length).toBe(f.tiles[0].byteSize);
  });

  it("pages persisted overlays larger than the 2000 unsaved-draft limit", async () => {
    const f = fixture(); f.ref.revision = f.head.revision = 2;
    const overlay = Array.from({ length: 2100 }, (_, i) => element(`new-${i}`));
    const reader = f.create({ readRevision: async () => ({ document: f.ref, groups: f.manifest.groups,
      layers: f.manifest.layers, overlay, deletedIds: [] }) });
    const loaded: string[] = []; let cursor: string | undefined;
    do {
      const page = await reader.getChanges(viewer, f.floorId, f.ref, cursor);
      loaded.push(...page.operations.flatMap(op => op.kind === "delete" ? [] : [op.element.id]));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(loaded).toEqual(overlay.map(e => e.id));
  });

  it("applies layer/range AND filters and includes nested group members", async () => {
    const f = fixture(0); f.ref.revision = f.head.revision = 2;
    const first = element("inside"), outside = { ...element("outside"), transform: { x: 1000, y: 0, scaleX: 1, scaleY: 1, rotation: 0 } };
    first.groupId = "child";
    const groups = [...f.manifest.groups, { id: "child", parentId: "group", name: "Child", locked: false, visible: true }];
    const reader = f.create({ readRevision: async () => ({ document: f.ref, groups, layers: f.manifest.layers,
      overlay: [first, outside], deletedIds: [] }) });
    const page = await reader.select(viewer, f.floorId, f.ref, { groupId: "group", layerId: "layer", bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 } });
    expect(page.ids).toEqual(["inside"]);
  });

  it("walks deep unordered group metadata once rather than rescanning it for every descendant", async () => {
    const f = fixture(0); f.ref.revision = f.head.revision = 2; let parentReads = 0;
    const groups = Array.from({ length: 100 }, (_, i) => ({ id: `group-${i}`, name: "Group", visible: true, locked: false,
      get parentId() { parentReads++; return i === 0 ? null : `group-${i - 1}`; } })).reverse();
    const child = { ...element("child"), groupId: "group-99" };
    const reader = f.create({ readRevision: async () => ({ document: f.ref, groups, layers: f.manifest.layers, overlay: [child], deletedIds: [] }) });
    expect((await reader.select(viewer, f.floorId, f.ref, { groupId: "group-0" })).ids).toEqual(["child"]);
    expect(parentReads).toBeLessThanOrEqual(200);
  });
});

describe("immutable decoded ledger cache budgets", () => {
  it("evicts least recently used metadata at 32 MiB and rejects entries above 8 MiB", async () => {
    const cache = new MapQueryLedgerCache(), loads = new Map<string, number>();
    const get = (key: string, size = 8 * 1024 * 1024) => cache.get(key, async () => {
      loads.set(key, (loads.get(key) ?? 0) + 1); return { value: { key }, size };
    });
    for (const key of ["a", "b", "c", "d"]) await get(key);
    await get("a"); await get("e"); await get("a"); await get("b");
    expect(loads.get("a")).toBe(1); expect(loads.get("b")).toBe(2);
    await expect(get("oversized", 8 * 1024 * 1024 + 1)).rejects.toThrow("decoded limit");
    expect(await get("oversized", 1)).toEqual({ key: "oversized" });
  });
  it("coalesces a failed load and permits a successful retry without caching the failed promise", async () => {
    const cache = new MapQueryLedgerCache(), fail = jest.fn(async () => { throw Error("fail"); });
    const outcomes = await Promise.allSettled(Array.from({ length: 20 }, () => cache.get("same", fail)));
    expect(outcomes.every(value => value.status === "rejected")).toBe(true); expect(fail).toHaveBeenCalledTimes(1);
    expect(await cache.get("same", async () => ({ value: "recovered", size: 9 }))).toBe("recovered");
  });
});
