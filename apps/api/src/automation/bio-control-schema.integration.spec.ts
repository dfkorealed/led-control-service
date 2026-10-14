import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { disposablePostgres } from "../../test/support/disposable-postgres";

const migration = "20261014090000_bio_temporary_control_calendar";
const hash = `sha256:${"a".repeat(64)}`;
const otherHash = `sha256:${"b".repeat(64)}`;
const now = new Date("2026-10-14T00:00:00Z");

describe("BIO temporary control persistence on self-owned PostgreSQL", () => {
  jest.setTimeout(60_000);
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;
  let legacy: Awaited<ReturnType<typeof seed>>;
  let legacyBefore: unknown;

  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    const before = cluster.deploy(url, "99999999", { exclude: [migration] });
    if (before.status !== 0) throw new Error(before.stderr + before.stdout);
    db = new PrismaClient({ datasourceUrl: url });
    legacy = await seed(db);
    await db.$transaction(async tx => {
      const scheduleId = randomUUID();
      await tx.$executeRaw`INSERT INTO "LightingSchedule" (id,"siteId","gatewayId",name,"activeFrom","activeUntil","localStartTime","localEndTime","recurrenceKind","dimmingEnabled","brightnessPercent","createdById","updatedById","updatedAt")
        VALUES (${scheduleId},${legacy.site.id},${legacy.gateway.id},'preserved',${now},${now},'08:00','09:00','once',true,60,${legacy.actor.id},${legacy.actor.id},${now})`;
      await tx.lightingScheduleFixture.create({ data: { scheduleId, fixtureId: legacy.fixture.id, siteId: legacy.site.id, gatewayId: legacy.gateway.id } });
    });
    legacyBefore = await db.meshNode.findMany({ where: { gatewayId: legacy.gateway.id }, orderBy: { id: "asc" } });
    const deployed = cluster.deploy(url);
    if (deployed.status !== 0) {
      // Prisma may hide the first transactional DDL error behind 25P02.
      // Re-run only on this disposable DB to expose the original PostgreSQL diagnostic.
      cluster.sql(url, readFileSync(join(__dirname, "../../prisma/migrations", migration, "migration.sql"), "utf8"));
      throw new Error(deployed.stderr + deployed.stdout);
    }
  });
  afterAll(async () => { try { await db?.$disconnect(); } finally { cluster?.stop(); } });

  const rows = <T = Record<string, unknown>>(sql: string, ...args: unknown[]) => db.$queryRawUnsafe<T[]>(sql, ...args);
  const execute = (sql: string, ...args: unknown[]) => db.$executeRawUnsafe(sql, ...args);
  // Identifiers below are local literals; values always use bound parameters.
  const insert = (table: string, data: Record<string, unknown>) => {
    const entries = Object.entries(data);
    const jsonKeys = ["payload", "dates", "completenessProof", "result"];
    return execute(`INSERT INTO "${table}" (${entries.map(([key]) => `"${key}"`).join(",")}) VALUES (${entries.map(([key], i) => `$${i + 1}${jsonKeys.includes(key) ? "::jsonb" : ""}`).join(",")})`,
      ...entries.map(([key, value]) => jsonKeys.includes(key) ? JSON.stringify(value) : value));
  };
  async function session(h: Awaited<ReturnType<typeof seed>>) {
    const id = randomUUID();
    await insert("TemporaryControlSession", { id, siteId: h.site.id, gatewayId: h.gateway.id,
      actorId: h.actor.id, assignmentVersion: 1, admissionRevision: 0, originSequence: 1n,
      originCommandHash: hash, startedAt: now, endsAt: new Date(now.getTime() + 60_000), brightness: 60, durationMinutes: 1 });
    return id;
  }
  async function lease(h: Awaited<ReturnType<typeof seed>>) {
    await insert("TemporaryControlLease", { fixtureId: h.fixture.id, liveFixtureId: h.fixture.id,
      siteId: h.site.id, gatewayId: h.gateway.id, meshNodeId: h.node.id,
      nativeUuid: h.nativeUuid, logicalAddress: "0x0100" });
  }
  const target = (h: Awaited<ReturnType<typeof seed>>, sessionId: string, applyGeneration = 1n) => insert("TemporaryControlTarget", {
    sessionId, fixtureId: h.fixture.id, siteId: h.site.id, gatewayId: h.gateway.id,
    meshNodeId: h.node.id, nativeUuid: h.nativeUuid, logicalAddress: "0x0100", applyGeneration, releaseGeneration: applyGeneration + 1n
  });
  async function settle(h: Awaited<ReturnType<typeof seed>>, sessionId: string) {
    // This fixture explicitly proves zero RF. Mutation/readback adjudication belongs to Task4.
    await execute('UPDATE "TemporaryControlSession" SET "sessionRevision"=2,"releaseIntentAt"=$2 WHERE id=$1', sessionId, now);
    await execute('UPDATE "TemporaryControlTarget" SET "resolvedAt"=$3,"unchangedConfirmed"=true WHERE "sessionId"=$1 AND "fixtureId"=$2', sessionId, h.fixture.id, now);
    await execute('UPDATE "TemporaryControlLease" SET "ownerSessionId"=NULL WHERE "fixtureId"=$1', h.fixture.id);
    await execute('UPDATE "TemporaryControlSession" SET state=\'cancelled\',"terminalAt"=$2 WHERE id=$1', sessionId, now);
  }

  it("adds false schedule defaults while retaining native/BIO identities and settings", async () => {
    const schedules = await rows('SELECT to_jsonb(s) AS value FROM "LightingSchedule" s WHERE "siteId"=$1', legacy.site.id);
    expect(schedules[0].value).toMatchObject({ excludeWeekends: false, excludeHolidays: false, brightnessPercent: 60 });
    expect(await db.meshNode.findMany({ where: { gatewayId: legacy.gateway.id }, orderBy: { id: "asc" } })).toEqual(legacyBefore);
    expect(await db.fixture.findUnique({ where: { id: legacy.fixture.id } })).toMatchObject({ brightness: 37, bioConfiguredBrightness: 74 });
  });

  it("serializes competing owners and reserves exactly one monotonic generation pair", async () => {
    const h = await seed(db); await lease(h);
    const a = await session(h); const b = await session(h);
    const attempts = await Promise.allSettled([target(h, a), target(h, b)]);
    expect(attempts.filter(value => value.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter(value => value.status === "rejected")).toHaveLength(1);
    expect(await rows('SELECT "lastGeneration","ownerSessionId" FROM "TemporaryControlLease" WHERE "fixtureId"=$1', h.fixture.id))
      .toEqual([{ lastGeneration: 2n, ownerSessionId: attempts[0].status === "fulfilled" ? a : b }]);
    await expect(execute('UPDATE "TemporaryControlLease" SET "lastGeneration"=0 WHERE "fixtureId"=$1', h.fixture.id)).rejects.toThrow();
    await expect(execute('UPDATE "TemporaryControlLease" SET "ownerSessionId"=$2 WHERE "fixtureId"=$1', h.fixture.id, attempts[0].status === "fulfilled" ? b : a)).rejects.toThrow();
  });

  it("rejects cross-site/Gateway snapshots, altered identity and counter skips without consuming generations", async () => {
    const h = await seed(db); const foreign = await seed(db); await lease(h);
    const own = await session(h); const other = await session(foreign);
    await expect(target(h, other)).rejects.toThrow();
    await expect(target(h, own, 3n)).rejects.toThrow();
    await expect(target({ ...h, nativeUuid: "aaaaaaaaaaaa" }, own)).rejects.toThrow();
    await expect(insert("TemporaryControlSession", { id: randomUUID(), siteId: foreign.site.id, gatewayId: h.gateway.id,
      actorId: h.actor.id, assignmentVersion: 1, admissionRevision: 0, originSequence: 1n, originCommandHash: hash,
      startedAt: now, endsAt: new Date(now.getTime() + 60_000), brightness: 60, durationMinutes: 1 })).rejects.toThrow();
    expect(await rows('SELECT "lastGeneration" FROM "TemporaryControlLease" WHERE "fixtureId"=$1', h.fixture.id)).toEqual([{ lastGeneration: 0n }]);
    await target(h, own);
    await expect(execute('UPDATE "TemporaryControlTarget" SET "nativeUuid"=\'aaaaaaaaaaaa\' WHERE "sessionId"=$1', own)).rejects.toThrow();
    await expect(execute('UPDATE "TemporaryControlSession" SET "endsAt"="endsAt"+interval \'1 minute\',"durationMinutes"=2 WHERE id=$1', own)).rejects.toThrow();
  });

  it("protects unresolved deletion, redaction, reassignment and unsafe owner release", async () => {
    const h = await seed(db); await lease(h); const id = await session(h); await target(h, id);
    for (const [sql, arg] of [
      ['DELETE FROM "Fixture" WHERE id=$1', h.fixture.id],
      ['DELETE FROM "TemporaryControlSession" WHERE id=$1', id],
      ['DELETE FROM "TemporaryControlLease" WHERE "fixtureId"=$1', h.fixture.id],
      ['UPDATE "TemporaryControlLease" SET "ownerSessionId"=NULL WHERE "fixtureId"=$1', h.fixture.id],
      ['UPDATE "TemporaryControlSession" SET "detailsRedacted"=true,brightness=NULL WHERE id=$1', id],
      ['UPDATE "MeshNode" SET "deviceUuid"=\'bio:aaaaaaaaaaaa\' WHERE id=$1', h.node.id]
    ]) await expect(execute(sql, arg)).rejects.toThrow();
  });

  it("rolls back a reserved pair with its transaction and rejects admission after assignment changes", async () => {
    const h = await seed(db); await lease(h); const id = await session(h);
    await expect(db.$transaction(async tx => {
      await tx.$executeRaw`INSERT INTO "TemporaryControlTarget" ("sessionId","fixtureId","siteId","gatewayId","meshNodeId","nativeUuid","logicalAddress","applyGeneration","releaseGeneration")
        VALUES (${id},${h.fixture.id},${h.site.id},${h.gateway.id},${h.node.id},${h.nativeUuid},'0x0100',1,2)`;
      throw new Error("later admission failure");
    })).rejects.toThrow("later admission failure");
    expect(await rows('SELECT "lastGeneration","ownerSessionId" FROM "TemporaryControlLease" WHERE "fixtureId"=$1', h.fixture.id))
      .toEqual([{ lastGeneration: 0n, ownerSessionId: null }]);
    expect(await rows('SELECT count(*)::int AS n FROM "TemporaryControlTarget" WHERE "sessionId"=$1', id)).toEqual([{ n: 0 }]);
    await db.gateway.update({ where: { id: h.gateway.id }, data: { assignmentVersion: 2 } });
    await expect(target(h, id)).rejects.toThrow();
  });

  it("persists string delivery envelopes separately and requires durable release intent before end outbox", async () => {
    const h = await seed(db); await lease(h); const id = await session(h); await target(h, id);
    const row = { id: randomUUID(), sessionId: id, siteId: h.site.id, gatewayId: h.gateway.id,
      kind: "start", sessionRevision: 1, deduplicationKey: randomUUID(), payload: { immutable: true }, payloadHash: hash,
      deliveryGeneration: randomUUID(), deliveryPayloadHash: otherHash, deliveryGeneratedAt: now,
      deliveryWindowMs: 10000, expiresAt: new Date(now.getTime() + 10000) };
    await insert("TemporaryControlOutbox", row);
    await expect(execute('UPDATE "TemporaryControlOutbox" SET payload=\'{}\',"payloadHash"=$2 WHERE id=$1', row.id, otherHash)).rejects.toThrow();
    await expect(execute('DELETE FROM "TemporaryControlOutbox" WHERE id=$1', row.id)).rejects.toThrow();
    await expect(insert("TemporaryControlOutbox", { ...row, id: randomUUID(), deduplicationKey: randomUUID(), expiresAt: new Date(now.getTime() + 120000), deliveryWindowMs: 120000 })).rejects.toThrow();
    await expect(insert("TemporaryControlOutbox", { ...row, id: randomUUID(), deduplicationKey: randomUUID(), kind: "end", sessionRevision: 2 })).rejects.toThrow();
    await execute('UPDATE "TemporaryControlSession" SET "sessionRevision"=2,"releaseIntentAt"=$2 WHERE id=$1', id, now);
    await insert("TemporaryControlOutbox", { ...row, id: randomUUID(), deduplicationKey: randomUUID(), kind: "end", sessionRevision: 2 });
  });

  it("keeps uncertain writes owned until observed restoration and allows terminal readback redaction", async () => {
    const h = await seed(db); await lease(h); const id = await session(h); await target(h, id);
    await execute('UPDATE "TemporaryControlTarget" SET "configurationMayHaveChanged"=true,"partialMutation"=\'unverified\',"rfWriteEvidence"=\'may_have_written\' WHERE "sessionId"=$1', id);
    await expect(execute('UPDATE "TemporaryControlTarget" SET "configurationMayHaveChanged"=false,"partialMutation"=\'none\',"rfWriteEvidence"=\'not_started\',"unchangedConfirmed"=true,"resolvedAt"=$2 WHERE "sessionId"=$1', id, now)).rejects.toThrow();
    await execute('UPDATE "TemporaryControlSession" SET "sessionRevision"=2,"releaseIntentAt"=$2 WHERE id=$1', id, now);
    await execute('UPDATE "TemporaryControlTarget" SET "releaseConfirmed"=true,"restorationRevision"=1,"restorationPayloadHash"=$2,"partialMutation"=\'none\',"rfWriteEvidence"=\'observed\',"configurationReadback"=\'{"configuredHighBrightnessPercent":74,"bioMode":"sensor"}\',"resolvedAt"=$3 WHERE "sessionId"=$1', id, hash, now);
    await execute('UPDATE "TemporaryControlLease" SET "ownerSessionId"=NULL WHERE "fixtureId"=$1', h.fixture.id);
    await execute('UPDATE "TemporaryControlSession" SET state=\'restored\',"terminalAt"=$2,"detailsRedacted"=true,brightness=NULL WHERE id=$1', id, now);
    await execute('UPDATE "TemporaryControlTarget" SET "configurationReadback"=NULL,reason=NULL WHERE "sessionId"=$1', id);
    expect(await rows('SELECT "releaseGeneration","releaseConfirmed","configurationReadback" FROM "TemporaryControlTarget" WHERE "sessionId"=$1', id))
      .toEqual([{ releaseGeneration: 2n, releaseConfirmed: true, configurationReadback: null }]);
  });

  it("stores UTC retry and creation timestamps even with a non-UTC PostgreSQL session", async () => {
    const h = await seed(db); await lease(h); const id = await session(h);
    await db.$transaction(async tx => {
      await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'Asia/Seoul'");
      await tx.$executeRaw`INSERT INTO "TemporaryControlOutbox" (id,"sessionId","siteId","gatewayId",kind,"sessionRevision","deduplicationKey",payload,"payloadHash")
        VALUES (${randomUUID()},${id},${h.site.id},${h.gateway.id},'start',1,${randomUUID()},'{}',${hash})`;
      expect(await tx.$queryRaw`SELECT abs(extract(epoch from ("nextAttemptAt"-(CURRENT_TIMESTAMP AT TIME ZONE 'UTC'))))<1 AS valid
        FROM "TemporaryControlOutbox" WHERE "sessionId"=${id}`).toEqual([{ valid: true }]);
    });
  });

  it("retains replay fingerprints and tombstones through redaction and fixture recreation", async () => {
    const h = await seed(db); await lease(h); const id = await session(h); await target(h, id);
    const clientRequestId = randomUUID();
    for (const operation of ["start", "end"]) await insert("TemporaryControlOperationReceipt", {
      siteId: h.site.id, actorId: h.actor.id, operation, clientRequestId, fingerprint: hash, sessionId: id
    });
    await settle(h, id);
    await execute('UPDATE "TemporaryControlSession" SET "detailsRedacted"=true,brightness=NULL WHERE id=$1', id);
    expect(await rows('SELECT count(*)::int AS n FROM "TemporaryControlOperationReceipt" WHERE "sessionId"=$1', id)).toEqual([{ n: 2 }]);
    await expect(insert("TemporaryControlOperationReceipt", { siteId: h.site.id, actorId: h.actor.id, operation: "start", clientRequestId,
      fingerprint: otherHash, sessionId: id })).rejects.toThrow();
    await expect(execute('DELETE FROM "TemporaryControlOperationReceipt" WHERE "sessionId"=$1', id)).rejects.toThrow();
    const next = await session(h); await target(h, next, 3n);
    expect(await rows('SELECT "applyGeneration","releaseGeneration" FROM "TemporaryControlTarget" WHERE "sessionId"=$1', next)).toEqual([{ applyGeneration: 3n, releaseGeneration: 4n }]);
    await settle(h, next);
    await db.fixture.delete({ where: { id: h.fixture.id } });
    expect(await rows('SELECT "lastGeneration","releaseTombstoneGeneration","liveFixtureId" FROM "TemporaryControlLease" WHERE "fixtureId"=$1', h.fixture.id))
      .toEqual([{ lastGeneration: 4n, releaseTombstoneGeneration: 4n, liveFixtureId: null }]);
    await expect(db.fixture.create({ data: { id: h.fixture.id, floorId: h.floor.id, name: "reused PK", ratedWatt: 20, x: 0, y: 0 } })).rejects.toThrow();
    await db.meshNode.update({ where: { id: h.node.id }, data: { deviceUuid: "bio:bbbbbbbbbbbb" } });
    const fixture = await db.fixture.create({ data: { floorId: h.floor.id, siteId: h.site.id, gatewayId: h.gateway.id, meshNodeId: h.node.id, name: "new identity", ratedWatt: 20, x: 0, y: 0 } });
    const recreated = { ...h, fixture, nativeUuid: "bbbbbbbbbbbb" }; await lease(recreated);
    const fresh = await session(recreated); await target(recreated, fresh);
    await expect(target(recreated, id)).rejects.toThrow();
    await expect(insert("TemporaryControlResultReceipt", { eventId: randomUUID(), sessionId: id, siteId: h.site.id, gatewayId: h.gateway.id,
      fixtureId: fixture.id, sessionRevision: 2, targetGeneration: 2n, resultHash: hash, status: "applied" })).rejects.toThrow();
    expect(await rows('SELECT "lastGeneration" FROM "TemporaryControlLease" WHERE "fixtureId"=$1', fixture.id)).toEqual([{ lastGeneration: 2n }]);
  });

  it("binds result events to original session/target/generation and keeps immutable first receipts", async () => {
    const h = await seed(db); await lease(h); const id = await session(h); await target(h, id);
    const receipt = { eventId: randomUUID(), sessionId: id, siteId: h.site.id, gatewayId: h.gateway.id, fixtureId: h.fixture.id,
      sessionRevision: 1, targetGeneration: 1n, resultHash: hash, status: "applied", ingestedAt: now };
    await insert("TemporaryControlResultReceipt", receipt);
    await expect(insert("TemporaryControlResultReceipt", { ...receipt, resultHash: otherHash })).rejects.toThrow();
    await expect(insert("TemporaryControlResultReceipt", { ...receipt, eventId: randomUUID(), targetGeneration: 2n })).rejects.toThrow();
    await expect(execute('UPDATE "TemporaryControlResultReceipt" SET "resultHash"=$2 WHERE "eventId"=$1', receipt.eventId, otherHash)).rejects.toThrow();
    await insert("TemporaryControlOutbox", { id: randomUUID(), sessionId: id, siteId: h.site.id, gatewayId: h.gateway.id,
      kind: "start", sessionRevision: 1, deduplicationKey: id, payload: {}, payloadHash: hash });
    await expect(insert("TemporaryControlOutbox", { id: randomUUID(), sessionId: id, siteId: h.site.id, gatewayId: h.gateway.id,
      kind: "start", sessionRevision: 1, deduplicationKey: id, payload: {}, payloadHash: hash })).rejects.toThrow();
    await settle(h, id);
    await execute('UPDATE "TemporaryControlSession" SET "detailsRedacted"=true,brightness=NULL WHERE id=$1', id);
    expect(await rows('SELECT "resultHash" FROM "TemporaryControlResultReceipt" WHERE "eventId"=$1', receipt.eventId)).toEqual([{ resultHash: hash }]);
  });

  it("promotes only complete same-country/year holiday datasets and preserves coverage on a failed swap", async () => {
    const dataset = { id: randomUUID(), country: "KR", source: "kasi", year: 2026, revision: randomUUID(), fetchedAt: now,
      coverageFrom: new Date("2026-01-01Z"), coverageUntil: new Date("2026-12-31Z"), payloadHash: hash, dates: [],
      completenessProof: Array.from({ length: 12 }, (_, month) => ({ month: month + 1, totalCount: 0, pageCount: 1 })), complete: true };
    await expect(insert("HolidayDataset", { ...dataset, completenessProof: [] })).rejects.toThrow();
    await expect(insert("HolidayDataset", { ...dataset, dates: [{ date: "2027-01-01", names: ["wrong year"] }] })).rejects.toThrow();
    await insert("HolidayDataset", dataset);
    const incompleteId = randomUUID();
    await insert("HolidayDataset", { ...dataset, id: incompleteId, revision: randomUUID(), complete: false, completenessProof: [] });
    await expect(insert("HolidayYearCoverage", { country: "KR", year: 2026, datasetId: incompleteId })).rejects.toThrow();
    await insert("HolidayYearCoverage", { country: "KR", year: 2026, datasetId: dataset.id });
    await expect(insert("HolidayYearCoverage", { country: "KR", year: 2027, datasetId: dataset.id })).rejects.toThrow();
    await expect(execute('UPDATE "HolidayYearCoverage" SET "datasetId"=$1 WHERE year=2026', randomUUID())).rejects.toThrow();
    expect(await rows('SELECT "datasetId" FROM "HolidayYearCoverage" WHERE year=2026')).toEqual([{ datasetId: dataset.id }]);
    await expect(execute('UPDATE "HolidayDataset" SET dates=\'[]\',"payloadHash"=$2 WHERE id=$1', dataset.id, otherHash)).rejects.toThrow();
    await expect(execute('DELETE FROM "HolidayDataset" WHERE id=$1', dataset.id)).rejects.toThrow();
    const replacementId = randomUUID();
    await insert("HolidayDataset", { ...dataset, id: replacementId, revision: randomUUID() });
    await execute('UPDATE "HolidayYearCoverage" SET "datasetId"=$1 WHERE year=2026', replacementId);
    expect(await rows('SELECT "datasetId" FROM "HolidayYearCoverage" WHERE year=2026')).toEqual([{ datasetId: replacementId }]);
    expect(await rows('SELECT count(*)::int AS n FROM "HolidayDataset" WHERE id=$1', dataset.id)).toEqual([{ n: 1 }]);
  });

  it("preserves V2 SQL qualification and requires exact V3 capabilities instead of version alone", async () => {
    const h = await seed(db);
    const declaration = { gatewayId: h.gateway.id, siteId: h.site.id, assignmentVersion: 1, declarationRevision: 1n,
      declarationId: randomUUID(), maxSnapshotVersion: 2, payloadHash: hash, declaredAt: now };
    await insert("GatewayAutomationProtocolSupport", declaration);
    const blocked = async () => (await rows<{ reasons: string[] }>('SELECT bio_sensor_blocked_reasons($1,($2::timestamptz AT TIME ZONE \'UTC\')) AS reasons', h.fixture.id, now))[0].reasons;
    const v2 = await blocked(); expect(v2).not.toContain("gateway_protocol_unverified");
    await insert("GatewayAutomationProtocolSupport", { ...declaration, declarationId: randomUUID(), declarationRevision: 2n, maxSnapshotVersion: 3 });
    expect(await blocked()).toContain("gateway_protocol_unverified");
    await insert("GatewayAutomationProtocolSupport", { ...declaration, declarationId: randomUUID(), declarationRevision: 3n, maxSnapshotVersion: 3,
      temporaryControlVersion: 1, bioConfigurationReadback: true, durableFixtureLease: true });
    expect(await blocked()).toEqual(v2);
    await insert("GatewayAutomationProtocolSupport", { ...declaration, declarationId: randomUUID(), declarationRevision: 4n, maxSnapshotVersion: 3,
      temporaryControlVersion: 1, bioConfigurationReadback: false, durableFixtureLease: true });
    expect(await blocked()).toContain("gateway_protocol_unverified");
    await expect(insert("GatewayAutomationProtocolSupport", { ...declaration, declarationId: randomUUID(), declarationRevision: 5n, maxSnapshotVersion: 4 })).rejects.toThrow();
  });
});

async function seed(db: PrismaClient) {
  const organization = await db.organization.create({ data: { name: "self-owned BIO persistence fixture" } });
  const actor = await db.user.create({ data: { organizationId: organization.id, loginId: randomUUID(), name: "actor", passwordHash: "fixture", role: "admin" } });
  const site = await db.site.create({ data: { organizationId: organization.id, adminUserId: actor.id, name: "fixture" } });
  const floor = await db.floor.create({ data: { siteId: site.id, name: "fixture", level: 1 } });
  const gateway = await db.gateway.create({ data: { siteId: site.id, name: "fixture", serialNumber: randomUUID(), firmwareVersion: "fixture", claimedAt: now, assignmentVersion: 1 } });
  const nativeUuid = randomUUID().replace(/-/g, "").slice(0, 12);
  const node = await db.meshNode.create({ data: { gatewayId: gateway.id, deviceUuid: `bio:${nativeUuid}`, meshAddress: "0x0100", firmwareVersion: "fixture", vehicleSensorProtocol: "bio_usb_pulse" } });
  await db.meshNode.create({ data: { gatewayId: gateway.id, deviceUuid: randomUUID().replace(/-/g, ""), meshAddress: "0x0101", firmwareVersion: "native" } });
  const fixture = await db.fixture.create({ data: { floorId: floor.id, siteId: site.id, gatewayId: gateway.id, meshNodeId: node.id, name: "fixture", ratedWatt: 20, x: 0, y: 0, brightness: 37, bioConfiguredBrightness: 74 } });
  const inventory = await db.gatewayInventory.create({ data: { serialNumber: gateway.serialNumber, claimedGatewayId: gateway.id, claimedAt: now } });
  await db.gatewayCertificate.create({ data: { inventoryId: inventory.id, gatewayId: gateway.id, purpose: "mqtt", status: "active",
    certificateSerial: randomUUID(), fingerprint: randomUUID(), issuer: "fixture", notBefore: new Date(now.getTime() - 60_000), notAfter: new Date(now.getTime() + 60_000) } });
  return { actor, site, floor, gateway, node, nativeUuid, fixture };
}
