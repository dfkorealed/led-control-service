import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { disposablePostgres } from "../../test/support/disposable-postgres";

const migrationName = "20260918090000_floor_light_slots_map_reset";
const previousMigrationName = "20260917_report_cleanup_metrics";
const laterMigrationName = "20260918120000_bio_fixture_presence_polling";
const migration = readFileSync(join(
  __dirname,
  `../../prisma/migrations/${migrationName}/migration.sql`
), "utf8");

jest.setTimeout(60_000);

describe("floor light slot migration invariants on disposable PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let databaseUrl: string;

  beforeAll(async () => {
    cluster = await disposablePostgres();
    databaseUrl = cluster.database();
    cluster.sql(databaseUrl, `
      CREATE TABLE "Floor" ("id" TEXT PRIMARY KEY);
      CREATE TABLE "FloorImportJob" (
        "id" TEXT PRIMARY KEY,
        "floorId" TEXT NOT NULL REFERENCES "Floor"("id") ON DELETE CASCADE ON UPDATE CASCADE
      );
      CREATE TABLE "FloorImportCandidate" (
        "id" TEXT PRIMARY KEY,
        "jobId" TEXT NOT NULL REFERENCES "FloorImportJob"("id") ON DELETE CASCADE ON UPDATE CASCADE
      );
      CREATE TABLE "Fixture" (
        "id" TEXT PRIMARY KEY,
        "floorId" TEXT NOT NULL REFERENCES "Floor"("id") ON DELETE CASCADE ON UPDATE CASCADE
      );
      ${migration}
    `);
  });

  beforeEach(() => {
    cluster.sql(databaseUrl, `
      TRUNCATE "FloorLightSlot", "Fixture", "FloorImportCandidate", "FloorImportJob", "Floor" CASCADE;
      INSERT INTO "Floor" ("id") VALUES ('floor-a'), ('floor-b');
      INSERT INTO "FloorImportJob" ("id", "floorId")
      VALUES ('job-a', 'floor-a'), ('job-b', 'floor-b');
      INSERT INTO "Fixture" ("id", "floorId")
      VALUES ('fixture-a', 'floor-a'), ('fixture-b', 'floor-b');
    `);
  });

  afterAll(() => cluster?.stop());

  it("accepts exactly 2,000 slots on one floor", () => {
    seedCandidates(cluster, databaseUrl, 2_000);
    insertSlots(cluster, databaseUrl, 1, 2_000);

    expect(slotCount(cluster, databaseUrl, "floor-a")).toBe("2000");
    expect(cluster.sql(databaseUrl, `
      SELECT min("capacityOrdinal") || ':' || max("capacityOrdinal") || ':' || count(DISTINCT "capacityOrdinal")
      FROM "FloorLightSlot" WHERE "floorId" = 'floor-a';
    `)).toBe("1:2000:2000");
  });

  it("enforces ordinal range and uniqueness even when assignment triggers are disabled", () => {
    seedCandidates(cluster, databaseUrl, 2);

    expect(() => cluster.sql(databaseUrl, `
      SET session_replication_role = replica;
      INSERT INTO "FloorLightSlot" (
        "id", "floorId", "sourceImportJobId", "sourceCandidateId", "capacityOrdinal",
        "x", "y", "rotation", "updatedAt"
      ) VALUES ('slot-range', 'floor-a', 'job-a', 'candidate-1', 0, 1, 1, 0, CURRENT_TIMESTAMP);
    `)).toThrow("FloorLightSlot_capacityOrdinal_check");
    expect(() => cluster.sql(databaseUrl, `
      SET session_replication_role = replica;
      INSERT INTO "FloorLightSlot" (
        "id", "floorId", "sourceImportJobId", "sourceCandidateId", "capacityOrdinal",
        "x", "y", "rotation", "updatedAt"
      ) VALUES
        ('slot-unique-a', 'floor-a', 'job-a', 'candidate-1', 1, 1, 1, 0, CURRENT_TIMESTAMP),
        ('slot-unique-b', 'floor-a', 'job-a', 'candidate-2', 1, 2, 2, 0, CURRENT_TIMESTAMP);
    `)).toThrow("FloorLightSlot_floorId_capacityOrdinal_key");
  });

  it("owns ordinal assignment when callers provide or update the field", () => {
    seedCandidates(cluster, databaseUrl, 1);
    cluster.sql(databaseUrl, `
      INSERT INTO "FloorLightSlot" (
        "id", "floorId", "sourceImportJobId", "sourceCandidateId", "capacityOrdinal",
        "x", "y", "rotation", "updatedAt"
      ) VALUES ('slot-managed', 'floor-a', 'job-a', 'candidate-1', 2000, 1, 1, 0, CURRENT_TIMESTAMP);
    `);
    expect(cluster.sql(databaseUrl, `
      SELECT "capacityOrdinal" FROM "FloorLightSlot" WHERE "id" = 'slot-managed';
    `)).toBe("1");

    cluster.sql(databaseUrl, `
      UPDATE "FloorLightSlot" SET "capacityOrdinal" = 2000 WHERE "id" = 'slot-managed';
    `);
    expect(cluster.sql(databaseUrl, `
      SELECT "capacityOrdinal" FROM "FloorLightSlot" WHERE "id" = 'slot-managed';
    `)).toBe("1");
  });

  it("rejects a 2,001st slot on one floor", () => {
    seedCandidates(cluster, databaseUrl, 2_001);

    expect(() => insertSlots(cluster, databaseUrl, 1, 2_001))
      .toThrow("floor light slot capacity exceeded");
    expect(slotCount(cluster, databaseUrl, "floor-a")).toBe("0");
  });

  it("allows a transaction to replace 2,000 old slots with 2,000 new slots", () => {
    seedCandidates(cluster, databaseUrl, 4_000);
    insertSlots(cluster, databaseUrl, 1, 2_000);

    cluster.sql(databaseUrl, `
      BEGIN;
      DELETE FROM "FloorLightSlot" WHERE "floorId" = 'floor-a';
      INSERT INTO "FloorLightSlot" (
        "id", "floorId", "sourceImportJobId", "sourceCandidateId", "x", "y", "rotation", "updatedAt"
      )
      SELECT
        'replacement-slot-' || value,
        'floor-a',
        'job-a',
        'candidate-' || value,
        value,
        value,
        0,
        CURRENT_TIMESTAMP
      FROM generate_series(2001, 4000) AS value;
      COMMIT;
    `);

    expect(slotCount(cluster, databaseUrl, "floor-a")).toBe("2000");
    expect(cluster.sql(databaseUrl, `
      SELECT count(*) FROM "FloorLightSlot" WHERE "id" LIKE 'replacement-slot-%';
    `)).toBe("2000");
    expect(cluster.sql(databaseUrl, `
      SELECT min("capacityOrdinal") || ':' || max("capacityOrdinal") || ':' || count(DISTINCT "capacityOrdinal")
      FROM "FloorLightSlot" WHERE "floorId" = 'floor-a';
    `)).toBe("1:2000:2000");
  });

  it("rejects moving a slot onto a floor that already has 2,000 slots", () => {
    cluster.sql(databaseUrl, `
      INSERT INTO "FloorImportCandidate" ("id", "jobId")
      SELECT 'candidate-b-' || value, 'job-b'
      FROM generate_series(1, 2001) AS value;
      INSERT INTO "FloorImportCandidate" ("id", "jobId") VALUES ('candidate-a', 'job-a');
      INSERT INTO "FloorLightSlot" (
        "id", "floorId", "sourceImportJobId", "sourceCandidateId", "x", "y", "rotation", "updatedAt"
      )
      SELECT
        'slot-b-' || value,
        'floor-b',
        'job-b',
        'candidate-b-' || value,
        value,
        value,
        0,
        CURRENT_TIMESTAMP
      FROM generate_series(1, 2000) AS value;
    `);
    insertSlot(cluster, databaseUrl, {
      id: "slot-moving", floorId: "floor-a", jobId: "job-a", candidateId: "candidate-a"
    });

    expect(() => cluster.sql(databaseUrl, `
      UPDATE "FloorLightSlot"
      SET
        "floorId" = 'floor-b',
        "sourceImportJobId" = 'job-b',
        "sourceCandidateId" = 'candidate-b-2001'
      WHERE "id" = 'slot-moving';
    `)).toThrow("floor light slot capacity exceeded");
    expect(slotCount(cluster, databaseUrl, "floor-a")).toBe("1");
    expect(slotCount(cluster, databaseUrl, "floor-b")).toBe("2000");
  });

  it("serializes concurrent transactions so they cannot exceed 2,000 slots", async () => {
    seedCandidates(cluster, databaseUrl, 2_001);
    insertSlots(cluster, databaseUrl, 1, 1_999);

    const first = startPsql(databaseUrl, "floor_slot_writer_first", `
      BEGIN ISOLATION LEVEL REPEATABLE READ;
      ${slotInsertSql(2_000)}
      SELECT pg_sleep(3);
      COMMIT;
    `);
    await waitForCapacityLockAndSleep(cluster, databaseUrl, "floor_slot_writer_first");
    const second = startPsql(databaseUrl, "floor_slot_writer_second", `
      BEGIN ISOLATION LEVEL REPEATABLE READ;
      ${slotInsertSql(2_001)}
      COMMIT;
    `);
    await waitForAdvisoryLockWait(cluster, databaseUrl, "floor_slot_writer_second");

    const [firstResult, secondResult] = await Promise.all([first.completed, second.completed]);
    expect(firstResult.status).toBe(0);
    expect(secondResult.status).not.toBe(0);
    expect(secondResult.stderr).toMatch(/duplicate key|could not serialize|capacity exceeded/i);
    expect(slotCount(cluster, databaseUrl, "floor-a")).toBe("2000");
    expect(Number(slotCount(cluster, databaseUrl, "floor-a"))).toBeLessThanOrEqual(2_000);
  });

  it("rejects candidate, job, and floor scope mismatches", () => {
    cluster.sql(databaseUrl, `
      INSERT INTO "FloorImportCandidate" ("id", "jobId")
      VALUES ('candidate-a', 'job-a'), ('candidate-b', 'job-b');
    `);

    expect(() => insertSlot(cluster, databaseUrl, {
      id: "slot-candidate-mismatch",
      floorId: "floor-a",
      jobId: "job-a",
      candidateId: "candidate-b"
    })).toThrow("floor light slot scope invariant violated");
    expect(() => insertSlot(cluster, databaseUrl, {
      id: "slot-floor-mismatch",
      floorId: "floor-b",
      jobId: "job-a",
      candidateId: "candidate-a"
    })).toThrow("floor light slot scope invariant violated");
  });

  it("rejects assigning a fixture from another floor", () => {
    cluster.sql(databaseUrl, `
      INSERT INTO "FloorImportCandidate" ("id", "jobId") VALUES ('candidate-a', 'job-a');
    `);

    expect(() => insertSlot(cluster, databaseUrl, {
      id: "slot-a",
      floorId: "floor-a",
      jobId: "job-a",
      candidateId: "candidate-a",
      fixtureId: "fixture-b"
    })).toThrow("floor light slot scope invariant violated");
  });

  it("rejects parent updates that would invalidate an existing slot", () => {
    seedAssignedSlot(cluster, databaseUrl);

    expect(() => cluster.sql(databaseUrl, `
      UPDATE "FloorImportCandidate" SET "jobId" = 'job-b' WHERE "id" = 'candidate-a';
    `)).toThrow("floor light slot scope invariant violated");
    expect(() => cluster.sql(databaseUrl, `
      UPDATE "FloorImportJob" SET "floorId" = 'floor-b' WHERE "id" = 'job-a';
    `)).toThrow("floor light slot scope invariant violated");
    expect(() => cluster.sql(databaseUrl, `
      UPDATE "Fixture" SET "floorId" = 'floor-b' WHERE "id" = 'fixture-a';
    `)).toThrow("floor light slot scope invariant violated");
  });

  it("cascades candidate and job deletion to their slots", () => {
    cluster.sql(databaseUrl, `
      INSERT INTO "FloorImportCandidate" ("id", "jobId")
      VALUES ('candidate-a', 'job-a'), ('candidate-b', 'job-b');
    `);
    insertSlot(cluster, databaseUrl, {
      id: "slot-a", floorId: "floor-a", jobId: "job-a", candidateId: "candidate-a"
    });
    insertSlot(cluster, databaseUrl, {
      id: "slot-b", floorId: "floor-b", jobId: "job-b", candidateId: "candidate-b"
    });

    cluster.sql(databaseUrl, `DELETE FROM "FloorImportCandidate" WHERE "id" = 'candidate-a';`);
    expect(cluster.sql(databaseUrl, `SELECT count(*) FROM "FloorLightSlot" WHERE "id" = 'slot-a';`)).toBe("0");

    cluster.sql(databaseUrl, `DELETE FROM "FloorImportJob" WHERE "id" = 'job-b';`);
    expect(cluster.sql(databaseUrl, `
      SELECT
        (SELECT count(*) FROM "FloorImportCandidate" WHERE "id" = 'candidate-b') || ':' ||
        (SELECT count(*) FROM "FloorLightSlot" WHERE "id" = 'slot-b');
    `)).toBe("0:0");
  });

  it("sets an assigned slot to unassigned when its fixture is deleted", () => {
    seedAssignedSlot(cluster, databaseUrl);

    cluster.sql(databaseUrl, `DELETE FROM "Fixture" WHERE "id" = 'fixture-a';`);

    expect(cluster.sql(databaseUrl, `
      SELECT "assignedFixtureId" IS NULL FROM "FloorLightSlot" WHERE "id" = 'slot-a';
    `)).toBe("t");
  });

  it("cascades a Floor id update through slots, jobs, and fixtures", () => {
    seedAssignedSlot(cluster, databaseUrl);

    cluster.sql(databaseUrl, `UPDATE "Floor" SET "id" = 'floor-a-renamed' WHERE "id" = 'floor-a';`);

    expect(cluster.sql(databaseUrl, `
      SELECT
        slot."floorId" || ':' || job."floorId" || ':' || fixture."floorId" || ':' || slot."capacityOrdinal"
      FROM "FloorLightSlot" AS slot
      JOIN "FloorImportJob" AS job ON job."id" = slot."sourceImportJobId"
      JOIN "Fixture" AS fixture ON fixture."id" = slot."assignedFixtureId"
      WHERE slot."id" = 'slot-a';
    `)).toBe("floor-a-renamed:floor-a-renamed:floor-a-renamed:1");
  });

  it("cascades Floor deletion without leaving slots or dependent rows", () => {
    seedAssignedSlot(cluster, databaseUrl);

    cluster.sql(databaseUrl, `DELETE FROM "Floor" WHERE "id" = 'floor-a';`);

    expect(cluster.sql(databaseUrl, `
      SELECT
        (SELECT count(*) FROM "FloorLightSlot") || ':' ||
        (SELECT count(*) FROM "FloorImportCandidate") || ':' ||
        (SELECT count(*) FROM "FloorImportJob") || ':' ||
        (SELECT count(*) FROM "Fixture");
    `)).toBe("0:0:1:1");
  });

  it("clean-deploys the full migration chain in timestamp order", () => {
    const cleanDatabaseUrl = cluster.database();
    const result = cluster.deploy(cleanDatabaseUrl, migrationName);

    expect(result.status).toBe(0);
    expect(result.stderr).not.toContain("Error");
    const applicationOrder = cluster.sql(cleanDatabaseUrl, `
      SELECT migration_name
      FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL
      ORDER BY started_at, id;
    `).split("\n");
    expect(applicationOrder.at(-1)).toBe(migrationName);
    expect(applicationOrder.indexOf(previousMigrationName)).toBeLessThan(applicationOrder.indexOf(migrationName));
    expect(applicationOrder).not.toContain(laterMigrationName);
  });
});

function seedCandidates(
  cluster: Awaited<ReturnType<typeof disposablePostgres>>,
  databaseUrl: string,
  count: number
) {
  cluster.sql(databaseUrl, `
    INSERT INTO "FloorImportCandidate" ("id", "jobId")
    SELECT 'candidate-' || value, 'job-a'
    FROM generate_series(1, ${count}) AS value;
  `);
}

function insertSlots(
  cluster: Awaited<ReturnType<typeof disposablePostgres>>,
  databaseUrl: string,
  first: number,
  last: number
) {
  cluster.sql(databaseUrl, `
    INSERT INTO "FloorLightSlot" (
      "id", "floorId", "sourceImportJobId", "sourceCandidateId", "x", "y", "rotation", "updatedAt"
    )
    SELECT
      'slot-' || value,
      'floor-a',
      'job-a',
      'candidate-' || value,
      value,
      value,
      0,
      CURRENT_TIMESTAMP
    FROM generate_series(${first}, ${last}) AS value;
  `);
}

function insertSlot(
  cluster: Awaited<ReturnType<typeof disposablePostgres>>,
  databaseUrl: string,
  slot: { id: string; floorId: string; jobId: string; candidateId: string; fixtureId?: string }
) {
  const fixtureId = slot.fixtureId ? `'${slot.fixtureId}'` : "NULL";
  cluster.sql(databaseUrl, `
    INSERT INTO "FloorLightSlot" (
      "id", "floorId", "sourceImportJobId", "sourceCandidateId", "assignedFixtureId",
      "x", "y", "rotation", "updatedAt"
    ) VALUES (
      '${slot.id}', '${slot.floorId}', '${slot.jobId}', '${slot.candidateId}', ${fixtureId},
      1, 2, 0, CURRENT_TIMESTAMP
    );
  `);
}

function seedAssignedSlot(
  cluster: Awaited<ReturnType<typeof disposablePostgres>>,
  databaseUrl: string
) {
  cluster.sql(databaseUrl, `
    INSERT INTO "FloorImportCandidate" ("id", "jobId") VALUES ('candidate-a', 'job-a');
  `);
  insertSlot(cluster, databaseUrl, {
    id: "slot-a",
    floorId: "floor-a",
    jobId: "job-a",
    candidateId: "candidate-a",
    fixtureId: "fixture-a"
  });
}

function slotCount(
  cluster: Awaited<ReturnType<typeof disposablePostgres>>,
  databaseUrl: string,
  floorId: string
) {
  return cluster.sql(databaseUrl, `
    SELECT count(*) FROM "FloorLightSlot" WHERE "floorId" = '${floorId}';
  `);
}

function slotInsertSql(value: number) {
  return `
    INSERT INTO "FloorLightSlot" (
      "id", "floorId", "sourceImportJobId", "sourceCandidateId", "x", "y", "rotation", "updatedAt"
    ) VALUES (
      'slot-${value}', 'floor-a', 'job-a', 'candidate-${value}', ${value}, ${value}, 0, CURRENT_TIMESTAMP
    );
  `;
}

function startPsql(databaseUrl: string, applicationName: string, sql: string) {
  const url = new URL(databaseUrl);
  url.searchParams.set("application_name", applicationName);
  const child = spawn("psql", ["-X", "-qAt", "-v", "ON_ERROR_STOP=1", url.toString(), "-c", sql], {
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", chunk => { stdout += chunk.toString(); });
  child.stderr?.on("data", chunk => { stderr += chunk.toString(); });
  return {
    completed: new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", status => resolve({ status, stdout, stderr }));
    })
  };
}

async function waitForCapacityLockAndSleep(
  cluster: Awaited<ReturnType<typeof disposablePostgres>>,
  databaseUrl: string,
  applicationName: string
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = cluster.sql(databaseUrl, `
      SELECT count(*)
      FROM pg_stat_activity AS activity
      JOIN pg_locks AS lock ON lock.pid = activity.pid
      WHERE activity.application_name = '${applicationName}'
        AND activity.wait_event = 'PgSleep'
        AND lock.locktype = 'advisory'
        AND lock.granted;
    `);
    if (state === "1") return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`${applicationName} did not hold the capacity lock at the concurrency barrier`);
}

async function waitForAdvisoryLockWait(
  cluster: Awaited<ReturnType<typeof disposablePostgres>>,
  databaseUrl: string,
  applicationName: string
) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const waiting = cluster.sql(databaseUrl, `
      SELECT count(*) FROM pg_stat_activity
      WHERE application_name = '${applicationName}'
        AND wait_event_type = 'Lock'
        AND wait_event = 'advisory';
    `);
    if (waiting === "1") return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`${applicationName} did not wait for the floor capacity lock`);
}
