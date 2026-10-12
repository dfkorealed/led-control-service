import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { FloorImportService } from "../floor-import/floor-import.service";
import { CadMapPreparationService } from "../floor-import/cad-map-preparation.service";
import { ObjectStorageService } from "../storage/object-storage.service";
import { DataRetentionService } from "../retention/data-retention.service";
import { FloorEditorService } from "./floor-editor.service";
import { MapDocumentStore } from "./map-document-store";
import { MapDocumentRevisionData } from "./map-document-revision-data";
import { MapDocumentCheckpointService } from "./map-document-checkpoint.service";
import { MapDocumentMutationService } from "./map-document-mutation.service";
import { MapDocumentResetService } from "./map-document-reset.service";
import { MapDocumentStagingService } from "./map-document-staging.service";
import { hashEditorLeaseToken } from "./editor-lease-token";
import { buildFloorEditorSnapshot, hashFloorEditorSnapshot } from "./floor-editor-snapshot";
import { MapDocumentRef, MapElement } from "@led-control/shared";

const enabled = process.env.FLOOR_MAP_RETENTION_TEST === "1";
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const lease = { leaseToken: "retention-test", leaseFence: 1 };

// Only the external object store is replaced. SQL, locks, publication, snapshots,
// delta composition and revision pins run through the actual production services.
function memoryStorage() {
  const objects = new Map<string, Buffer>();
  return {
    async putCadSceneObjectFile(key: string, path: string) { objects.set(key, await readFile(path)); },
    async verifyCadSceneObject(key: string, expected: { sizeBytes: number; sha256: string }) {
      const bytes = objects.get(key);
      if (!bytes || bytes.length !== expected.sizeBytes || sha(bytes) !== expected.sha256) throw Error("object integrity mismatch");
    },
    async downloadFloorAssetToFile(key: string, path: string, expected: { maxBytes: number; expectedBytes: number; expectedSha256: string }) {
      const bytes = objects.get(key);
      if (!bytes || bytes.length > expected.maxBytes || bytes.length !== expected.expectedBytes || sha(bytes) !== expected.expectedSha256) {
        throw Error("download integrity mismatch");
      }
      await writeFile(path, bytes);
    },
    async readFloorRenderedMetadata() { return { width: 1200, height: 800 }; }
  } as unknown as ObjectStorageService;
}

(enabled ? describe : describe.skip)("floor history cap on self-owned disposable PostgreSQL", () => {
  jest.setTimeout(120000);
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>, db: PrismaClient, peer: PrismaClient;
  let directory: string, databaseUrl: string, user: AuthenticatedUser, floorId: string, otherFloorId: string;
  let ref: MapDocumentRef, editor: FloorEditorService, store: MapDocumentStore, data: MapDocumentRevisionData;
  let checkpoints: MapDocumentCheckpointService, staging: MapDocumentStagingService, imports: FloorImportService;
  let access: SiteAccessService, audit: AuditService, storage: ObjectStorageService, reset: MapDocumentResetService;
  const element: MapElement = { id: "wall", type: "rectangle", geometry: { origin: { x: 10, y: 10 }, width: 20, height: 20 },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, layerId: "map", groupId: null, zIndex: 0,
    visible: true, locked: false, style: { strokeColor: "#000000", strokeWidth: 1, fillColor: null, opacity: 1 }, provenance: null };
  const input = (operations: unknown[] = []) => ({ ...lease, expectedRevision: ref.revision, fixtureUpdates: [], slotAssignments: [],
    objectCreates: [], objectUpdates: [], objectDeletes: [], documentChanges: { requestId: randomUUID(), generationId: ref.generationId, operations } });
  const retained = (id = floorId) => db.floorMapRevision.findMany({ where: { floorId: id }, orderBy: { revision: "asc" }, select: { revision: true } });

  beforeAll(async () => {
    cluster = await disposablePostgres();
    const target = new URL(cluster.database());
    target.pathname = "/postgres";
    const name = `floor_retention_${randomUUID().replaceAll("-", "")}`;
    cluster.sql(target.toString(), `CREATE DATABASE "${name}"`);
    target.pathname = `/${name}`; databaseUrl = target.toString();
    const deployed = cluster.deploy(databaseUrl);
    expect(deployed.status).toBe(0);
    db = new PrismaClient({ datasourceUrl: databaseUrl });
    peer = new PrismaClient({ datasourceUrl: databaseUrl });
    const [identity] = await db.$queryRaw<Array<{ name: string; directory: string }>>`SELECT current_database() AS name, current_setting('data_directory') AS directory`;
    expect(identity.name).toBe(name); directory = identity.directory;
    console.info(`F2 disposable created: ${name}; port=${target.port}; data=${directory}; ambient DATABASE_URL unused`);
  });
  afterAll(async () => {
    await db?.$disconnect(); await peer?.$disconnect(); cluster?.stop();
    if (directory) { expect(existsSync(directory)).toBe(false); console.info(`F2 disposable stopped and removed: ${directory}`); }
  });
  beforeEach(async () => {
    await db.$executeRawUnsafe('TRUNCATE TABLE "Organization" CASCADE');
    const org = await db.organization.create({ data: { name: "F2", type: "customer" } });
    const row = await db.user.create({ data: { organizationId: org.id, loginId: randomUUID(), name: "admin", passwordHash: "unused", role: "admin" } });
    user = { ...row, organizationType: "customer" };
    const site = await db.site.create({ data: { organizationId: org.id, adminUserId: row.id, name: "F2" } });
    const createFloor = () => db.floor.create({ data: { siteId: site.id, name: randomUUID(), level: 1, editorLeaseHolderId: row.id,
      editorLeaseFence: 1, editorLeaseTokenHash: hashEditorLeaseToken(lease.leaseToken), editorLeaseExpiresAt: new Date(Date.now() + 600000) } });
    floorId = (await createFloor()).id; otherFloorId = (await createFloor()).id;
    storage = memoryStorage(); access = new SiteAccessService(db as never); audit = new AuditService(db as never);
    store = new MapDocumentStore(db as never, storage); data = new MapDocumentRevisionData(db as never, storage, store);
    checkpoints = new MapDocumentCheckpointService(db as never, storage, store, data);
    const mutations = new MapDocumentMutationService(db as never, access, audit, storage, store, data, checkpoints);
    editor = new FloorEditorService(db as never, access, audit, undefined, undefined, mutations, data);
    reset = new MapDocumentResetService(db as never, access, audit, store);
    staging = new MapDocumentStagingService(db as never, access, audit, storage, store, data, checkpoints, editor);
    imports = new FloorImportService(db as never, access, audit, storage, undefined, undefined,
      new CadMapPreparationService(db as never, storage, store), store);
  });

  async function nativeHistory() {
    ref = await reset.reset(floorId, user, { ...lease, requestId: randomUUID(), baseRevision: 0 });
    for (let i = 0; i < 29; i++) {
      const result = await editor.saveEditorState(user, floorId, input(i === 0 ? [{ kind: "add", element }] : []));
      ref = result.floor.mapDocument!;
    }
    expect(ref.revision).toBe(30);
  }
  async function seedLegacy(count: number, id = floorId, start = 1) {
    const floor = await db.floor.findUniqueOrThrow({ where: { id }, include: { floorPlan: true, fixtures: true, mapObjects: true } });
    const snapshot = buildFloorEditorSnapshot(floor);
    await db.floorMapRevision.createMany({ data: Array.from({ length: count }, (_, i) => ({ floorId: id, revision: start + i,
      snapshot: snapshot as never, snapshotSha256: hashFloorEditorSnapshot(snapshot), changeSummary: {}, changedBy: user.id,
      createdAt: new Date("2026-10-12T00:00:00Z") })) });
    await db.floor.update({ where: { id }, data: { mapRevision: start + count - 1 } });
  }
  async function expectThirty(current: number) {
    const rows = await retained();
    expect(rows).toHaveLength(30);
    expect(rows[0].revision).toBe(current - 29); expect(rows.at(-1)!.revision).toBe(current);
    expect((await db.floor.findUniqueOrThrow({ where: { id: floorId } })).mapRevision).toBe(current);
  }

  it.each([28, 29, 30])("legacy save with %i existing revisions keeps at most 30 and does not prune another floor", async count => {
    await seedLegacy(count); await seedLegacy(31, otherFloorId);
    await editor.saveEditorState(user, floorId, { ...lease, expectedRevision: count, fixtureUpdates: [], objectCreates: [], objectUpdates: [], objectDeletes: [] });
    const rows = await retained(); expect(rows).toHaveLength(Math.min(count + 1, 30));
    expect(rows[0].revision).toBe(count === 30 ? 2 : 1); expect(rows.at(-1)!.revision).toBe(count + 1);
    expect(await retained(otherFloorId)).toHaveLength(31);
  });
  it("legacy restore of the oldest retained revision produces a new monotonic revision with a surviving source number", async () => {
    await seedLegacy(30, floorId, 71);
    await editor.restoreEditorRevision(user, floorId, 71, { ...lease, expectedRevision: 100 });
    await expectThirty(101);
    expect((await db.floorMapRevision.findUniqueOrThrow({ where: { floorId_revision: { floorId, revision: 101 } } })).restoredFromRevision).toBe(71);
    await expect(editor.restoreEditorRevision(user, floorId, 71, { ...lease, expectedRevision: 101 })).rejects.toThrow("floor revision not found");
  });
  it("normal save preserves base/deltas/shared pins, lists 30 rows and replays without another revision", async () => {
    await nativeHistory();
    const base = await db.floorMapGeneration.findUniqueOrThrow({ where: { id: ref.generationId } });
    const pinned = await db.floorMapRevisionAsset.findMany({ where: { floorId, revision: { revision: 30 } } });
    const request = input(); const result = await editor.saveEditorState(user, floorId, request);
    await expectThirty(31); expect(await editor.saveEditorState(user, floorId, request)).toEqual(JSON.parse(JSON.stringify(result)));
    const current = (await data.currentRef(floorId))!;
    expect(current.revision).toBe(31); await expect((await data.readRevision(floorId, current)).getElements(["wall"]).then(rows => rows[0])).resolves.toEqual(element);
    expect(await db.floorMapGeneration.findUnique({ where: { id: base.id } })).toEqual(base);
    expect(await db.floorMapChangeSet.count({ where: { floorId } })).toBe(30);
    expect(await db.floorMapRevisionAsset.findMany({ where: { floorId, revision: { revision: 30 } } })).toEqual(pinned);
    expect(await db.floorMapRevisionAsset.count({ where: { revision: { floorId, revision: 1 } } })).toBe(0);
    expect((await editor.listEditorRevisions(user, floorId, { limit: 100 })).items).toHaveLength(30);
    expect((await editor.listEditorRevisions(user, floorId, { limit: 20 })).nextCursor).toBe(12);
  });
  it("checkpoint save prunes history without deleting the retired generation or its retained restoration data", async () => {
    await nativeHistory(); const previous = ref;
    const state = await editor.saveEditorState(user, floorId, { ...input(), floorPlan: { sourceType: "none", imageUrl: "", originalFileUrl: null,
      renderedImageUrl: null, width: ref.width + 100, height: ref.height, gridSize: ref.gridSize } });
    await expectThirty(31); expect(state.floor.mapDocument!.generationId).not.toBe(previous.generationId);
    expect((await data.readRevision(floorId, previous)).document.revision).toBe(30);
    expect((await db.floorMapGeneration.findUniqueOrThrow({ where: { id: previous.generationId } })).status).toBe("retired");
  });
  it("native restore at the oldest boundary preserves its geometry and can be edited after pruning the source", async () => {
    await nativeHistory(); await editor.saveEditorState(user, floorId, input()); await expectThirty(31);
    const result = await editor.restoreEditorRevision(user, floorId, 2, { ...lease, expectedRevision: 31 });
    await expectThirty(32); ref = result.floor.mapDocument!;
    await expect((await data.readRevision(floorId, ref)).getElements(["wall"])).resolves.toEqual([element]);
    expect((await db.floorMapRevision.findUniqueOrThrow({ where: { floorId_revision: { floorId, revision: 32 } } })).restoredFromRevision).toBe(2);
    await expect(editor.restoreEditorRevision(user, floorId, 2, { ...lease, expectedRevision: 32 })).rejects.toThrow("map revision not found");
    await editor.saveEditorState(user, floorId, input()); await expectThirty(33);
  });
  it.each([false, true])("staged publication historySource=%s retains 30, stage parts and exact replay", async history => {
    await nativeHistory();
    const stage = await staging.create(floorId, user, { ...input(), ...(history ? { historySource: { revision: 2 } } : {}) });
    let intent: object = lease;
    if (!history) {
      const bytes = Buffer.from("[]");
      await staging.part(floorId, stage.id, "0", user, { ...lease, data: bytes.toString("base64"), sha256: sha(bytes) });
      intent = { ...lease, partCount: 1, decodedBytes: bytes.length, sha256: sha(bytes) };
    }
    await staging.commit(floorId, stage.id, user, intent); await staging.processPending();
    const status = await staging.status(floorId, stage.id, user); expect(status.status).toBe("committed");
    await expectThirty(31); expect((await staging.commit(floorId, stage.id, user, intent)).result).toEqual(status.result);
    if (!history) expect(await db.floorMapStagePart.count({ where: { stageId: stage.id } })).toBe(1);
    expect((await data.readRevision(floorId, (await data.currentRef(floorId))!)).document.elementCount).toBe(1);
  });
  async function importJob(prepared?: MapDocumentRef) {
    const asset = (kind: "original" | "rendered") => db.floorAsset.create({ data: { floorId, kind, status: "ready", mimeType: kind === "original" ? "application/dxf" : "image/svg+xml",
      objectKey: `floors/${floorId}/${randomUUID()}`, sizeBytes: 1, sha256: "a".repeat(64), readyAt: new Date() } });
    const source = await asset("original"), rendered = await asset("rendered");
    return db.floorImportJob.create({ data: { floorId, sourceAssetId: source.id, renderedAssetId: rendered.id, sourceFormat: "dxf",
      status: "review_required", stage: "review_required", progressPercent: 100, startedAt: new Date(), reviewRequiredAt: new Date(), detectorProfileId: "generic-lighting-v1",
      detectorProfileVersion: "legacy-unknown", detectorProfileDigest: "0".repeat(64), excludedRegionPrimitiveCount: 0,
      preparedMapGenerationId: prepared?.generationId } });
  }
  it.each([false, true])("CAD apply native=%s saves and prunes atomically while preserving import assets", async native => {
    let service = imports; let prepared: MapDocumentRef | undefined;
    if (native) {
      await nativeHistory();
      prepared = await checkpoints.prepare(floorId, ref, (async function* () {})());
    } else {
      await seedLegacy(30); service = new FloorImportService(db as never, access, audit, storage);
    }
    const job = await importJob(prepared);
    const result = await service.apply(user, floorId, job.id, { ...lease, expectedRevision: 30, confirmMapReset: true, candidateIds: [] });
    expect(result.revision).toBe(31); await expectThirty(31);
    expect((await db.floorImportJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe("completed");
    expect(await db.floorAsset.count({ where: { id: { in: [job.sourceAssetId, job.renderedAssetId!] } } })).toBe(2);
    if (native) expect(await data.currentRef(floorId)).toEqual(prepared);
  });
  it("publication and pruning roll back together after a later audit failure", async () => {
    await nativeHistory(); const before = await retained(); const pins = await db.floorMapRevisionAsset.count({ where: { floorId } });
    const failure = jest.spyOn(audit, "record").mockRejectedValueOnce(new Error("injected audit failure"));
    try { await expect(editor.saveEditorState(user, floorId, input())).rejects.toThrow("injected audit failure"); } finally { failure.mockRestore(); }
    expect(await retained()).toEqual(before); expect(await data.currentRef(floorId)).toEqual(ref);
    expect(await db.floorMapRevisionAsset.count({ where: { floorId } })).toBe(pins);
  });
  it("worker removes even recent overflow, preserves the live head and leaves another writer's Floor lock alone", async () => {
    await seedLegacy(31); await seedLegacy(31, otherFloorId);
    let release!: () => void, entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const wait = new Promise<void>(resolve => { release = resolve; });
    const lock = peer.$transaction(async tx => { await tx.$queryRaw`SELECT "id" FROM "Floor" WHERE "id" = ${floorId} FOR UPDATE`; entered(); await wait; }, { timeout: 10000 });
    await ready;
    try {
      const result = await new DataRetentionService(db as never).prune(); expect(result.floorMapRevisions).toBe(1);
      expect(await retained()).toHaveLength(31); expect(await retained(otherFloorId)).toHaveLength(30);
    } finally { release(); await lock; }
    expect((await new DataRetentionService(db as never).prune()).floorMapRevisions).toBe(1); await expectThirty(31);
  });
});
