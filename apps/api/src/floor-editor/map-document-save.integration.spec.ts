import { Test } from "@nestjs/testing";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MapDocumentRef, MapElement } from "@led-control/shared";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { AuthService } from "../auth/auth.service";
import { PasswordService } from "../auth/password.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { ObjectStorageService } from "../storage/object-storage.service";
import { configureApiBodyParser } from "../api-body-parser";
import { FloorEditorController } from "./floor-editor.controller";
import { FloorEditorService } from "./floor-editor.service";
import { EditorLeaseService } from "./editor-lease.service";
import { MapDocumentResetService } from "./map-document-reset.service";
import { MapDocumentStore } from "./map-document-store";
import { hashEditorLeaseToken } from "./editor-lease-token";
import { MapDocumentMutationService } from "./map-document-mutation.service";
import { MapDocumentRevisionData } from "./map-document-revision-data";
import { CadMapPreparationService } from "../floor-import/cad-map-preparation.service";
import { buildCanonicalCadScene } from "../floor-import/cad-canonical-spool";
import { FloorImportService } from "../floor-import/floor-import.service";
import { FloorImportController } from "../floor-import/floor-import.controller";
import { FloorMapService } from "../floor-map/floor-map.service";
import { FloorMapController } from "../floor-map/floor-map.controller";

const url = process.env.U6A_TEST_DATABASE_URL;
(url ? describe : describe.skip)("U6a normal saves, real PostgreSQL/MinIO/HTTP/session", () => {
  jest.setTimeout(120_000);
  const prisma = new PrismaClient(url ? { datasourceUrl: url } : undefined);
  const s3 = new S3Client({ endpoint: process.env.U6A_MINIO_ENDPOINT, region: "us-east-1", forcePathStyle: true,
    credentials: { accessKeyId: process.env.U6A_MINIO_USER ?? "unused", secretAccessKey: process.env.U6A_MINIO_PASSWORD ?? "unused" } });
  const storage = new ObjectStorageService(s3, { bucket: `u6a-${randomUUID()}`, publicBaseUrl: "" });
  const store = new MapDocumentStore(prisma as never, storage);
  const access = new SiteAccessService(prisma as never), audit = new AuditService(prisma as never);
  const reset = new MapDocumentResetService(prisma as never, access, audit, store);
  const data = new MapDocumentRevisionData(prisma as never, storage, store);
  const mutations = new MapDocumentMutationService(prisma as never, access, audit, storage, store, data);
  const editor = new FloorEditorService(prisma as never, access, audit, undefined, undefined, mutations, data);
  const preparation = new CadMapPreparationService(prisma as never, storage, store);
  const imports = new FloorImportService(prisma as never, access, audit, storage, undefined, undefined, preparation, store);
  const map = new FloorMapService(prisma as never, access, undefined, audit, data);
  let app: any, base: string, token: string, user: AuthenticatedUser, floorId: string, fixtureId: string, ref: MapDocumentRef;
  const element = (id = "a"): MapElement => ({ id, type: "rectangle", geometry: { origin: { x: 20, y: 20 }, width: 20, height: 20 },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, groupId: null, layerId: "map", zIndex: 0,
    visible: true, locked: false, style: { strokeWidth: 1, strokeColor: "#000000", fillColor: null, opacity: 1 }, provenance: null });
  const input = (operations: unknown[] = []) => ({ expectedRevision: ref.revision, leaseToken: "lease", leaseFence: 1,
    fixtureUpdates: [], slotAssignments: [], objectCreates: [], objectUpdates: [], objectDeletes: [],
    documentChanges: { requestId: randomUUID(), generationId: ref.generationId, operations } });
  const http = (method: string, body?: unknown, cookie = token) => fetch(`${base}/floors/${floorId}/editor-state`, {
    method, headers: { "content-type": "application/json", ...(cookie ? { cookie: `led_session=${cookie}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  beforeAll(async () => {
    const target = new URL(url!);
    if (!/^\/led_u6a_test_/.test(target.pathname) || target.hostname !== "127.0.0.1" || target.port === "5432") throw Error("isolated DB required");
    const [identity] = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    expect(`/${identity.name}`).toBe(target.pathname);
    await s3.send(new CreateBucketCommand({ Bucket: (storage as any).options.bucket }));
    const module = await Test.createTestingModule({ controllers: [FloorEditorController, FloorImportController, FloorMapController], providers: [
      { provide: FloorMapService, useValue: map },
      { provide: FloorImportService, useValue: imports },
      { provide: FloorEditorService, useValue: editor }, { provide: MapDocumentResetService, useValue: reset },
      { provide: EditorLeaseService, useValue: {} },
      { provide: AuthService, useValue: new AuthService(prisma as never, new PasswordService(), audit) }
    ] }).compile();
    app = module.createNestApplication({ bodyParser: false }); configureApiBodyParser(app);
    await app.listen(0, "127.0.0.1"); base = await app.getUrl();
  });
  beforeEach(async () => {
    const org = await prisma.organization.create({ data: { name: "U6a", type: "customer" } });
    const row = await prisma.user.create({ data: { organizationId: org.id, loginId: randomUUID(), name: "admin", passwordHash: "unused", role: "admin" } });
    user = { ...row, role: "admin", status: "active", organizationType: "customer" };
    token = randomUUID();
    await prisma.session.create({ data: { userId: row.id, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 600_000) } });
    const site = await prisma.site.create({ data: { organizationId: org.id, adminUserId: row.id, name: "U6a" } });
    floorId = (await prisma.floor.create({ data: { siteId: site.id, name: "floor", level: 1, editorLeaseFence: 1,
      editorLeaseHolderId: row.id, editorLeaseTokenHash: hashEditorLeaseToken("lease"), editorLeaseExpiresAt: new Date(Date.now() + 600_000) } })).id;
    fixtureId = (await prisma.fixture.create({ data: { floorId, name: "lamp", ratedWatt: 40, x: 0, y: 0, placementStatus: "unplaced" } })).id;
    ref = await reset.reset(floorId, user, { requestId: randomUUID(), baseRevision: 0, leaseToken: "lease", leaseFence: 1 });
  });
  afterAll(async () => { if (app) await app.close(); await prisma.$disconnect(); s3.destroy(); });

  async function importFixture() {
    const directory = await mkdtemp(join(tmpdir(), "led-u6a-cad-"));
    try {
      const jobId = randomUUID(), bounds = { minX: 0, minY: 0, maxX: 1000, maxY: 1000 };
      const converted = await buildCanonicalCadScene({ version: 1, bounds, blocks: [], entities: [{ type: "line", layer: "WALL",
        sourceEntityId: "line", start: { x: 0, y: 0, z: 0 }, end: { x: 1000, y: 1000, z: 0 } }] },
      { regionId: "region-0123456789abcdef01234567", bounds, primitiveCount: 1, textCount: 0, lightCandidateCount: 0, area: 1e6 }, jobId, directory);
      for (const tile of converted.built.tiles) await writeFile(join(directory, `${tile.descriptor.assetId}.bin`), tile.payload);
      const prepared = await preparation.prepare(floorId, directory, converted.canonical, converted.built.manifest);
      const original = await prisma.floorAsset.create({ data: { floorId, kind: "original", status: "ready", mimeType: "application/dxf",
        objectKey: `floors/${floorId}/${randomUUID()}.dxf`, sizeBytes: 1, sha256: "a".repeat(64), readyAt: new Date() } });
      const rendered = await prisma.floorAsset.create({ data: { floorId, kind: "rendered", status: "ready", mimeType: "image/svg+xml",
        objectKey: `floors/${floorId}/${randomUUID()}.svg`, sizeBytes: 1, sha256: "b".repeat(64), readyAt: new Date() } });
      await prisma.floorImportJob.create({ data: { id: jobId, floorId, sourceAssetId: original.id, renderedAssetId: rendered.id,
        sourceFormat: "dxf", preparedMapGenerationId: prepared.generationId, status: "review_required", stage: "review_required", progressPercent: 100,
        startedAt: new Date(), reviewRequiredAt: new Date(), detectorProfileId: "generic-lighting-v1", detectorProfileVersion: "legacy-unknown",
        detectorProfileDigest: "0".repeat(64), excludedRegionPrimitiveCount: 0 } });
      const candidate = await prisma.floorImportCandidate.create({ data: { jobId, sourceEntityId: "lamp", layerName: "LIGHT", x: 200, y: 300,
        confidence: 1, detectionMethod: "rule_based" } });
      return { jobId, prepared, candidate };
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
  const applyImport = (jobId: string, candidateIds: string[]) => fetch(`${base}/floors/${floorId}/import-jobs/${jobId}/apply`, {
    method: "POST", headers: { "content-type": "application/json", cookie: `led_session=${token}` }, body: JSON.stringify({
      expectedRevision: ref.revision, leaseToken: "lease", leaseFence: 1, confirmMapReset: true, candidateIds }) });

  it("activates a real CAD preparation after its one-hour TTL while the review job pins it", async () => {
    const { jobId, prepared, candidate } = await importFixture();
    await prisma.floorMapGeneration.update({ where: { id: prepared.generationId }, data: { expiresAt: new Date(0) } });
    const response = await applyImport(jobId, [candidate.id]); expect(response.status).toBe(200);
    expect(await data.currentRef(floorId)).toEqual(prepared);
    expect((await prisma.floorImportJob.findUniqueOrThrow({ where: { id: jobId } })).preparedMapGenerationId).toBeNull();
    expect((await prisma.fixture.findUniqueOrThrow({ where: { id: fixtureId } })).placementStatus).toBe("unplaced");
    expect(await prisma.floorLightSlot.count({ where: { floorId, sourceCandidateId: candidate.id } })).toBe(1);
    expect(await prisma.floorMapRevisionAsset.count({ where: { generationId: prepared.generationId } })).toBeGreaterThan(0);
    const state = await data.readRevision(floorId, prepared);
    expect(state.document.elementCount).toBe(1);
    expect(await (await http("GET")).json()).toMatchObject({ floor: { mapDocument: prepared, cadScene: null }, objects: [] });
  });

  it("reads bounded metadata and merges same-chunk lookups without a whole generation clone", async () => {
    const items = [element("a"), element("b"), element("c")];
    const prepared = await store.prepareGeneration(floorId, (async function* () { yield* items; })(), {
      width: 1200, height: 800, gridSize: 10, groups: [], layers: [{ id: "map", name: "Map", order: 0, locked: false, visible: true }]
    });
    const reads = jest.spyOn(storage, "downloadFloorAssetToFile");
    try {
      const state = await data.readRevision(floorId, prepared);
      expect(state.overlay).toEqual([]); expect(state.deletedIds).toEqual([]);
      const found = await state.getElements(["a", "b", "c", "missing"]);
      expect(found).toEqual(items);
      const chunk = await prisma.floorMapChunk.findFirstOrThrow({ where: { generationId: prepared.generationId }, include: { asset: true } });
      expect(reads.mock.calls.filter(([key]) => key === chunk.asset.objectKey)).toHaveLength(1);
      expect(await data.currentRef(floorId)).toEqual(ref);
    } finally { reads.mockRestore(); }
  });

  it("returns only the common ref for monitoring and rejects the old immediate CAD writer", async () => {
    const floor = await prisma.floor.findUniqueOrThrow({ where: { id: floorId } });
    const path = `${base}/sites/${floor.siteId}/floors/${floorId}`;
    const headers = { "content-type": "application/json", cookie: `led_session=${token}` };
    const snapshot = await fetch(`${path}/map-snapshot`, { headers });
    expect(await snapshot.json()).toMatchObject({ mapDocument: ref, objects: [], cadScene: null });
    const response = await fetch(`${path}/cad-scene`, { method: "PUT", headers, body: JSON.stringify({
      expectedRevision: ref.revision, leaseToken: "lease", leaseFence: 1, overrideMutations: [{ operation: "delete", elementId: `cad-element-${"a".repeat(32)}`,
        locator: { tileX: 0, tileY: 0, lod: 0, part: 0 } }], layerMutations: [] }) });
    expect(response.status).toBe(409);
  });

  it("publishes add with fixture placement in one revision and replays the original response after response loss", async () => {
    const body = { ...input([{ kind: "add", element: element() }]), fixtureUpdates: [{ id: fixtureId, x: 100, y: 100, placementStatus: "placed" }] };
    const response = await http("PUT", body); expect(response.status).toBe(200);
    const saved = await response.json();
    expect(saved.floor.mapDocument).toMatchObject({ generationId: ref.generationId, revision: 2, elementCount: 1 });
    expect(saved.objects).toEqual([]);
    const replay = await http("PUT", body); expect(replay.status).toBe(200); expect(await replay.json()).toEqual(saved);
    expect((await http("PUT", { ...body, fixtureUpdates: [] })).status).toBe(409);
    expect(await prisma.floorMapRevision.count({ where: { floorId } })).toBe(2);
    expect((await http("GET")).status).toBe(200);
    expect(await (await http("GET")).json()).toMatchObject({ floor: { mapDocument: saved.floor.mapDocument } });
    const loaded = await data.readRevision(floorId, saved.floor.mapDocument);
    expect(await loaded.getElements(["a"])).toEqual([element()]);
    ref = saved.floor.mapDocument;
    const removed = await http("PUT", input([{ kind: "delete", id: "a" }])); expect(removed.status).toBe(200);
    const after = (await removed.json()).floor.mapDocument;
    const freshData = new MapDocumentRevisionData(prisma as never, storage, store);
    const reloaded = await freshData.readRevision(floorId, after);
    expect(reloaded.deletedIds).toEqual(["a"]); expect(await reloaded.getElements(["a"])).toEqual([]);
    expect((await prisma.fixture.findUniqueOrThrow({ where: { id: fixtureId } })).placementStatus).toBe("placed");
    expect(await (await http("PUT", body)).json()).toEqual(saved);
  });
  it("allows empty operations and dimensions while rejecting stale revision, expired lease and legacy writes", async () => {
    expect((await http("PUT", input())).status).toBe(200);
    expect((await http("PUT", input())).status).toBe(409);
    ref = { ...ref, revision: 2 };
    expect((await http("PUT", { ...input(), floorPlan: { imageUrl: "", sourceType: "none", originalFileUrl: null, renderedImageUrl: null, width: 2000, height: 800, gridSize: 10 } })).status).toBe(200);
    ref = (await data.currentRef(floorId))!;
    expect(ref.width).toBe(2000);
    const { documentChanges: _, ...legacy } = input();
    expect((await http("PUT", legacy)).status).toBe(409);
    await prisma.floor.update({ where: { id: floorId }, data: { editorLeaseExpiresAt: new Date(0) } });
    expect((await http("PUT", input())).status).toBe(409);
  });
  it("checks real sessions and persisted tenant/role permission", async () => {
    expect((await http("PUT", input(), "")).status).toBe(401);
    const viewer = await prisma.user.create({ data: { organizationId: user.organizationId, loginId: randomUUID(), name: "viewer", role: "viewer", passwordHash: "unused" } });
    const floor = await prisma.floor.findUniqueOrThrow({ where: { id: floorId } });
    await prisma.siteMembership.create({ data: { siteId: floor.siteId, userId: viewer.id, accessLevel: "read" } });
    await prisma.session.update({ where: { tokenHash: createHash("sha256").update(token).digest("hex") }, data: { userId: viewer.id } });
    expect((await http("PUT", input())).status).toBe(403);
  });

  async function save(operations: unknown[]) {
    const response = await http("PUT", input(operations));
    const value = await response.json();
    expect({ status: response.status, error: value.message }).toEqual({ status: 200, error: undefined });
    ref = value.floor.mapDocument; return value;
  }
  it("updates, validates refs/bounds and rolls fixture changes back with locked geometry", async () => {
    await save([{ kind: "add", element: element() }]);
    const edited = { ...element(), transform: { ...element().transform, x: 40 } };
    await save([{ kind: "update", element: edited }]);
    expect(await (await data.readRevision(floorId, ref)).getElements(["a"])).toEqual([edited]);
    for (const operations of [[{ kind: "delete", id: "missing" }], [{ kind: "add", element: { ...element("b"), layerId: "missing" } }],
      [{ kind: "add", element: { ...element("b"), transform: { ...element().transform, x: 2000 } } }]]) {
      expect((await http("PUT", input(operations))).status).toBe(400);
    }
    await save([{ kind: "update", element: { ...edited, locked: true } }]);
    const before = await prisma.fixture.findUniqueOrThrow({ where: { id: fixtureId } });
    const body = { ...input([{ kind: "delete", id: "a" }]), fixtureUpdates: [{ id: fixtureId, name: "must rollback" }] };
    expect((await http("PUT", body)).status).toBe(409);
    expect(await prisma.fixture.findUniqueOrThrow({ where: { id: fixtureId } })).toEqual(before);
    expect(await data.currentRef(floorId)).toEqual(ref);
  });
  it("deletes group subtrees atomically but never their fixture or candidate slots", async () => {
    const { jobId, prepared, candidate } = await importFixture();
    expect((await applyImport(jobId, [candidate.id])).status).toBe(200); ref = prepared;
    const slot = await prisma.floorLightSlot.findFirstOrThrow({ where: { floorId } });
    const body = { ...input(), fixtureUpdates: [{ id: fixtureId, placementStatus: "placed", x: slot.x, y: slot.y }],
      slotAssignments: [{ slotId: slot.id, assignedFixtureId: fixtureId }] };
    const assigned = await http("PUT", body); expect(assigned.status).toBe(200); ref = (await assigned.json()).floor.mapDocument;
    const layer = (await data.readRevision(floorId, ref)).layers[0];
    const parent = { id: "parent", parentId: null, name: "Parent", locked: false, visible: true };
    const child = { ...parent, id: "child", parentId: "parent" };
    await save([{ kind: "group.put", group: parent }, { kind: "group.put", group: child },
      { kind: "add", element: { ...element("grouped"), groupId: "child", layerId: layer.id } }]);
    await save([{ kind: "group.delete", id: "parent" }]);
    const fresh = await data.readRevision(floorId, ref);
    expect(await fresh.getElements(["grouped"])).toEqual([]);
    expect(fresh.groups.some(g => g.id === "parent" || g.id === "child")).toBe(false);
    expect(await prisma.floorLightSlot.findUniqueOrThrow({ where: { id: slot.id } })).toMatchObject({ assignedFixtureId: fixtureId });
    expect(await prisma.fixture.findUniqueOrThrow({ where: { id: fixtureId } })).toMatchObject({ placementStatus: "placed", x: slot.x, y: slot.y });
  });
  it("commits identical concurrent requests once, and stores forward/inverse pins", async () => {
    const body = input([{ kind: "add", element: element() }]);
    const responses = await Promise.all([http("PUT", body), http("PUT", body)]);
    expect(responses.map(r => r.status)).toEqual([200, 200]);
    const [first, second] = await Promise.all(responses.map(r => r.json())); expect(second).toEqual(first);
    const change = await prisma.floorMapChangeSet.findFirstOrThrow({ where: { floorId } });
    const pins = await prisma.floorMapRevisionAsset.findMany({ where: { floorId } });
    expect(pins.map(p => p.assetId)).toEqual(expect.arrayContaining([change.payloadAssetId, change.inverseAssetId]));
    expect(await prisma.floorMapChangeSet.count({ where: { floorId } })).toBe(1);
    await prisma.floor.update({ where: { id: floorId }, data: { editorLeaseExpiresAt: new Date(0) } });
    expect(await (await http("PUT", body)).json()).toEqual(first);
  });
  it("rolls a complete normal save back on audit failure and recovers after an asset upload failure", async () => {
    const body = input([{ kind: "add", element: element() }]);
    const auditFailure = jest.spyOn(audit, "record").mockRejectedValueOnce(new Error("injected audit failure"));
    try { expect((await http("PUT", body)).status).toBe(500); } finally { auditFailure.mockRestore(); }
    expect(await data.currentRef(floorId)).toEqual(ref);
    expect(await prisma.floorMapChangeSet.count({ where: { floorId } })).toBe(0);
    const uploadFailure = jest.spyOn(storage, "putCadSceneObjectFile").mockRejectedValueOnce(new Error("injected upload failure"));
    try { expect((await http("PUT", body)).status).toBe(500); } finally { uploadFailure.mockRestore(); }
    expect(await data.currentRef(floorId)).toEqual(ref);
    expect((await http("PUT", body)).status).toBe(200);
  });
  it.each(["lease", "job", "generation"])("revalidates import %s after asynchronous preparation reads", async mode => {
    const { jobId, prepared, candidate } = await importFixture();
    const read = preparation.readDisplayManifest.bind(preparation);
    const change = jest.spyOn(preparation, "readDisplayManifest").mockImplementationOnce(async (...args) => {
      const result = await read(...args);
      if (mode === "lease") await prisma.floor.update({ where: { id: floorId }, data: { editorLeaseExpiresAt: new Date(0) } });
      if (mode === "job") await prisma.floorImportJob.update({ where: { id: jobId }, data: { status: "cancelled", stage: "cancelled", cancelledAt: new Date() } });
      if (mode === "generation") await prisma.floorMapGeneration.update({ where: { id: prepared.generationId }, data: { status: "failed" } });
      return result;
    });
    try { expect((await applyImport(jobId, [candidate.id])).status).toBe(409); } finally { change.mockRestore(); }
    expect(await data.currentRef(floorId)).toEqual(ref);
    expect(await prisma.floorLightSlot.count({ where: { floorId } })).toBe(0);
  });
  it("rejects foreign candidate and stale prepared revision without unplacing fixtures", async () => {
    const { jobId, candidate } = await importFixture();
    expect((await applyImport(jobId, [randomUUID()])).status).toBe(400);
    await save([]);
    expect((await applyImport(jobId, [candidate.id])).status).toBe(409);
    expect(await prisma.floorMapRevision.count({ where: { floorId } })).toBe(2);
  });
  it("rolls import pointer, job pin, fixture placement and slot replacement back together", async () => {
    const { jobId, prepared, candidate } = await importFixture();
    await prisma.fixture.update({ where: { id: fixtureId }, data: { placementStatus: "placed", x: 50, y: 60 } });
    const failure = jest.spyOn(audit, "record").mockRejectedValueOnce(new Error("injected import audit failure"));
    try { expect((await applyImport(jobId, [candidate.id])).status).toBe(500); } finally { failure.mockRestore(); }
    expect(await data.currentRef(floorId)).toEqual(ref);
    expect(await prisma.floorImportJob.findUniqueOrThrow({ where: { id: jobId } })).toMatchObject({ status: "review_required", preparedMapGenerationId: prepared.generationId });
    expect(await prisma.fixture.findUniqueOrThrow({ where: { id: fixtureId } })).toMatchObject({ placementStatus: "placed", x: 50, y: 60 });
    expect(await prisma.floorLightSlot.count({ where: { floorId } })).toBe(0);
    expect((await applyImport(jobId, [candidate.id])).status).toBe(200);
  });
  it("checks layers, effective group locks and keeps the generation on ordinary structure saves", async () => {
    const layer = { id: "second", name: "Second", order: 1, locked: false, visible: true };
    const group = { id: "g", name: "G", parentId: null, locked: false, visible: true };
    await save([{ kind: "layer.put", layer }, { kind: "group.put", group }, { kind: "add", element: { ...element(), layerId: layer.id, groupId: group.id } }]);
    const generation = ref.generationId;
    await save([{ kind: "group.put", group: { ...group, locked: true } }]);
    expect((await http("PUT", input([{ kind: "layer.delete", id: layer.id }]))).status).toBe(409);
    await save([{ kind: "group.put", group }]);
    await save([{ kind: "layer.delete", id: layer.id }]);
    expect(ref.generationId).not.toBe(generation);
    expect(await (await data.readRevision(floorId, ref)).getElements(["a"])).toEqual([]);
  });
  it("rejects oversized envelopes, operation overflow, other generation and different concurrent saves", async () => {
    const oversized = { ...input(), padding: "x".repeat(1024 * 1024) };
    expect((await http("PUT", oversized)).status).toBe(413);
    expect((await http("PUT", input(Array.from({ length: 2001 }, (_, i) => ({ kind: "delete", id: String(i) }))))).status).toBe(400);
    const wrong = input(); wrong.documentChanges.generationId = randomUUID();
    expect((await http("PUT", wrong)).status).toBe(409);
    const responses = await Promise.all([http("PUT", input()), http("PUT", input())]);
    expect(responses.map(r => r.status).sort()).toEqual([200, 409]);
  });
  it("does not initialize on GET and uses explicit leased reset to create a new general document", async () => {
    const original = await prisma.floor.findUniqueOrThrow({ where: { id: floorId } });
    floorId = (await prisma.floor.create({ data: { siteId: original.siteId, name: "new", level: 2,
      editorLeaseFence: 1, editorLeaseHolderId: user.id, editorLeaseTokenHash: hashEditorLeaseToken("lease"), editorLeaseExpiresAt: new Date(Date.now() + 600_000) } })).id;
    expect(await (await http("GET")).json()).toMatchObject({ floor: { mapRevision: 0, mapDocument: null }, objects: [] });
    expect(await prisma.floorMapDocument.count({ where: { floorId } })).toBe(0);
    const initialized = await fetch(`${base}/floors/${floorId}/editor-reset`, { method: "POST", headers: {
      "content-type": "application/json", cookie: `led_session=${token}` }, body: JSON.stringify({ requestId: randomUUID(), baseRevision: 0, leaseToken: "lease", leaseFence: 1 }) });
    expect(initialized.status).toBe(201); ref = await initialized.json();
    await save([{ kind: "add", element: { ...element(), type: "ellipse", geometry: { center: { x: 100, y: 100 }, radiusX: 20, radiusY: 30 } } }]);
    expect(ref.elementCount).toBe(1);
  });
  it("compacts instead of publishing a delta that crosses the recorded normal read budget", async () => {
    await prisma.floorMapDocument.update({ where: { floorId }, data: { deltaDecodedBytes: 32 * 1024 * 1024 - 10 } });
    const response = await http("PUT", input([{ kind: "add", element: element() }]));
    expect(response.status).toBe(200);
    const current = (await data.currentRef(floorId))!;
    expect(current.generationId).not.toBe(ref.generationId);
    expect(current.elementCount).toBe(1);
    expect((await data.readRevision(floorId, current)).overlay).toEqual([]);
  });
});
