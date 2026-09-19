import { Test } from "@nestjs/testing";
import { AuthService } from "../auth/auth.service";
import { MapDocumentReader } from "./map-document-reader";
import { MapDocumentQueryController } from "./map-document-query.controller";
import { AppModule } from "../app.module";
import { MODULE_METADATA } from "@nestjs/common/constants";
import { PrismaService } from "../prisma/prisma.service";
import { RedisProvider } from "../redis/redis.provider";
import { MapDocumentQueryModule } from "./map-document-query.module";
import { MAP_QUERY_REVISION_READER } from "./map-document-reader";
import { CreateBucketCommand, S3Client } from "@aws-sdk/client-s3";
import { PrismaClient } from "@prisma/client";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cadSceneManifestSchema, mapDisplayManifestSchema, MapDocumentRef, MapElement } from "@led-control/shared";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import { PasswordService } from "../auth/password.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { ObjectStorageService } from "../storage/object-storage.service";
import { MapDocumentResetService } from "./map-document-reset.service";
import { MapDocumentStore } from "./map-document-store";
import { MapDocumentRevisionData } from "./map-document-revision-data";
import { MapDocumentMutationService } from "./map-document-mutation.service";
import { FloorEditorService } from "./floor-editor.service";
import { hashEditorLeaseToken } from "./editor-lease-token";
import { buildCanonicalCadScene } from "../floor-import/cad-canonical-spool";
import { CadMapPreparationService } from "../floor-import/cad-map-preparation.service";

describe("Map document query HTTP contract", () => {
  let app: any, base: string;
  const user = { id: "viewer", role: "viewer", status: "active", mustChangePassword: false };
  const reader = {
    getDocument: jest.fn(async () => null),
    getManifest: jest.fn(async () => ({ generationId: "generation", revision: 2, canonical: {}, display: { tiles: [] }, displayLayerBindings: [], groups: [], layers: [] })),
    getElements: jest.fn(async () => []),
    getTile: jest.fn(async () => Buffer.from([1, 2, 3])),
    getChanges: jest.fn(async () => ({ generationId: "generation", revision: 2, operations: [], nextCursor: null })),
    select: jest.fn(async () => ({ generationId: "generation", revision: 2, ids: [], nextCursor: null }))
  };
  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [MapDocumentQueryController], providers: [
      { provide: MapDocumentReader, useValue: reader },
      { provide: AuthService, useValue: { getUserBySessionToken: jest.fn(async () => user) } }
    ] }).compile();
    app = module.createNestApplication(); await app.listen(0, "127.0.0.1"); base = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); });
  beforeEach(() => jest.clearAllMocks());
  const url = (suffix: string) => `${base}/floors/floor/map-document${suffix}`;
  const auth = { cookie: "led_session=test" };

  it("rejects unauthenticated current refs before reader access", async () => {
    expect((await fetch(url(""))).status).toBe(401);
    expect(reader.getDocument).not.toHaveBeenCalled();
  });
  it("serializes an absent current document as JSON null", async () => {
    const response = await fetch(url(""), { headers: auth });
    expect(response.status).toBe(200); expect(await response.text()).toBe("null");
  });
  it("returns JSON 200, never a raw manifest redirect, and marks it private", async () => {
    const response = await fetch(url("/manifest?generationId=generation&revision=2"), { headers: auth, redirect: "manual" });
    expect(response.status).toBe(200); expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({ generationId: "generation", revision: 2, displayLayerBindings: [] });
    expect(reader.getManifest).toHaveBeenCalledWith(user, "floor", { generationId: "generation", revision: 2 }, undefined);
  });
  it.each(["", "?generationId=g&revision=-1", "?generationId=g&revision=1.2", "?generationId=g&revision=1&assetId=arbitrary"])("rejects invalid ref query %s", async query => {
    expect((await fetch(url(`/manifest${query}`), { headers: auth })).status).toBe(400);
    expect(reader.getManifest).not.toHaveBeenCalled();
  });
  it("binds prepared reads to the path job, not a client generation lookup", async () => {
    const response = await fetch(`${base}/floors/floor/import-jobs/job/map-document/manifest?generationId=generation&revision=2`, { headers: auth });
    expect(response.status).toBe(200);
    expect(reader.getManifest).toHaveBeenCalledWith(user, "floor", { generationId: "generation", revision: 2 }, "job");
  });
  it("uses 200 JSON for POST element and selection queries", async () => {
    for (const [path, body] of [["elements", { ids: ["a"] }], ["selection", { groupId: "group" }]] as const) {
      expect((await fetch(url(`/${path}?generationId=generation&revision=2`), { method: "POST",
        headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(body) })).status).toBe(200);
    }
  });
  it("returns tile binary directly and carries the revision-bound overlay cursor", async () => {
    const tile = await fetch(url("/tiles/tile?generationId=generation&revision=2"), { headers: auth });
    expect(tile.status).toBe(200); expect(Buffer.from(await tile.arrayBuffer())).toEqual(Buffer.from([1, 2, 3]));
    expect(tile.headers.get("content-type")).toContain("application/octet-stream");
    const changes = await fetch(url("/changes?generationId=generation&revision=2&cursor=cursor"), { headers: auth });
    expect(changes.status).toBe(200);
    expect(reader.getChanges).toHaveBeenCalledWith(user, "floor", { generationId: "generation", revision: 2 }, "cursor", undefined);
  });
});

it("registers map queries in the application and resolves the committed revision reader singleton", async () => {
  expect(Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule)).toContain(MapDocumentQueryModule);
  const module = await Test.createTestingModule({ imports: [MapDocumentQueryModule] })
    .overrideProvider(PrismaService).useValue({})
    .overrideProvider(RedisProvider).useValue({})
    .compile();
  try {
    expect(module.get(MapDocumentQueryController)).toBeDefined();
    expect(module.get(MAP_QUERY_REVISION_READER)).toBe(module.get(MapDocumentRevisionData));
  } finally { await module.close(); }
});

const databaseUrl = process.env.U7_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("U7 isolated PostgreSQL/MinIO/session HTTP", () => {
  jest.setTimeout(120_000);
  const prisma = new PrismaClient(databaseUrl ? { datasourceUrl: databaseUrl } : undefined);
  const bucket = `u7-${randomUUID()}`;
  const s3 = new S3Client({ endpoint: process.env.U7_MINIO_ENDPOINT, region: "us-east-1", forcePathStyle: true,
    credentials: { accessKeyId: process.env.U7_MINIO_USER ?? "unused", secretAccessKey: process.env.U7_MINIO_PASSWORD ?? "unused" } });
  const storage = new ObjectStorageService(s3, { bucket, publicBaseUrl: "" });
  const store = new MapDocumentStore(prisma as never, storage), access = new SiteAccessService(prisma as never);
  const audit = new AuditService(prisma as never), data = new MapDocumentRevisionData(prisma as never, storage, store);
  const reset = new MapDocumentResetService(prisma as never, access, audit, store);
  const mutations = new MapDocumentMutationService(prisma as never, access, audit, storage, store, data);
  const editor = new FloorEditorService(prisma as never, access, audit, undefined, undefined, mutations, data);
  const preparation = new CadMapPreparationService(prisma as never, storage, store);
  const reader = new MapDocumentReader(prisma as never, access, storage, store, data);
  let app: any, base: string, floorId: string, ref: MapDocumentRef, admin: AuthenticatedUser, adminToken: string, viewerToken: string;
  beforeAll(async () => {
    const target = new URL(databaseUrl!);
    if (!/^\/led_u7_test_/.test(target.pathname) || target.hostname !== "127.0.0.1" || target.port === "5432") throw Error("isolated U7 DB required");
    const [identity] = await prisma.$queryRaw<Array<{ name: string }>>`SELECT current_database() AS name`;
    expect(`/${identity.name}`).toBe(target.pathname);
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    const module = await Test.createTestingModule({ controllers: [MapDocumentQueryController], providers: [
      { provide: MapDocumentReader, useValue: reader },
      { provide: AuthService, useValue: new AuthService(prisma as never, new PasswordService(), audit) }
    ] }).compile();
    app = module.createNestApplication(); await app.listen(0, "127.0.0.1"); base = await app.getUrl();
  });
  beforeEach(async () => {
    const org = await prisma.organization.create({ data: { name: "U7", type: "customer" } });
    const row = await prisma.user.create({ data: { organizationId: org.id, loginId: randomUUID(), name: "admin", passwordHash: "unused", role: "admin" } });
    admin = { ...row, role: "admin", status: "active", organizationType: "customer" };
    const viewer = await prisma.user.create({ data: { organizationId: org.id, loginId: randomUUID(), name: "viewer", passwordHash: "unused", role: "viewer" } });
    const site = await prisma.site.create({ data: { organizationId: org.id, adminUserId: row.id, name: "U7" } });
    await prisma.siteMembership.create({ data: { siteId: site.id, userId: viewer.id, accessLevel: "read" } });
    floorId = (await prisma.floor.create({ data: { siteId: site.id, name: "floor", level: 1, editorLeaseFence: 1,
      editorLeaseHolderId: row.id, editorLeaseTokenHash: hashEditorLeaseToken("lease"), editorLeaseExpiresAt: new Date(Date.now() + 600_000) } })).id;
    adminToken = randomUUID(); viewerToken = randomUUID();
    for (const [userId, token] of [[row.id, adminToken], [viewer.id, viewerToken]]) {
      await prisma.session.create({ data: { userId, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 600_000) } });
    }
    ref = await reset.reset(floorId, admin, { requestId: randomUUID(), baseRevision: 0, leaseToken: "lease", leaseFence: 1 });
  });
  afterAll(async () => { await app?.close(); await prisma.$disconnect(); s3.destroy(); });
  const request = (path: string, token = viewerToken, body?: unknown, reference = ref, jobId?: string) => {
    const prefix = `/floors/${floorId}${jobId ? `/import-jobs/${jobId}` : ""}/map-document`;
    return fetch(`${base}${prefix}${path}?generationId=${reference.generationId}&revision=${reference.revision}`, {
      method: body ? "POST" : "GET", headers: { cookie: `led_session=${token}`, "content-type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}) });
  };
  const item = (id: string): MapElement => ({ id, type: "rectangle", geometry: { origin: { x: 20, y: 20 }, width: 20, height: 20 },
    groupId: null, layerId: "map", zIndex: 0, visible: true, locked: false, provenance: null,
    transform: { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0 }, style: { strokeColor: "#000000", fillColor: null, strokeWidth: 1, opacity: 1 } });
  async function save(operations: unknown[]) {
    await editor.saveEditorState(admin, floorId, { expectedRevision: ref.revision, leaseToken: "lease", leaseFence: 1,
      fixtureUpdates: [], slotAssignments: [], objectCreates: [], objectUpdates: [], objectDeletes: [],
      documentChanges: { requestId: randomUUID(), generationId: ref.generationId, operations } });
    ref = (await data.currentRef(floorId))!;
  }

  it("reads manual empty metadata, then fresh persisted additions/deletions without ghosts", async () => {
    const empty = await request("/manifest"); expect(empty.status).toBe(200);
    const initial = await empty.json();
    expect(initial).toMatchObject({ display: { width: 1200, height: 800, tileCount: 0, tiles: [] } });
    expect(mapDisplayManifestSchema.safeParse(initial.display).success).toBe(true);
    const before = ref;
    await save([{ kind: "add", element: item("one") }, { kind: "add", element: item("two") }]);
    expect((await request("/manifest", viewerToken, undefined, before)).status).toBe(409);
    expect(await (await request("/elements", viewerToken, { ids: ["one", "two"] })).json()).toEqual([item("one"), item("two")]);
    await save([{ kind: "delete", id: "one" }]);
    const changes = await request("/changes"); expect(changes.status).toBe(200);
    expect(await changes.json()).toMatchObject({ operations: [{ kind: "delete", id: "one" }, { kind: "add", element: item("two") }], nextCursor: null });
    expect(await (await request("/elements", viewerToken, { ids: ["one", "two"] })).json()).toEqual([item("two")]);
    const current = await fetch(`${base}/floors/${floorId}/map-document`, { headers: { cookie: `led_session=${viewerToken}` } });
    expect(await current.json()).toEqual(ref);
  });

  it("serves prepared builder output only to its authorized review job and merges concurrent ledger loads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "u7-cad-"));
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
      await prisma.floorImportJob.create({ data: { id: jobId, floorId, sourceAssetId: original.id, renderedAssetId: rendered.id, sourceFormat: "dxf",
        status: "review_required", stage: "review_required", preparedMapGenerationId: prepared.generationId,
        progressPercent: 100, startedAt: new Date(), reviewRequiredAt: new Date(),
        detectorProfileId: "generic-lighting-v1", detectorProfileVersion: "legacy-unknown", detectorProfileDigest: "0".repeat(64) } });
      const manifestReads = jest.spyOn(store, "readManifest"), authorizations = jest.spyOn(access, "assert");
      try {
        const ledger = await store.readDisplayAssets(floorId, prepared), tile = ledger!.tiles[0];
        const responses = await Promise.all(Array.from({ length: 20 }, () => request(`/tiles/${tile.asset.assetId}`, adminToken, undefined, prepared, jobId)));
        expect(responses.every(response => response.status === 200)).toBe(true);
        for (const response of responses) expect((await response.arrayBuffer()).byteLength).toBe(tile.asset.byteSize);
        expect(manifestReads).toHaveBeenCalledTimes(1); expect(authorizations).toHaveBeenCalledTimes(20);
        const response = await request("/manifest", adminToken, undefined, prepared, jobId); expect(response.status).toBe(200);
        const manifest = await response.json(); expect(cadSceneManifestSchema.safeParse(manifest.display).success).toBe(true);
        expect(manifest.displayLayerBindings).toHaveLength(1);
        expect((await request("/manifest", viewerToken, undefined, prepared, jobId)).status).toBe(403);
        expect((await request("/manifest", adminToken, undefined, prepared)).status).toBe(409);
        expect((await request("/manifest", adminToken, undefined, prepared, randomUUID())).status).toBe(404);
        await prisma.floorImportJob.update({ where: { id: jobId }, data: { status: "cancelled", cancelledAt: new Date() } });
        expect((await request("/manifest", adminToken, undefined, prepared, jobId)).status).toBe(404);
      } finally { manifestReads.mockRestore(); authorizations.mockRestore(); }
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
