import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash, randomUUID } from "node:crypto";
import { MapDocumentRef, MapElement } from "@led-control/shared";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { AuthService } from "../auth/auth.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { PasswordService } from "../auth/password.service";
import { ObjectStorageService } from "../storage/object-storage.service";
import { configureApiBodyParser } from "../api-body-parser";
import { FloorEditorController } from "./floor-editor.controller";
import { FloorEditorService } from "./floor-editor.service";
import { EditorLeaseService } from "./editor-lease.service";
import { MapDocumentResetService } from "./map-document-reset.service";
import { MapDocumentStore } from "./map-document-store";
import { MapDocumentRevisionData } from "./map-document-revision-data";
import { MapDocumentMutationService } from "./map-document-mutation.service";
import { MapDocumentCheckpointService } from "./map-document-checkpoint.service";
import { MapDocumentStagingService } from "./map-document-staging.service";
import { MapDocumentStagingController } from "./map-document-staging.controller";
import { MapDocumentReader } from "./map-document-reader";
import { MapDocumentQueryController } from "./map-document-query.controller";
import { hashEditorLeaseToken } from "./editor-lease-token";

const url = process.env.U6B_TEST_DATABASE_URL;
(url ? describe : describe.skip)("U6b real PostgreSQL MinIO session HTTP", () => {
  jest.setTimeout(120000);
  const prisma = new PrismaClient(url ? { datasourceUrl: url } : undefined);
  const s3 = new S3Client({ endpoint: process.env.U6B_MINIO_ENDPOINT, region: "us-east-1", forcePathStyle: true,
    credentials: { accessKeyId: process.env.U6B_MINIO_USER ?? "unused", secretAccessKey: process.env.U6B_MINIO_PASSWORD ?? "unused" } });
  const storage = new ObjectStorageService(s3, { bucket: `u6b-${randomUUID()}`, publicBaseUrl: "" });
  const store = new MapDocumentStore(prisma as never, storage), access = new SiteAccessService(prisma as never), audit = new AuditService(prisma as never);
  const data = new MapDocumentRevisionData(prisma as never, storage, store);
  const checkpoints = new MapDocumentCheckpointService(prisma as never, storage, store, data);
  const mutations = new MapDocumentMutationService(prisma as never, access, audit, storage, store, data, checkpoints);
  const editor = new FloorEditorService(prisma as never, access, audit, undefined, undefined, mutations, data);
  const reset = new MapDocumentResetService(prisma as never, access, audit, store);
  const staging = new MapDocumentStagingService(prisma as never, access, audit, storage, store, data, checkpoints, editor);
  let app: any, base: string, cookie: string, user: AuthenticatedUser, floorId: string, ref: MapDocumentRef, fixtureId: string;
  const lease = { leaseToken: "lease", leaseFence: 1 };
  const element = (id: string): MapElement => ({ id, type: "rectangle", geometry: { origin: { x: 10, y: 10 }, width: 20, height: 20 },
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, groupId: null, layerId: "map", zIndex: 0,
    visible: true, locked: false, style: { strokeWidth: 1, strokeColor: "#000000", fillColor: null, opacity: 1 }, provenance: null });
  const input = () => ({ ...lease, expectedRevision: ref.revision, fixtureUpdates: [], slotAssignments: [],
    objectCreates: [], objectUpdates: [], objectDeletes: [], documentChanges: { requestId: randomUUID(), generationId: ref.generationId, operations: [] } });
  const http = (method: string, path: string, body?: unknown, token = cookie) => fetch(`${base}/floors/${floorId}/${path}`, {
    method, headers: { "content-type": "application/json", ...(token ? { cookie: `led_session=${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  beforeAll(async () => {
    const target = new URL(url!);
    if (!/^\/led_u6b_test_/.test(target.pathname) || target.hostname !== "127.0.0.1" || target.port === "5432") throw Error("isolated DB required");
    await s3.send(new CreateBucketCommand({ Bucket: (storage as any).options.bucket }));
    const module = await Test.createTestingModule({ controllers: [FloorEditorController, MapDocumentStagingController, MapDocumentQueryController], providers: [
      { provide: FloorEditorService, useValue: editor }, { provide: MapDocumentResetService, useValue: reset },
      { provide: EditorLeaseService, useValue: {} }, { provide: MapDocumentStagingService, useValue: staging },
      { provide: MapDocumentReader, useValue: new MapDocumentReader(prisma as never, access, storage, store, data, staging) },
      { provide: AuthService, useValue: new AuthService(prisma as never, new PasswordService(), audit) }
    ] }).compile();
    app = module.createNestApplication({ bodyParser: false }); configureApiBodyParser(app); await app.listen(0, "127.0.0.1"); base = await app.getUrl();
  });
  beforeEach(async () => {
    const org = await prisma.organization.create({ data: { name: "U6b", type: "customer" } });
    const row = await prisma.user.create({ data: { organizationId: org.id, loginId: randomUUID(), name: "admin", passwordHash: "unused", role: "admin" } });
    user = { ...row, role: "admin", status: "active", organizationType: "customer" }; cookie = randomUUID();
    await prisma.session.create({ data: { userId: row.id, tokenHash: sha(Buffer.from(cookie)), expiresAt: new Date(Date.now() + 600000) } });
    const site = await prisma.site.create({ data: { organizationId: org.id, adminUserId: row.id, name: "U6b" } });
    floorId = (await prisma.floor.create({ data: { siteId: site.id, name: "floor", level: 1, editorLeaseFence: 1,
      editorLeaseHolderId: row.id, editorLeaseTokenHash: hashEditorLeaseToken("lease"), editorLeaseExpiresAt: new Date(Date.now() + 600000) } })).id;
    fixtureId = (await prisma.fixture.create({ data: { floorId, name: "lamp", ratedWatt: 40, x: 0, y: 0, placementStatus: "unplaced" } })).id;
    ref = await reset.reset(floorId, user, { requestId: randomUUID(), baseRevision: 0, ...lease });
  });
  afterAll(async () => { if (app) await app.close(); await prisma.$disconnect(); s3.destroy(); });
  async function upload(operations: unknown[], envelope: unknown = input()) {
    const created = await http("POST", "editor-stages", envelope); expect(created.status).toBe(201);
    const stage = await created.json() as { id: string };
    const bytes = Buffer.from(JSON.stringify(operations));
    let count = 0;
    for (let offset = 0; offset < bytes.length; offset += 512 * 1024) {
      const part = bytes.subarray(offset, offset + 512 * 1024);
      const uploaded = await http("PUT", `editor-stages/${stage.id}/parts/${count++}`, { ...lease, data: part.toString("base64"), sha256: sha(part) });
      expect(uploaded.status).toBe(200);
    }
    return { stage, intent: { ...lease, partCount: count, decodedBytes: bytes.length, sha256: sha(bytes) } };
  }
  async function finish(id: string) {
    await staging.processPending();
    const response = await http("GET", `editor-stages/${id}`); expect(response.status).toBe(200);
    return response.json() as Promise<any>;
  }
  it("stages 2101 operations, returns 202, and atomically publishes compact display plus fixture state", async () => {
    const envelope = { ...input(), fixtureUpdates: [{ id: fixtureId, x: 50, y: 60, placementStatus: "placed" }] };
    const { stage, intent } = await upload(Array.from({ length: 2101 }, (_, i) => ({ kind: "add", element: element(String(i)) })), envelope);
    expect(await data.currentRef(floorId)).toEqual(ref);
    expect((await http("POST", `editor-stages/${stage.id}/commit`, intent)).status).toBe(202);
    const status = await finish(stage.id); expect(status.status).toBe("committed");
    const current = (await data.currentRef(floorId))!;
    expect(current.elementCount).toBe(2101); expect(current.revision).toBe(ref.revision + 1);
    expect((await store.readDisplayAssets(floorId, current))!.tiles.length).toBeGreaterThan(0);
    expect((await data.readRevision(floorId, current)).overlay).toEqual([]);
    expect((await prisma.fixture.findUniqueOrThrow({ where: { id: fixtureId } })).x).toBe(50);
    await prisma.floor.update({ where: { id: floorId }, data: { editorLeaseExpiresAt: new Date(0) } });
    await prisma.floorMapStage.update({ where: { id: stage.id }, data: { expiresAt: new Date(0) } });
    expect((await http("POST", `editor-stages/${stage.id}/commit`, { ...intent, leaseToken: "different" })).status).toBe(409);
    expect((await http("POST", `editor-stages/${stage.id}/commit`, { ...intent, leaseFence: 2 })).status).toBe(409);
    expect((await http("POST", `editor-stages/${stage.id}/commit`, intent)).status).toBe(202);
    expect((await finish(stage.id)).result).toEqual(status.result);
    expect(await prisma.floorMapRevision.count({ where: { floorId } })).toBe(2);
  });
  it("saves real dimensions and grid, and rejects a shrink that would lose retained placement", async () => {
    const request = { ...input(), floorPlan: { sourceType: "none", imageUrl: "", originalFileUrl: null, renderedImageUrl: null,
      width: 2048, height: 1024, gridSize: 25 } };
    const saved = await http("PUT", "editor-state", request); expect(saved.status).toBe(200);
    ref = (await data.currentRef(floorId))!; expect(ref).toMatchObject({ width: 2048, height: 1024, gridSize: 25 });
    await prisma.fixture.update({ where: { id: fixtureId }, data: { x: 1500, y: 30, placementStatus: "placed" } });
    expect((await http("PUT", "editor-state", { ...input(), floorPlan: { ...request.floorPlan, width: 1024 } })).status).toBe(400);
    expect(await data.currentRef(floorId)).toEqual(ref);
  });

  it("validates authentication, immutable sequential parts, complete intent and decoded hashes", async () => {
    expect((await http("POST", "editor-stages", input(), "")).status).toBe(401);
    const created = await http("POST", "editor-stages", input()), stage = await created.json() as { id: string };
    const bytes = Buffer.from("[]"), part = { ...lease, data: bytes.toString("base64"), sha256: sha(bytes) };
    expect((await http("PUT", `editor-stages/${stage.id}/parts/1`, part)).status).toBe(409);
    expect((await http("PUT", `editor-stages/${stage.id}/parts/0`, { ...part, sha256: "a".repeat(64) })).status).toBe(400);
    expect((await http("PUT", `editor-stages/${stage.id}/parts/0`, part)).status).toBe(200);
    expect((await http("PUT", `editor-stages/${stage.id}/parts/0`, part)).status).toBe(200);
    const other = Buffer.from("[ ]");
    expect((await http("PUT", `editor-stages/${stage.id}/parts/0`, { ...part, data: other.toString("base64"), sha256: sha(other) })).status).toBe(409);
    expect((await http("POST", `editor-stages/${stage.id}/commit`, { ...lease, partCount: 2, decodedBytes: 3, sha256: sha(bytes) })).status).toBe(409);
    expect(await data.currentRef(floorId)).toEqual(ref);
  });

  it("rejects malformed complete streams and permits corrected new requests without partial publication", async () => {
    const { stage, intent } = await upload([{ kind: "delete", id: "missing" }]);
    expect((await http("POST", `editor-stages/${stage.id}/commit`, intent)).status).toBe(202);
    expect((await finish(stage.id)).status).toBe("failed");
    expect(await data.currentRef(floorId)).toEqual(ref);
    const next = await upload([{ kind: "add", element: element("valid") }]);
    expect((await http("POST", `editor-stages/${next.stage.id}/commit`, next.intent)).status).toBe(202);
    expect((await finish(next.stage.id)).status).toBe("committed");
  });

  it.each([false, true])("rolls activation back and retries exactly once (published preview=%s)", async publishedPreview => {
    const request = await upload([{ kind: "add", element: element("atomic") }], {
      ...input(), fixtureUpdates: [{ id: fixtureId, x: 70, y: 80, placementStatus: "placed" }]
    });
    let preview: MapDocumentRef | undefined;
    if (publishedPreview) {
      expect((await http("POST", `editor-stages/${request.stage.id}/prepare`, request.intent)).status).toBe(202);
      const ready = await finish(request.stage.id); expect(ready.status).toBe("ready"); preview = ready.preview;
    }
    const failure = jest.spyOn(audit, "record").mockRejectedValueOnce(new Error("injected audit failure"));
    try {
      expect((await http("POST", `editor-stages/${request.stage.id}/commit`, request.intent)).status).toBe(202);
      expect((await finish(request.stage.id)).status).toBe("failed");
    } finally { failure.mockRestore(); }
    expect(await data.currentRef(floorId)).toEqual(ref);
    expect(await prisma.fixture.findUniqueOrThrow({ where: { id: fixtureId } })).toMatchObject({ x: 0, y: 0, placementStatus: "unplaced" });
    expect(await prisma.floorMapRevision.count({ where: { floorId } })).toBe(1);
    if (preview) {
      expect((await prisma.floorMapStage.findUniqueOrThrow({ where: { id: request.stage.id } })).preparedGenerationId).toBe(preview.generationId);
      expect(await staging.resolvePreview(floorId, request.stage.id, user)).toEqual(preview);
      expect(await (await http("GET", `editor-stages/${request.stage.id}/map-document`)).json()).toEqual(preview);
    }
    expect((await http("POST", `editor-stages/${request.stage.id}/commit`, request.intent)).status).toBe(202);
    const status = await finish(request.stage.id); expect(status.status).toBe("committed");
    if (preview) expect(status.result.floor.mapDocument).toEqual(preview);
    expect((await http("POST", `editor-stages/${request.stage.id}/commit`, request.intent)).status).toBe(202);
    expect((await finish(request.stage.id)).result).toEqual(status.result);
    expect(await prisma.floorMapRevision.count({ where: { floorId } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { targetId: floorId, action: "floor_editor.stage_committed" } })).toBe(1);
  });

  it("fences cancelled, expired, stale-lease and disabled-user work while keeping the map unchanged", async () => {
    const first = await upload([{ kind: "add", element: element("cancelled") }]);
    expect((await http("DELETE", `editor-stages/${first.stage.id}`, lease)).status).toBe(200);
    expect((await http("POST", `editor-stages/${first.stage.id}/commit`, first.intent)).status).toBe(409);
    const second = await upload([]);
    await prisma.floorMapStage.update({ where: { id: second.stage.id }, data: { expiresAt: new Date(0) } });
    await staging.reapExpired();
    expect((await finish(second.stage.id)).status).toBe("expired");
    expect(await prisma.floorMapStagePart.count({ where: { stageId: second.stage.id } })).toBe(0);
    const third = await upload([]);
    expect((await http("POST", `editor-stages/${third.stage.id}/commit`, third.intent)).status).toBe(202);
    await prisma.$transaction(async tx => {
      await tx.site.updateMany({ where: { adminUserId: user.id }, data: { adminUserId: null } });
      await tx.user.update({ where: { id: user.id }, data: { status: "disabled" } });
    });
    await staging.processPending();
    expect((await prisma.floorMapStage.findUniqueOrThrow({ where: { id: third.stage.id } })).status).toBe("failed");
    expect(await data.currentRef(floorId)).toEqual(ref);
  });

  it("prepares bounded history undo as a private draft and publishes only on explicit commit", async () => {
    const baseRevision = ref.revision;
    const saved = await http("PUT", "editor-state", { ...input(), documentChanges: { ...input().documentChanges,
      operations: [{ kind: "add", element: element("changed") }] } });
    expect(saved.status).toBe(200); ref = (await data.currentRef(floorId))!;
    const created = await http("POST", "editor-stages", { ...input(), historySource: { revision: baseRevision } });
    expect(created.status).toBe(201); const stage = await created.json() as { id: string };
    expect((await http("POST", `editor-stages/${stage.id}/prepare`, lease)).status).toBe(202);
    const ready = await finish(stage.id); expect(ready.status).toBe("ready"); expect(ready.preview.elementCount).toBe(0);
    expect(await staging.resolvePreview(floorId, stage.id, user)).toEqual(ready.preview);
    expect(await (await http("GET", `editor-stages/${stage.id}/map-document`)).json()).toEqual(ready.preview);
    expect(await data.currentRef(floorId)).toEqual(ref);
    expect((await http("POST", `editor-stages/${stage.id}/commit`, lease)).status).toBe(202);
    expect((await finish(stage.id)).status).toBe("committed");
    expect((await data.currentRef(floorId))!.elementCount).toBe(0);
    await expect(staging.resolvePreview(floorId, stage.id, user)).rejects.toThrow();
    expect((await http("GET", `editor-stages/${stage.id}/map-document`)).status).toBe(409);
  });

  it("reads same-revision checkpoint head while preserving the historical snapshot and pins", async () => {
    expect((await http("PUT", "editor-state", { ...input(), documentChanges: { ...input().documentChanges,
      operations: [{ kind: "add", element: element("checkpoint") }] } })).status).toBe(200);
    ref = (await data.currentRef(floorId))!;
    const historical = await prisma.floorMapRevision.findUniqueOrThrow({ where: { floorId_revision: { floorId, revision: ref.revision } } });
    const pins = await prisma.floorMapRevisionAsset.findMany({ where: { revisionId: historical.id }, orderBy: { assetId: "asc" } });
    const prepared = await store.prepareCheckpoint(floorId, ref, checkpoints.iterate(floorId, ref));
    await prisma.floorMapDocument.update({ where: { floorId }, data: { changesSinceCheckpoint: 100 } });
    await prisma.$transaction(tx => store.commitCheckpoint(tx, floorId, ref, prepared));
    expect(await data.currentRef(floorId)).toEqual(prepared);
    expect(await (await http("GET", "map-document")).json()).toEqual(prepared);
    expect(await prisma.floorMapRevision.findUniqueOrThrow({ where: { id: historical.id } })).toEqual(historical);
    expect(await prisma.floorMapRevisionAsset.findMany({ where: { revisionId: historical.id }, orderBy: { assetId: "asc" } })).toEqual(pins);
    expect((await (await data.readRevision(floorId, ref)).getElements(["checkpoint"]))[0].id).toBe("checkpoint");
    await expect(prisma.$transaction(tx => store.commitCheckpoint(tx, floorId, ref, prepared))).rejects.toThrow(/conflict/);
  });

  it("keeps a >32MiB inverse server-side and serves authenticated bounded history draft preview after upload expiry", async () => {
    const operations = Array.from({ length: 3500 }, (_, i) => ({ kind: "add", element: {
      ...element(String(i)), type: "text", geometry: { position: { x: 10, y: 10 }, width: 100, height: 10,
        fontSize: 10, text: "x".repeat(10000) }
    } }));
    expect(Buffer.byteLength(JSON.stringify(operations))).toBeGreaterThan(32 * 1024 * 1024);
    const initial = await upload(operations);
    expect((await http("POST", `editor-stages/${initial.stage.id}/commit`, initial.intent)).status).toBe(202);
    expect((await finish(initial.stage.id)).status).toBe("committed");
    ref = (await data.currentRef(floorId))!;
    const deletion = await upload(operations.map(op => ({ kind: "delete", id: op.element.id })));
    expect((await http("POST", `editor-stages/${deletion.stage.id}/commit`, deletion.intent)).status).toBe(202);
    const receipt = await finish(deletion.stage.id); expect(receipt.status).toBe("committed");
    expect(Buffer.byteLength(JSON.stringify(receipt))).toBeLessThan(64 * 1024);
    expect(receipt.result.history.undo.revision).toBe(ref.revision);
    await prisma.floorMapStage.updateMany({ where: { floorId }, data: { expiresAt: new Date(Date.now() - 7200000) } });
    await staging.reapExpired();
    ref = (await data.currentRef(floorId))!; expect(ref.elementCount).toBe(0);
    const creation = await http("POST", "editor-stages", { ...input(), historySource: receipt.result.history.undo });
    const draft = await creation.json() as { id: string };
    expect(creation.status).toBe(201);
    expect((await http("POST", `editor-stages/${draft.id}/prepare`, lease)).status).toBe(202);
    const ready = await finish(draft.id); expect(ready.status).toBe("ready");
    expect(ready.preview.elementCount).toBe(3500); expect(await data.currentRef(floorId)).toEqual(ref);
    const prefix = `editor-stages/${draft.id}/map-document`;
    const query = `generationId=${ready.preview.generationId}&revision=${ready.preview.revision}`;
    expect((await http("GET", prefix, undefined, "")).status).toBe(401);
    const manifest = await http("GET", `${prefix}/manifest?${query}`); expect(manifest.status).toBe(200);
    expect(Buffer.byteLength(await manifest.text())).toBeLessThan(1024 * 1024);
    const selected = await http("POST", `${prefix}/elements?${query}`, { ids: ["0"] }); expect(selected.status).toBe(200);
    expect(Buffer.byteLength(await selected.text())).toBeLessThan(64 * 1024);
    expect((await http("POST", `editor-stages/${draft.id}/commit`, lease)).status).toBe(202);
    expect((await finish(draft.id)).status).toBe("committed");
    expect((await data.currentRef(floorId))!.elementCount).toBe(3500);
  });

  it("restores v3 history through the existing route, replays the result and permits subsequent edits", async () => {
    const old = ref.revision;
    expect((await http("PUT", "editor-state", { ...input(), documentChanges: { ...input().documentChanges,
      operations: [{ kind: "add", element: element("one") }] } })).status).toBe(200);
    ref = (await data.currentRef(floorId))!;
    const request = { ...lease, expectedRevision: ref.revision };
    const restored = await http("POST", `editor-revisions/${old}/restore`, request); expect(restored.status).toBe(201);
    const result = await restored.json();
    expect((await data.currentRef(floorId))!.elementCount).toBe(0);
    expect(await (await http("POST", `editor-revisions/${old}/restore`, request)).json()).toEqual(result);
    const revision = await prisma.floorMapRevision.findFirstOrThrow({ where: { floorId }, orderBy: { revision: "desc" } });
    expect(revision.restoredFromRevision).toBe(old);
    ref = (await data.currentRef(floorId))!;
    expect((await http("PUT", "editor-state", { ...input(), documentChanges: { ...input().documentChanges,
      operations: [{ kind: "add", element: element("after-restore") }] } })).status).toBe(200);
  });

  it.each(["direct", "stage"])("fixround1: %s restore unplaces only new out-of-bounds fixtures atomically without clamping", async mode => {
    const old = ref.revision;
    expect((await http("PUT", "editor-state", { ...input(), floorPlan: { sourceType: "none", imageUrl: "",
      originalFileUrl: null, renderedImageUrl: null, width: 2400, height: 1600, gridSize: 10 } })).status).toBe(200);
    ref = (await data.currentRef(floorId))!;
    const verified = new Date("2026-09-19T00:00:00.000Z");
    const fixtures = [];
    for (const [name, x, y, placementStatus] of [
      ["outside-x", 1300, 30, "placed"], ["outside-y", 30, 900, "placed"],
      ["inside-edge", 1200, 800, "placed"], ["already-unplaced", 1400, 40, "unplaced"]
    ] as const) fixtures.push(await prisma.fixture.create({ data: { floorId, name, x, y, placementStatus,
      ratedWatt: 40, brightness: 73, positionVerifiedAt: placementStatus === "placed" ? verified : null } }));
    expect((await http("PUT", "editor-state", input())).status).toBe(200);
    ref = (await data.currentRef(floorId))!;
    const beforeCount = await prisma.floorMapRevision.count({ where: { floorId } });
    let stageId: string | undefined;
    if (mode === "stage") {
      const created = await http("POST", "editor-stages", { ...input(), historySource: { revision: old } });
      expect(created.status).toBe(201); stageId = (await created.json() as { id: string }).id;
      expect((await http("POST", `editor-stages/${stageId}/prepare`, lease)).status).toBe(202);
      expect((await finish(stageId)).status).toBe("ready");
    }
    const restore = async () => {
      if (!stageId) return (await http("POST", `editor-revisions/${old}/restore`, { ...lease, expectedRevision: ref.revision })).status;
      expect((await http("POST", `editor-stages/${stageId}/commit`, lease)).status).toBe(202);
      return (await finish(stageId)).status;
    };
    const failure = jest.spyOn(audit, "record").mockRejectedValueOnce(new Error("injected restore audit failure"));
    try { expect(await restore()).toBe(mode === "direct" ? 500 : "failed"); }
    finally { failure.mockRestore(); }
    expect(await data.currentRef(floorId)).toEqual(ref);
    expect(await prisma.floorMapRevision.count({ where: { floorId } })).toBe(beforeCount);
    for (const fixture of fixtures) expect(await prisma.fixture.findUniqueOrThrow({ where: { id: fixture.id } })).toEqual(fixture);
    expect(await restore()).toBe(mode === "direct" ? 201 : "committed");
    expect(await data.currentRef(floorId)).toMatchObject({ width: 1200, height: 800, revision: ref.revision + 1 });
    const row = await prisma.floorMapRevision.findFirstOrThrow({ where: { floorId }, orderBy: { revision: "desc" } });
    const snapshot = row.snapshot as unknown as { fixtures: Array<{ id: string }> };
    for (let i = 0; i < fixtures.length; i++) {
      const original = fixtures[i], outside = i < 2;
      const current = await prisma.fixture.findUniqueOrThrow({ where: { id: original.id } });
      expect(current).toMatchObject({ id: original.id, name: original.name, floorId, x: original.x, y: original.y, brightness: 73,
        placementStatus: outside ? "unplaced" : original.placementStatus,
        positionVerifiedAt: outside ? null : original.positionVerifiedAt });
      expect(snapshot.fixtures.find(f => f.id === original.id)).toMatchObject({ id: original.id, name: original.name,
        x: original.x, y: original.y, placementStatus: current.placementStatus,
        positionVerifiedAt: current.positionVerifiedAt?.toISOString() ?? null });
    }
    expect(await prisma.fixture.count({ where: { floorId } })).toBe(5);
    expect(await prisma.floorMapRevision.count({ where: { floorId } })).toBe(beforeCount + 1);
    ref = (await data.currentRef(floorId))!;
    expect((await http("PUT", "editor-state", input())).status).toBe(200);
  });

  it("fixround1: checkpoint allocation failure releases capacity for a successful retry", async () => {
    const filesystem: typeof import("node:fs/promises") = require("node:fs/promises");
    const allocate = filesystem.mkdtemp;
    let failed = false;
    const allocation = jest.spyOn(filesystem, "mkdtemp").mockImplementation((prefix, options) => {
      // Revision reads allocate other directories before checkpoint admission.
      // Fault only the owned checkpoint directory, once, then use the real FS.
      if (!failed && String(prefix).includes("led-map-checkpoint-")) {
        failed = true;
        return Promise.reject(Object.assign(new Error("injected ENOSPC"), { code: "ENOSPC" }));
      }
      return allocate(prefix, options);
    });
    const request = { ...input(), floorPlan: { sourceType: "none", imageUrl: "", originalFileUrl: null,
      renderedImageUrl: null, width: 2400, height: 800, gridSize: 10 } };
    try {
      expect((await http("PUT", "editor-state", request)).status).toBe(500);
      expect(await data.currentRef(floorId)).toEqual(ref);
      expect((await http("PUT", "editor-state", request)).status).toBe(200);
      expect(await data.currentRef(floorId)).toMatchObject({ width: 2400, revision: ref.revision + 1 });
      expect(await prisma.floorMapRevision.count({ where: { floorId } })).toBe(2);
    } finally { allocation.mockRestore(); }
  });

  it("resets ready history previews and pins before generations, fencing a late prepared stage worker", async () => {
    const historicalRevision = ref.revision;
    expect((await http("PUT", "editor-state", { ...input(), documentChanges: { ...input().documentChanges,
      operations: [{ kind: "add", element: element("before-reset") }] } })).status).toBe(200);
    ref = (await data.currentRef(floorId))!;
    const response = await http("POST", "editor-stages", { ...input(), historySource: { revision: historicalRevision } });
    const history = await response.json() as { id: string };
    expect((await http("POST", `editor-stages/${history.id}/prepare`, lease)).status).toBe(202);
    const ready = await finish(history.id); expect(ready.status).toBe("ready");
    expect(await prisma.floorMapRevisionAsset.count({ where: { floorId } })).toBeGreaterThan(0);
    const pending = await upload([{ kind: "add", element: element("late-worker") }]);
    let resume!: () => void, reached!: () => void;
    const paused = new Promise<void>(resolve => { reached = resolve; });
    const gate = new Promise<void>(resolve => { resume = resolve; });
    const prepare = checkpoints.prepare.bind(checkpoints);
    const spy = jest.spyOn(checkpoints, "prepare").mockImplementationOnce(async (...args) => {
      const prepared = await prepare(...args); reached(); await gate; return prepared;
    });
    let worker: Promise<void> | undefined;
    try {
      expect((await http("POST", `editor-stages/${pending.stage.id}/commit`, pending.intent)).status).toBe(202);
      worker = staging.processPending(); await paused;
      const resetRef = await reset.reset(floorId, user, { ...lease, requestId: randomUUID(), baseRevision: ref.revision });
      resume(); await worker;
      expect(await data.currentRef(floorId)).toEqual(resetRef);
      expect(resetRef.elementCount).toBe(0);
      expect(await prisma.floorMapStage.count({ where: { floorId } })).toBe(0);
      expect(await prisma.floorMapStagePart.count({ where: { floorId } })).toBe(0);
      expect(await prisma.floorMapGeneration.findMany({ where: { floorId }, select: { id: true } })).toEqual([{ id: resetRef.generationId }]);
      expect(await prisma.floorMapRevision.count({ where: { floorId } })).toBe(1);
      expect(await prisma.floorMapRevisionAsset.count({ where: { floorId, generationId: { not: resetRef.generationId } } })).toBe(0);
      await expect(staging.resolvePreview(floorId, history.id, user)).rejects.toThrow();
      expect((await http("POST", `editor-stages/${pending.stage.id}/commit`, pending.intent)).status).toBe(404);
    } finally { resume(); await worker; spy.mockRestore(); }
  });

  it("compacts at cumulative persisted overlay and change-count thresholds, not on every edit", async () => {
    const initialGeneration = ref.generationId;
    const first = { ...input(), documentChanges: { ...input().documentChanges,
      operations: Array.from({ length: 2000 }, (_, i) => ({ kind: "add", element: element(String(i)) })) } };
    expect((await http("PUT", "editor-state", first)).status).toBe(200);
    ref = (await data.currentRef(floorId))!; expect(ref.generationId).toBe(initialGeneration);
    expect((await http("PUT", "editor-state", { ...input(), documentChanges: { ...input().documentChanges,
      operations: [{ kind: "add", element: element("threshold") }] } })).status).toBe(200);
    ref = (await data.currentRef(floorId))!; expect(ref.generationId).not.toBe(initialGeneration);
    expect((await data.readRevision(floorId, ref)).overlay).toEqual([]);
    await prisma.floorMapDocument.update({ where: { floorId }, data: { changesSinceCheckpoint: 99 } });
    expect((await http("PUT", "editor-state", input())).status).toBe(200);
    expect((await data.currentRef(floorId))!.generationId).not.toBe(ref.generationId);
  });
});
