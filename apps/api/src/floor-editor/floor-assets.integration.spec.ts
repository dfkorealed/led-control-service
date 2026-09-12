import { NotFoundException } from "@nestjs/common";
import { Prisma, PrismaClient } from "@prisma/client";
import { spawnSync } from "node:child_process";
import { AuthenticatedUser } from "../auth/auth.types";
import { FloorAssetCleanupService } from "./floor-asset-cleanup.service";
import { FloorAssetsService } from "./floor-assets.service";

const databaseUrl = process.env.FLOOR_ASSET_TEST_DATABASE_URL ?? process.env.FLOOR_EDITOR_TEST_DATABASE_URL;
const psqlDatabaseUrl = databaseUrl ? (() => {
  const url = new URL(databaseUrl);
  url.searchParams.delete("schema");
  return url.toString();
})() : undefined;
const describeWithPostgres = databaseUrl ? describe : describe.skip;

describeWithPostgres("FloorAssetsService PostgreSQL concurrency", () => {
  const schemaName = `floor_asset_complete_${process.pid}_${Date.now()}`.toLowerCase();
  const schemaUrl = databaseUrl ? (() => {
    const url = new URL(databaseUrl);
    url.searchParams.set("schema", schemaName);
    return url.toString();
  })() : "";
  let serviceClient: PrismaClient;
  let revocationClient: PrismaClient;

  const admin: AuthenticatedUser = {
    id: "admin-1", organizationId: "customer-org", organizationType: "customer", loginId: "fixture_user",
    name: "Admin", role: "admin", mustChangePassword: false, status: "active"
  };

  beforeAll(async () => {
    const setup = runSql(`
      CREATE SCHEMA "${schemaName}";
      SET search_path TO "${schemaName}";
      CREATE TYPE "FloorAssetKind" AS ENUM ('original', 'rendered');
      CREATE TYPE "FloorAssetStatus" AS ENUM ('pending', 'ready');
      CREATE TYPE "FloorStatus" AS ENUM ('active', 'archived');
      CREATE TABLE "Site" ("id" TEXT PRIMARY KEY, "adminUserId" TEXT);
      CREATE TABLE "Floor" (
        "id" TEXT PRIMARY KEY,
        "siteId" TEXT NOT NULL,
        "status" "FloorStatus" NOT NULL DEFAULT 'active'
      );
      CREATE TABLE "FloorAsset" (
        "id" TEXT PRIMARY KEY,
        "floorId" TEXT NOT NULL,
        "kind" "FloorAssetKind" NOT NULL,
        "status" "FloorAssetStatus" NOT NULL DEFAULT 'pending',
        "objectKey" TEXT NOT NULL UNIQUE,
        "mimeType" TEXT NOT NULL,
        "sizeBytes" BIGINT NOT NULL,
        "sha256" TEXT NOT NULL,
        "uploadExpiresAt" TIMESTAMP(3),
        "cleanupStartedAt" TIMESTAMP(3),
        "readyAt" TIMESTAMP(3),
        "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
        "updatedAt" TIMESTAMP(3) NOT NULL
      );
      CREATE TABLE "FloorPlan" (
        "floorId" TEXT PRIMARY KEY,
        "imageUrl" TEXT NOT NULL,
        "originalFileUrl" TEXT,
        "renderedImageUrl" TEXT
      );
      CREATE TABLE "FloorMapRevision" (
        "id" TEXT PRIMARY KEY,
        "floorId" TEXT NOT NULL,
        "snapshot" JSONB NOT NULL
      );
      INSERT INTO "Site" VALUES ('site-1', 'admin-1');
      INSERT INTO "Floor" VALUES ('floor-1', 'site-1');
      INSERT INTO "FloorAsset" (
        "id", "floorId", "kind", "status", "objectKey", "mimeType", "sizeBytes", "sha256",
        "uploadExpiresAt", "updatedAt"
      ) VALUES (
        'asset-1', 'floor-1', 'original', 'pending', 'floors/floor-1/file.png', 'image/png', 1024,
        '${"a".repeat(64)}', now() + interval '5 minutes', now()
      );
    `);
    if (setup.status !== 0) throw new Error(setup.stderr);
    serviceClient = new PrismaClient({ datasources: { db: { url: schemaUrl } } });
    revocationClient = new PrismaClient({ datasources: { db: { url: schemaUrl } } });
    await Promise.all([serviceClient.$connect(), revocationClient.$connect()]);
  });

  afterAll(async () => {
    await Promise.all([serviceClient?.$disconnect(), revocationClient?.$disconnect()]);
    runSql(`DROP SCHEMA IF EXISTS "${schemaName}" CASCADE;`);
  });

  it("serializes final promotion behind Site revocation and leaves the asset pending", async () => {
    const headStarted = deferred<void>();
    const finishHead = deferred<void>();
    const revocationLocked = deferred<void>();
    const releaseRevocation = deferred<void>();
    const siteAccess = {
      assert: jest.fn().mockResolvedValue({ id: "site-1" }),
      assertManageInTransaction: async (tx: Prisma.TransactionClient, user: AuthenticatedUser, siteId: string) => {
        await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Site" WHERE "id" = ${siteId} FOR UPDATE`);
        const rows = await tx.$queryRaw<Array<{ adminUserId: string | null }>>(
          Prisma.sql`SELECT "adminUserId" FROM "Site" WHERE "id" = ${siteId}`
        );
        if (rows[0]?.adminUserId !== user.id) throw new NotFoundException("site not found");
        return { id: siteId };
      }
    };
    const storage = {
      headObject: jest.fn().mockImplementation(async () => {
        headStarted.resolve();
        await finishHead.promise;
        return {
          ContentType: "image/png", ContentLength: 1024,
          ChecksumSHA256: Buffer.from("a".repeat(64), "hex").toString("base64")
        };
      })
    };
    const service = new FloorAssetsService(serviceClient as never, storage as never, siteAccess as never);

    const completing = service.completeUpload(admin, "floor-1", "asset-1");
    await headStarted.promise;
    const revoking = revocationClient.$transaction(async (tx) => {
      await tx.$queryRaw(Prisma.sql`SELECT "id" FROM "Site" WHERE "id" = 'site-1' FOR UPDATE`);
      await tx.$executeRaw(Prisma.sql`UPDATE "Site" SET "adminUserId" = NULL WHERE "id" = 'site-1'`);
      revocationLocked.resolve();
      await releaseRevocation.promise;
    });
    await revocationLocked.promise;
    finishHead.resolve();
    await new Promise((resolve) => setTimeout(resolve, 50));

    releaseRevocation.resolve();
    await revoking;
    await expect(completing).rejects.toBeInstanceOf(NotFoundException);
    const rows = await serviceClient.$queryRaw<Array<{ status: string }>>(
      Prisma.sql`SELECT "status"::text AS status FROM "FloorAsset" WHERE "id" = 'asset-1'`
    );
    expect(rows).toEqual([{ status: "pending" }]);
  });

  it("deletes only old ready orphans while preserving current and historical references", async () => {
    const now = new Date();
    const oldReadyAt = new Date(now.getTime() - 24 * 60 * 60_000 - 1_000);
    const paths = {
      orphan: "/api/floors/floor-1/assets/asset-orphan/content",
      current: "/api/floors/floor-1/assets/asset-current/content"
    };
    const historicalAssets = Array.from({ length: 25 }, (_, index) => ({
      id: `asset-historical-${index.toString().padStart(2, "0")}`,
      objectKey: `floors/floor-1/historical-${index.toString().padStart(2, "0")}.png`
    }));
    for (const { id, objectKey } of [
      { id: "asset-current", objectKey: "floors/floor-1/current.png" },
      ...historicalAssets,
      { id: "asset-orphan", objectKey: "floors/floor-1/orphan.png" }
    ]) {
      await serviceClient.floorAsset.create({
        data: {
          id,
          floorId: "floor-1",
          kind: "original",
          status: "ready",
          objectKey,
          mimeType: "image/png",
          sizeBytes: 1024n,
          sha256: "b".repeat(64),
          readyAt: oldReadyAt
        }
      });
    }
    await serviceClient.floorAsset.create({
      data: {
        id: "asset-recent",
        floorId: "floor-1",
        kind: "original",
        status: "ready",
        objectKey: "floors/floor-1/recent.png",
        mimeType: "image/png",
        sizeBytes: 1024n,
        sha256: "c".repeat(64),
        readyAt: new Date(now.getTime() - 23 * 60 * 60_000)
      }
    });
    await serviceClient.$executeRaw(Prisma.sql`
      INSERT INTO "FloorPlan" ("floorId", "imageUrl", "originalFileUrl", "renderedImageUrl")
      VALUES ('floor-1', ${paths.current}, NULL, NULL)
    `);
    for (const [index, asset] of historicalAssets.entries()) {
      const historicalPath = `/api/floors/floor-1/assets/${asset.id}/content`;
      await serviceClient.$executeRaw(Prisma.sql`
        INSERT INTO "FloorMapRevision" ("id", "floorId", "snapshot")
        VALUES (
          ${`revision-${index}`},
          'floor-1',
          ${JSON.stringify({
            floorPlan: {
              imageUrl: historicalPath,
              originalFileUrl: null,
              renderedImageUrl: null
            }
          })}::jsonb
        )
      `);
    }
    const storage = { deleteObject: jest.fn().mockResolvedValue(undefined) };
    const cleanup = new FloorAssetCleanupService(serviceClient as never, storage as never);

    await expect(cleanup.processPending(now)).resolves.toEqual({ processed: 1, deleted: 1 });

    expect(storage.deleteObject).toHaveBeenCalledTimes(1);
    expect(storage.deleteObject).toHaveBeenCalledWith("floors/floor-1/orphan.png");
    await expect(serviceClient.floorAsset.count({
      where: {
        id: { in: ["asset-current", "asset-recent", ...historicalAssets.map(({ id }) => id)] },
        cleanupStartedAt: null
      }
    })).resolves.toBe(27);
    await expect(serviceClient.floorAsset.findUnique({ where: { id: "asset-orphan" } })).resolves.toBeNull();
  });

  function runSql(sql: string) {
    return spawnSync("psql", ["-q", "-v", "ON_ERROR_STOP=1", psqlDatabaseUrl!], { encoding: "utf8", input: sql });
  }
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
