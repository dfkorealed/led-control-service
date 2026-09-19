import { Test } from "@nestjs/testing";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
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
    const module = await Test.createTestingModule({ controllers: [FloorEditorController], providers: [
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
  it("allows empty operations and rejects stale revision, expired lease, legacy writes and dimensions", async () => {
    expect((await http("PUT", input())).status).toBe(200);
    expect((await http("PUT", input())).status).toBe(409);
    ref = { ...ref, revision: 2 };
    expect((await http("PUT", { ...input(), floorPlan: { imageUrl: "", sourceType: "none", originalFileUrl: null, renderedImageUrl: null, width: 2000, height: 800, gridSize: 10 } })).status).toBe(409);
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
});
