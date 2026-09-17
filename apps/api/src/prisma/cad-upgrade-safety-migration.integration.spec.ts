import { DeleteObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { ObjectStorageService } from "../storage/object-storage.service";

const predecessorMigration = "20260917140000_floor_import_attempt_cleanup_terminal";
const profileMigration = "20260917150000_cad_profile_binding";
const safetyMigration = "20260917160000_cad_upgrade_safety";
const profileMigrationPath = join(__dirname, `../../prisma/migrations/${profileMigration}/migration.sql`);
const profileMigrationChecksum = "56b83ce4e6e2310f1d0062684187c681aed0385f1c794799e29ba6cad4cf1b4f";
const digest = "a".repeat(64);

jest.setTimeout(90_000);

describe("CAD profile/content encoding upgrade safety on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;

  beforeAll(async () => { cluster = await disposablePostgres(); });
  afterAll(() => cluster?.stop());

  it("keeps the published profile migration byte-for-byte stable", () => {
    expect(createHash("sha256").update(readFileSync(profileMigrationPath)).digest("hex"))
      .toBe(profileMigrationChecksum);
  });

  it("clean-replays through the forward safety migration", () => {
    const databaseUrl = cluster.database();
    const result = cluster.deploy(databaseUrl, safetyMigration);
    if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
    expect(cluster.sql(databaseUrl, `
      SELECT count(*) FROM "_prisma_migrations"
      WHERE migration_name = '${safetyMigration}' AND finished_at IS NOT NULL;
    `)).toBe("1");
  });

  it("preserves a legacy identity SVG and stages queued profile resolution at lease time", () => {
    const databaseUrl = cluster.database();
    expect(cluster.deploy(databaseUrl, predecessorMigration).status).toBe(0);
    seedCadJob(cluster, databaseUrl, {
      id: "legacy-review", status: "review_required", withEncodingColumn: false, missingTerminalIdentity: true
    });
    seedCadJob(cluster, databaseUrl, { id: "legacy-queued", status: "queued", withEncodingColumn: false, suffix: "q" });

    const result = cluster.deploy(databaseUrl, safetyMigration);
    if (result.status !== 0) throw new Error(`${result.stdout}\n${result.stderr}`);
    expect(cluster.sql(databaseUrl, `
      SELECT COALESCE(asset."contentEncoding", 'identity') || ':' ||
        COALESCE(job."detectorProfileId", 'null') || ':' ||
        COALESCE(job."detectorProfileVersion", 'null') || ':' ||
        COALESCE(job."detectorProfileDigest", 'null') || ':' ||
        "floor_import_job_assets_are_valid"(job."id")
      FROM "FloorImportJob" job
      JOIN "FloorAsset" asset ON asset."id" = job."renderedAssetId"
      WHERE job."id" = 'legacy-review';
    `)).toBe(`identity:generic-lighting-v1:legacy-unknown:${"0".repeat(64)}:true`);
    expect(cluster.sql(databaseUrl, `
      SELECT ("detectorProfileId" IS NULL AND "detectorProfileVersion" IS NULL AND "detectorProfileDigest" IS NULL)::text
      FROM "FloorImportJob" WHERE "id" = 'legacy-queued';
    `)).toBe("true");
  });

  it("preserves gzip only for assets created after the profile migration", () => {
    const databaseUrl = cluster.database();
    expect(cluster.deploy(databaseUrl, profileMigration).status).toBe(0);
    seedCadJob(cluster, databaseUrl, { id: "new-gzip", status: "review_required", withEncodingColumn: true });

    expect(cluster.deploy(databaseUrl, safetyMigration).status).toBe(0);
    expect(cluster.sql(databaseUrl, `
      SELECT "contentEncoding" FROM "FloorAsset" WHERE "id" = 'render-new-gzip';
    `)).toBe("gzip");
  });

  (process.env.RUN_OBJECT_STORAGE_INTEGRATION === "true" ? it : it.skip)(
    "preserves legacy identity and new gzip ledgers through staged PostgreSQL migration and MinIO signed GET",
    async () => {
      const databaseUrl = cluster.database();
      const endpoint = process.env.OBJECT_STORAGE_ENDPOINT ?? "http://localhost:9000";
      const bucket = process.env.OBJECT_STORAGE_BUCKET ?? "floor-assets";
      const client = new S3Client({
        region: process.env.OBJECT_STORAGE_REGION ?? "us-east-1", endpoint, forcePathStyle: true,
        credentials: {
          accessKeyId: process.env.OBJECT_STORAGE_ACCESS_KEY ?? "led-floor-assets",
          secretAccessKey: process.env.OBJECT_STORAGE_SECRET_KEY ?? "change-this-local-secret"
        }
      });
      const storage = new ObjectStorageService(client, { bucket, publicBaseUrl: `${endpoint}/${bucket}` });
      const legacyKey = "floors/legacy-minio/render.svg";
      const gzipKey = "floors/gzip-minio/render.svg";
      const legacyBytes = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="41" height="29"/>');
      const gzipSource = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="37" height="23"/>');
      const gzipBytes = gzipSync(gzipSource);
      const legacySha = createHash("sha256").update(legacyBytes).digest("hex");
      const gzipSha = createHash("sha256").update(gzipBytes).digest("hex");
      try {
        expect(cluster.deploy(databaseUrl, predecessorMigration).status).toBe(0);
        seedCadJob(cluster, databaseUrl, {
          id: "legacy-minio", status: "review_required", withEncodingColumn: false, missingTerminalIdentity: true
        });
        cluster.sql(databaseUrl, `UPDATE "FloorAsset" SET "objectKey"='${legacyKey}', "sizeBytes"=${legacyBytes.length},
          "sha256"='${legacySha}' WHERE "id"='render-legacy-minio';`);
        await client.send(new PutObjectCommand({
          Bucket: bucket, Key: legacyKey, Body: legacyBytes, ContentType: "image/svg+xml", ContentLength: legacyBytes.length,
          ChecksumSHA256: Buffer.from(legacySha, "hex").toString("base64"),
          Metadata: { "cad-width": "41", "cad-height": "29" }
        }));

        expect(cluster.deploy(databaseUrl, profileMigration).status).toBe(0);
        seedCadJob(cluster, databaseUrl, { id: "gzip-minio", status: "review_required", withEncodingColumn: true });
        cluster.sql(databaseUrl, `UPDATE "FloorAsset" SET "objectKey"='${gzipKey}', "sizeBytes"=${gzipBytes.length},
          "sha256"='${gzipSha}' WHERE "id"='render-gzip-minio';`);
        await client.send(new PutObjectCommand({
          Bucket: bucket, Key: gzipKey, Body: gzipBytes, ContentType: "image/svg+xml", ContentEncoding: "gzip",
          ContentLength: gzipBytes.length, ChecksumSHA256: Buffer.from(gzipSha, "hex").toString("base64"),
          Metadata: { "cad-width": "37", "cad-height": "23" }
        }));

        expect(cluster.deploy(databaseUrl, safetyMigration).status).toBe(0);
        expect(cluster.sql(databaseUrl, `SELECT COALESCE("contentEncoding", 'identity') FROM "FloorAsset"
          WHERE "id" IN ('render-legacy-minio','render-gzip-minio') ORDER BY "id";`)).toBe("gzip\nidentity");
        await expect(storage.readFloorRenderedMetadata(legacyKey, {
          sizeBytes: legacyBytes.length, sha256: legacySha, mimeType: "image/svg+xml", contentEncoding: null
        })).resolves.toEqual({ width: 41, height: 29 });
        await expect(storage.readFloorRenderedMetadata(gzipKey, {
          sizeBytes: gzipBytes.length, sha256: gzipSha, mimeType: "image/svg+xml", contentEncoding: "gzip"
        })).resolves.toEqual({ width: 37, height: 23 });
        const legacyGet = await fetch(await storage.createFloorAssetDownloadUrl(legacyKey));
        const gzipGet = await fetch(await storage.createFloorAssetDownloadUrl(gzipKey));
        expect(legacyGet.headers.get("content-encoding")).toBeNull();
        expect(gzipGet.headers.get("content-encoding")).toBe("gzip");
        expect(Buffer.from(await legacyGet.arrayBuffer())).toEqual(legacyBytes);
        expect(Buffer.from(await gzipGet.arrayBuffer())).toEqual(gzipSource);
      } finally {
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: legacyKey })).catch(() => undefined);
        await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: gzipKey })).catch(() => undefined);
        client.destroy();
      }
    }
  );

  it.each(["processing", "applying"] as const)("fails closed while a %s job is active", status => {
    const databaseUrl = cluster.database();
    expect(cluster.deploy(databaseUrl, profileMigration).status).toBe(0);
    seedCadJob(cluster, databaseUrl, { id: `active-${status}`, status, withEncodingColumn: true });

    const result = cluster.deploy(databaseUrl, safetyMigration);
    expect(result.status).not.toBe(0);
    expect(cluster.sql(databaseUrl, `
      SELECT count(*) FROM "_prisma_migrations"
      WHERE migration_name = '${safetyMigration}' AND finished_at IS NOT NULL;
    `)).toBe("0");
    expect(cluster.sql(databaseUrl, `SELECT "status"::text FROM "FloorImportJob" WHERE "id"='active-${status}';`)).toBe(status);
  });

  it("observes an old worker processing transition that commits ahead of the migration lock", async () => {
    const databaseUrl = cluster.database();
    expect(cluster.deploy(databaseUrl, profileMigration).status).toBe(0);
    seedCadJob(cluster, databaseUrl, { id: "race-job", status: "queued", withEncodingColumn: true });
    const writer = startPsql(databaseUrl, "cad_old_worker", `
      BEGIN;
      UPDATE "FloorImportJob" SET
        "status"='processing', "stage"='converting', "progressPercent"=10, "attemptCount"=1,
        "leaseOwner"='old-worker', "leaseExpiresAt"=CURRENT_TIMESTAMP + interval '1 minute',
        "startedAt"=CURRENT_TIMESTAMP, "updatedAt"=CURRENT_TIMESTAMP
      WHERE "id"='race-job';
      SELECT pg_sleep(2);
      COMMIT;
    `);
    await waitForActivity(cluster, databaseUrl, "cad_old_worker", "PgSleep");

    const migration = cluster.deploy(databaseUrl, safetyMigration);
    const writerResult = await writer;
    expect(writerResult.status).toBe(0);
    expect(migration.status).not.toBe(0);
    expect(cluster.sql(databaseUrl, `SELECT "status"::text FROM "FloorImportJob" WHERE "id"='race-job';`)).toBe("processing");
  });

  it("times out without partial schema changes behind a long job writer", async () => {
    const databaseUrl = cluster.database();
    expect(cluster.deploy(databaseUrl, profileMigration).status).toBe(0);
    seedCadJob(cluster, databaseUrl, { id: "lock-job", status: "queued", withEncodingColumn: true });
    const writer = startPsql(databaseUrl, "cad_upgrade_lock", `
      BEGIN;
      UPDATE "FloorImportJob" SET "updatedAt"=CURRENT_TIMESTAMP WHERE "id"='lock-job';
      SELECT pg_sleep(20);
      ROLLBACK;
    `);
    await waitForActivity(cluster, databaseUrl, "cad_upgrade_lock", "PgSleep");

    const startedAt = Date.now();
    const migration = cluster.deploy(databaseUrl, safetyMigration);
    const elapsed = Date.now() - startedAt;
    cluster.sql(databaseUrl, `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='cad_upgrade_lock';`);
    await writer;
    expect(migration.status).not.toBe(0);
    expect(elapsed).toBeLessThan(15_000);
    expect(cluster.sql(databaseUrl, `
      SELECT count(*) FROM pg_constraint WHERE conname='FloorImportJob_detector_profile_state_check';
    `)).toBe("0");
  });

  it("requires non-null profile identity for review and completed jobs", () => {
    const databaseUrl = cluster.database();
    expect(cluster.deploy(databaseUrl, safetyMigration).status).toBe(0);
    seedCadJob(cluster, databaseUrl, { id: "terminal-job", status: "review_required", withEncodingColumn: true });
    expect(() => cluster.sql(databaseUrl, `
      UPDATE "FloorImportJob" SET "detectorProfileId"=NULL,
        "detectorProfileVersion"=NULL, "detectorProfileDigest"=NULL
      WHERE "id"='terminal-job';
    `)).toThrow(/FloorImportJob_detector_profile_state_check/);
  });
});

function seedCadJob(
  cluster: Awaited<ReturnType<typeof disposablePostgres>>,
  databaseUrl: string,
  options: {
    id: string;
    status: "queued" | "processing" | "review_required" | "applying";
    withEncodingColumn: boolean;
    suffix?: string;
    missingTerminalIdentity?: boolean;
  }
) {
  const suffix = options.suffix ?? options.id;
  const rendered = options.status === "review_required" || options.status === "applying";
  const encodingColumn = options.withEncodingColumn ? ', "contentEncoding"' : "";
  const encodingValue = options.withEncodingColumn ? ", 'gzip'" : "";
  cluster.sql(databaseUrl, `
    INSERT INTO "Organization" ("id","name","type","createdAt","updatedAt")
      VALUES ('org-${suffix}','CAD Org','customer',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    INSERT INTO "Site" ("id","organizationId","name","createdAt","updatedAt")
      VALUES ('site-${suffix}','org-${suffix}','CAD Site',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    INSERT INTO "Floor" ("id","siteId","name","level","createdAt","updatedAt")
      VALUES ('floor-${suffix}','site-${suffix}','CAD Floor',1,CURRENT_TIMESTAMP,CURRENT_TIMESTAMP);
    INSERT INTO "FloorAsset" (
      "id","floorId","kind","status","objectKey","mimeType","sizeBytes","sha256","readyAt","createdAt","updatedAt"${encodingColumn}
    ) VALUES (
      'source-${suffix}','floor-${suffix}','original','ready','floors/${suffix}/source.dwg','application/dwg',4,'${digest}',CURRENT_TIMESTAMP,
      ${options.withEncodingColumn ? "clock_timestamp() + interval '1 second'" : "TIMESTAMP '2026-01-01 00:00:00'"},CURRENT_TIMESTAMP${options.withEncodingColumn ? ", NULL" : ""}
    );
    ${rendered ? `INSERT INTO "FloorAsset" (
      "id","floorId","kind","status","objectKey","mimeType","sizeBytes","sha256","readyAt","createdAt","updatedAt"${encodingColumn}
    ) VALUES (
      'render-${suffix}','floor-${suffix}','rendered','ready','floors/${suffix}/render.svg','image/svg+xml',8,'${digest}',CURRENT_TIMESTAMP,
      ${options.withEncodingColumn ? "clock_timestamp() + interval '1 second'" : "TIMESTAMP '2026-01-01 00:00:00'"},CURRENT_TIMESTAMP${encodingValue}
    );` : ""}
    INSERT INTO "FloorImportJob" (
      "id","floorId","sourceAssetId","renderedAssetId","sourceFormat","status","stage","progressPercent","attemptCount",
      "detectorProfileId","detectorProfileVersion","detectorProfileDigest","leaseOwner","leaseExpiresAt","startedAt","reviewRequiredAt","updatedAt"
    ) VALUES (
      '${options.id}','floor-${suffix}','source-${suffix}',${rendered ? `'render-${suffix}'` : "NULL"},'dwg','${options.status}',
      '${options.status}',${options.status === "queued" ? 0 : options.status === "processing" ? 10 : 100},${options.status === "queued" ? 0 : 1},
      'generic-lighting-v1',${options.status === "queued" || options.missingTerminalIdentity ? "NULL,NULL" : `'generic-lighting/1','${digest}'`},
      ${options.status === "processing" ? "'worker',CURRENT_TIMESTAMP + interval '1 minute'" : "NULL,NULL"},
      ${options.status === "queued" ? "NULL,NULL" : options.status === "processing" ? "CURRENT_TIMESTAMP,NULL" : "CURRENT_TIMESTAMP,CURRENT_TIMESTAMP"},CURRENT_TIMESTAMP
    );
  `);
}

function startPsql(databaseUrl: string, applicationName: string, sql: string) {
  const url = new URL(databaseUrl);
  url.searchParams.set("application_name", applicationName);
  const child = spawn("psql", [url.toString(), "-XAt", "-v", "ON_ERROR_STOP=1", "-c", sql], { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = ""; let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr.on("data", chunk => { stderr += chunk.toString(); });
  return new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", status => resolve({ status, stdout, stderr }));
  });
}

async function waitForActivity(
  cluster: Awaited<ReturnType<typeof disposablePostgres>>,
  databaseUrl: string,
  applicationName: string,
  waitEvent: string
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (cluster.sql(databaseUrl, `
      SELECT count(*) FROM pg_stat_activity
      WHERE application_name='${applicationName}' AND wait_event='${waitEvent}';
    `) === "1") return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`${applicationName} did not reach ${waitEvent}`);
}
