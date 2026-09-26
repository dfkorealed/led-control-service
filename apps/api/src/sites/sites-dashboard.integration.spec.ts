import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { buildMapDocumentSnapshot, hashFloorEditorSnapshot } from "../floor-editor/floor-editor-snapshot";
import { SitesService } from "./sites.service";

const enabled = process.env.DASHBOARD_INTEGRATION_TEST === "1";

(enabled ? describe : describe.skip)("dashboard summaries on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;

  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    const migrated = cluster.deploy(url);
    expect(migrated.stderr + migrated.stdout).not.toMatch(/Error:|P30\d\d/);
    expect(migrated.status).toBe(0);
    db = new PrismaClient({ datasourceUrl: url });
  }, 60_000);

  afterAll(async () => { await db?.$disconnect(); cluster?.stop(); });

  it("returns 1,000 registered fixture counts without serializing any fixture detail", async () => {
    const organizationId = randomUUID(), siteId = randomUUID(), first = randomUUID(), second = randomUUID();
    await db.organization.create({ data: { id: organizationId, name: "Dashboard fixture" } });
    await db.site.create({ data: { id: siteId, organizationId, name: "Factory" } });
    await db.floor.createMany({ data: [
      { id: first, siteId, name: "B1", level: -1, mapRevision: 5 },
      { id: second, siteId, name: "1F", level: 1, mapRevision: 6 }
    ] });
    await db.fixture.createMany({ data: Array.from({ length: 1000 }, (_, index) => ({
      siteId, floorId: index < 600 ? first : second, name: `Fixture ${index}`,
      ratedWatt: "40", x: 0, y: 0, brightness: 20,
      reportedStatus: index < 500 ? "online" as const : index < 750 ? "fault" as const : "offline" as const
    })) });
    const service = new SitesService(db as never, {} as never);

    const dashboard = await service.getDashboardById(siteId, false);
    expect(dashboard.summary).toMatchObject({ totalFixtures: 1000, onlineFixtures: 500, faultFixtures: 250, offlineFixtures: 250 });
    expect(dashboard.floors.map((floor) => floor.summary)).toEqual([
      { totalFixtures: 600, onlineFixtures: 500, faultFixtures: 100, offlineFixtures: 0 },
      { totalFixtures: 400, onlineFixtures: 0, faultFixtures: 150, offlineFixtures: 250 }
    ]);
    expect(dashboard.floors.every((floor) => floor.fixtures.length === 0 && floor.mapConfigured === false)).toBe(true);
    expect(JSON.stringify(dashboard).length).toBeLessThan(10_000);
  });

  async function createRevisionMap(baseCount: number) {
    const organizationId = randomUUID(), siteId = randomUUID(), floorId = randomUUID(), userId = randomUUID();
    await db.organization.create({ data: { id: organizationId, name: "Dashboard revisions" } });
    await db.user.create({ data: { id: userId, organizationId, loginId: `dashboard-${userId}`, name: "Admin", passwordHash: "test-only", role: "admin" } });
    await db.site.create({ data: { id: siteId, organizationId, name: "Factory" } });
    await db.floor.create({ data: { id: floorId, siteId, name: "1F", level: 1, mapRevision: 1 } });
    const generationId = randomUUID(), manifestId = randomUUID();
    await db.floorAsset.create({ data: { id: manifestId, floorId, kind: "map_manifest", status: "ready",
      objectKey: `dashboard/${manifestId}`, mimeType: "application/octet-stream", sizeBytes: 1,
      sha256: "a".repeat(64), readyAt: new Date() } });
    await db.floorMapGeneration.create({ data: { id: generationId, floorId, status: "active", baseRevision: 1,
      width: 1200, height: 800, gridSize: 10, elementCount: baseCount, manifestAssetId: manifestId,
      manifestDecodedBytes: 1, expiresAt: new Date(Date.now() + 60_000) } });
    await db.floorMapDocument.create({ data: { floorId, activeGenerationId: generationId, revision: 1 } });
    const snapshotFor = (revision: number, elementCount: number) =>
      buildMapDocumentSnapshot({ document: { formatVersion: 1, generationId, revision,
        width: 1200, height: 800, gridSize: 10, elementCount,
        manifest: { assetId: manifestId, sha256: "a".repeat(64), byteSize: 1, decodedByteSize: 1 } },
        fixtures: [], lightSlots: [] });
    const baseSnapshot = snapshotFor(1, baseCount);
    await db.floorMapRevision.create({ data: { floorId, revision: 1, snapshot: baseSnapshot,
      snapshotSha256: hashFloorEditorSnapshot(baseSnapshot), changedBy: userId, changeSummary: {} } });
    let revision = 1;
    const saveRevision = async (elementCount: number) => {
      const nextRevision = revision + 1;
      const assetIds = [randomUUID(), randomUUID()];
      await db.floorAsset.createMany({ data: assetIds.map((id) => ({ id, floorId, kind: "map_changeset" as const,
        status: "ready" as const, objectKey: `dashboard/${id}`, mimeType: "application/octet-stream",
        sizeBytes: 1, sha256: "b".repeat(64), readyAt: new Date() })) });
      const snapshot = snapshotFor(nextRevision, elementCount);
      await db.$transaction(async (tx) => {
        await tx.floorMapChangeSet.create({ data: { floorId, generationId, requestId: randomUUID(),
          baseRevision: revision, resultRevision: nextRevision, payloadHash: "c".repeat(64),
          payloadAssetId: assetIds[0], inverseAssetId: assetIds[1], decodedBytes: 1, inverseDecodedBytes: 1 } });
        await tx.floorMapDocument.update({ where: { floorId }, data: { revision: nextRevision, changesSinceCheckpoint: { increment: 1 } } });
        await tx.floor.update({ where: { id: floorId }, data: { mapRevision: nextRevision } });
        await tx.floorMapRevision.create({ data: { floorId, revision: nextRevision, snapshot,
          snapshotSha256: hashFloorEditorSnapshot(snapshot), changedBy: userId, changeSummary: {} } });
      });
      revision = nextRevision;
    };
    return { siteId, floorId, generationId, saveRevision, service: new SitesService(db as never, {} as never) };
  }

  it.each([false, true])("tracks the active revision after adding the first common-map element (includeFixtures=%s)", async (includeFixtures) => {
    const { siteId, generationId, saveRevision, service } = await createRevisionMap(0);
    expect((await service.getDashboardById(siteId, includeFixtures)).floors[0].mapConfigured).toBe(false);
    await saveRevision(1);
    expect((await service.getDashboardById(siteId, includeFixtures)).floors[0].mapConfigured).toBe(true);
    await saveRevision(0);
    const afterDelete = await service.getDashboardById(siteId, includeFixtures);
    expect(afterDelete.floors[0]).toMatchObject({ mapRevision: 3, mapConfigured: false });
    expect(afterDelete.floors[0].fixtures).toEqual([]);
    expect((await db.floorMapGeneration.findUniqueOrThrow({ where: { id: generationId } })).elementCount).toBe(0);
  });

  it.each([false, true])("clears mapConfigured after deleting the last element from a nonempty base (includeFixtures=%s)", async (includeFixtures) => {
    const { siteId, generationId, saveRevision, service } = await createRevisionMap(1);
    expect((await service.getDashboardById(siteId, includeFixtures)).floors[0].mapConfigured).toBe(true);
    await saveRevision(0);
    expect((await service.getDashboardById(siteId, includeFixtures)).floors[0]).toMatchObject({ mapRevision: 2, mapConfigured: false });
    expect((await db.floorMapGeneration.findUniqueOrThrow({ where: { id: generationId } })).elementCount).toBe(1);
  });

  it("fails closed when an active common-map revision has no matching snapshot", async () => {
    const { siteId, floorId, service } = await createRevisionMap(1);
    await db.floorMapRevision.delete({ where: { floorId_revision: { floorId, revision: 1 } } });
    await expect(service.getDashboardById(siteId, false)).rejects.toThrow("map dashboard revision metadata mismatch");
  });

  it("fails closed when the stored snapshot names a different revision", async () => {
    const { siteId, floorId, service } = await createRevisionMap(1);
    await db.$executeRaw`UPDATE "FloorMapRevision" SET "snapshot" = jsonb_set("snapshot", '{document,revision}', '0'::jsonb)
      WHERE "floorId" = ${floorId} AND "revision" = 1`;
    await expect(service.getDashboardById(siteId, false)).rejects.toThrow("map dashboard revision metadata mismatch");
  });
});
