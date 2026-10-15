import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { SiteAccessService } from "../access/site-access.service";
import { AutomationSnapshotService } from "../automation/automation-snapshot.service";
import { TargetSnapshotService } from "../automation/target-snapshot.service";
import { canonicalPayloadHash } from "../automation/automation-payload-hash";
import { AutomationMqttConsumerService } from "../automation/automation-mqtt-consumer.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { Test } from "@nestjs/testing";
import { AuthService } from "../auth/auth.service";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { TemporaryControlsController } from "./temporary-controls.controller";
import { TemporaryControlsService } from "./temporary-controls.service";
import { MqttService } from "../mqtt/mqtt.service";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandDbClockHealth } from "../mqtt/command-db-clock-health.service";
import { createConfiguredCommandDbClockEvidenceSource, UnixCommandDbClockEvidenceSource } from "../mqtt/command-db-clock-evidence-source";

describe("temporary sessions on self-owned PostgreSQL", () => {
  jest.setTimeout(60_000);
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;
  beforeAll(async () => {
    cluster = await disposablePostgres(); const url = cluster.database();
    const deployed = cluster.deploy(url);
    if (deployed.status !== 0) throw new Error(deployed.stderr + deployed.stdout);
    db = new PrismaClient({ datasourceUrl: url });
  });
  afterAll(async () => { try { await db?.$disconnect(); } finally { cluster?.stop(); } });
  beforeEach(async () => { await db.temporaryControlOutbox.updateMany({ where: { completedAt: null }, data: { nextAttemptAt: new Date(Date.now()+3_600_000) } }); });
  async function configure(siteId: string, gatewayId: string, at?: Date) {
    const clock = { now: () => at ?? new Date() }; const snapshots = new AutomationSnapshotService(clock);
    const config = await db.$transaction(async tx => { await snapshots.lockMutation(tx); return snapshots.incrementDesiredRevision(tx, gatewayId); });
    const outbox = await db.mqttOutbox.findFirstOrThrow({ where: { gatewayId, revision: config.desiredRevision, applicationAckKey: null } });
    await new AutomationMqttConsumerService(db as never, {} as never, clock, snapshots).onConfigApplied({ siteId, gatewayId }, {
      schemaVersion: 3, siteId, gatewayId, acknowledgementId: randomUUID(), acknowledgement: { schemaVersion: 3, gatewayId,
        revision: config.desiredRevision, payloadHash: outbox.payloadHash, status: "applied", appliedAt: clock.now().toISOString(), errorCode: null }
    });
    return { revision: config.desiredRevision, hash: outbox.payloadHash };
  }
  function service(at?: Date) {
    const { TemporaryControlsService, temporaryControlNow } = require("./temporary-controls.service");
    return new TemporaryControlsService(db, new SiteAccessService(db as never),
      new AutomationSnapshotService({ now: () => at ?? new Date() }), new TargetSnapshotService(), { assertHealthy: at ? async () => at : temporaryControlNow });
  }
  async function harness(at?: Date) {
    const now = at ?? new Date();
    const organization = await db.organization.create({ data: { name: "temporary local fixture", type: "customer" } });
    const user = await db.user.create({ data: { organizationId: organization.id, loginId: randomUUID(), name: "actor", passwordHash: "unused", role: "admin" } });
    const actor: AuthenticatedUser = { ...user, organizationType: "customer", mustChangePassword: false };
    const site = await db.site.create({ data: { organizationId: organization.id, adminUserId: user.id, name: "temporary" } });
    const floor = await db.floor.create({ data: { siteId: site.id, name: "temporary", level: 1 } });
    const gateway = await db.gateway.create({ data: { siteId: site.id, name: "temporary", serialNumber: randomUUID(), firmwareVersion: "fixture", lastHeartbeatAt: now, assignmentVersion: 1 } });
    const node = await db.meshNode.create({ data: { gatewayId: gateway.id, deviceUuid: `bio:${randomUUID().replace(/-/g, "").slice(0,12)}`, meshAddress: "0x0100", firmwareVersion: "fixture", vehicleSensorProtocol: "bio_usb_pulse" } });
    const fixture = await db.fixture.create({ data: { floorId: floor.id, siteId: site.id, gatewayId: gateway.id, meshNodeId: node.id, name: "temporary", ratedWatt: 20, x: 0, y: 0, brightness: 37, bioConfiguredBrightness: 74 } });
    const inventory = await db.gatewayInventory.create({ data: { serialNumber: gateway.serialNumber, claimedGatewayId: gateway.id, claimedAt: now } });
    await db.gatewayCertificate.create({ data: { inventoryId: inventory.id, gatewayId: gateway.id, purpose: "mqtt", status: "active", certificateSerial: randomUUID(), fingerprint: randomUUID(), issuer: "fixture", notBefore: new Date(now.getTime()-60_000), notAfter: new Date(now.getTime()+365*86_400_000) } });
    await db.gatewayAutomationProtocolSupport.create({ data: { siteId: site.id, gatewayId: gateway.id, assignmentVersion: 1, declarationRevision: 1n,
      declarationId: randomUUID(), maxSnapshotVersion: 3, temporaryControlVersion: 1, bioConfigurationReadback: true, durableFixtureLease: true,
      payloadHash: `sha256:${"a".repeat(64)}`, declaredAt: now } });
    await configure(site.id, gateway.id, at);
    const input = { clientRequestId: randomUUID(), target: { type: "fixture", fixtureId: fixture.id }, brightness: 70, durationMinutes: 1 };
    const api = service(at);
    return { api, actor, site, gateway, fixture, node, input, configure: () => configure(site.id, gateway.id),
      start: (patch = {}) => api.start(site.id, actor, { ...input, ...patch }),
      end: (id: string) => api.end(site.id, id, actor, { clientRequestId: randomUUID() }) };
  }
  async function report(h: Awaited<ReturnType<typeof harness>>, id: string, patch: Record<string, unknown> = {}) {
    const session = await db.temporaryControlSession.findUniqueOrThrow({ where: { id } });
    const body = { schemaVersion: 1, sessionId: id, siteId: h.site.id, gatewayId: h.gateway.id, assignmentVersion: 1,
      admissionRevision: session.admissionRevision, originCommandHash: session.originCommandHash, originSequence: Number(session.originSequence),
      eventId: randomUUID(), fixtureId: h.fixture.id, sessionRevision: 1, targetGeneration: "1", kind: "apply", applyConfirmed: false,
      releaseConfirmed: false, configurationMayHaveChanged: false, partialMutation: "none", configurationReadback: null,
      rfWriteEvidence: "not_started", reason: null, restorationRevision: null, restorationPayloadHash: null, observedAt: new Date().toISOString(), ...patch };
    return { ...body, resultHash: canonicalPayloadHash(body) };
  }
  it("reserves exact generations, server UTC deadline, immutable admission and idempotent replay atomically", async () => {
    const h = await harness(); const first = await h.start();
    expect(first).toMatchObject({ state: "pending", sessionRevision: 1, brightness: 70, targets: [{ fixtureId: h.fixture.id, applyGeneration: "1", releaseGeneration: "2" }] });
    expect(Date.parse(first.endsAt)-Date.parse(first.startedAt)).toBe(60_000);
    expect(Math.abs(Date.now()-Date.parse(first.now))).toBeLessThan(2000);
    expect((await h.start()).id).toBe(first.id);
    await expect(h.start({ brightness: 71 })).rejects.toMatchObject({ status: 409 });
    const rows = await db.temporaryControlOutbox.findMany({ where: { sessionId: first.id } });
    expect(rows).toHaveLength(1);
    const { payloadHash, ...body } = rows[0].payload as Record<string, unknown>;
    expect(canonicalPayloadHash(body)).toBe(payloadHash);
    expect(await db.temporaryControlLease.findUnique({ where: { fixtureId: h.fixture.id } })).toMatchObject({ ownerSessionId: first.id, lastGeneration: 2n });
    expect(await db.manualOverride.count({ where: { siteId: h.site.id } })).toBe(0);
    await expect(h.start({ clientRequestId: randomUUID() })).rejects.toMatchObject({ status: 409 });
    expect(await db.temporaryControlSession.count({ where: { siteId: h.site.id } })).toBe(1);
  });
  it("accepts HTTP start/end in real transactions and persists an MQTT result before its ACK outbox", async () => {
    const h = await harness();
    const module = await Test.createTestingModule({ controllers: [TemporaryControlsController], providers: [SessionAuthGuard,
      { provide: TemporaryControlsService, useValue: h.api }, { provide: AuthService, useValue: { getUserBySessionToken: async () => h.actor } }] }).compile();
    const app = module.createNestApplication();
    try {
      await app.listen(0, "127.0.0.1"); const base = `${await app.getUrl()}/sites/${h.site.id}/temporary-controls`;
      const headers = { cookie: `${AuthService.sessionCookieName}=fixture`, "Content-Type": "application/json" };
      const started = await fetch(base, { method: "POST", headers, body: JSON.stringify(h.input) });
      expect(started.status).toBe(202); const first = await started.json() as { id: string; state: string }; expect(first.state).toBe("pending");
      const ended = await fetch(`${base}/${first.id}/end`, { method: "POST", headers, body: JSON.stringify({ clientRequestId: randomUUID() }) });
      expect(ended.status).toBe(202);
      const result = await report(h, first.id, { kind: "release", sessionRevision: 2, targetGeneration: "2" });
      await new MqttService(db as never, {} as never).handleMessage(`sites/${h.site.id}/gateways/${h.gateway.id}/temporary-control/result`, Buffer.from(JSON.stringify(result)));
      expect(await db.temporaryControlResultReceipt.findUnique({ where: { eventId: result.eventId } })).toMatchObject({ status: "applied" });
      expect(await db.temporaryControlOutbox.findUnique({ where: { deduplicationKey: `ingested:${result.eventId}` } })).toMatchObject({ kind: "ingested", publishedAt: null, payload: { status: "applied" } });
      const get = await fetch(`${base}/${first.id}`, { headers }); expect(get.headers.get("cache-control")).toBe("private, no-store");
      expect(await get.json()).toMatchObject({ state: "cancelled" });
    } finally { await app.close(); }
  });
  it("reauthorizes read-only membership, validates inputs and scopes list cursors to the site", async () => {
    const h = await harness(); const user = await db.user.create({ data: { organizationId: h.actor.organizationId, role: "viewer", loginId: randomUUID(), name: "reader", passwordHash: "unused" } });
    const actor = { ...h.actor, ...user };
    await db.siteMembership.create({ data: { userId: user.id, siteId: h.site.id, accessLevel: "read" } });
    await expect(h.api.start(h.site.id, actor, h.input)).rejects.toMatchObject({ status: 403 });
    await expect(h.start({ brightness: 101 })).rejects.toMatchObject({ status: 400 });
    await expect(h.api.list(h.site.id, actor, { limit: 101 })).rejects.toMatchObject({ status: 400 });
    const first = await h.start();
    expect(await h.api.list(h.site.id, actor, { limit: 1 })).toMatchObject({ items: [{ id: first.id }], nextCursor: null });
    await db.siteMembership.deleteMany({ where: { siteId: h.site.id, userId: user.id } });
    await expect(h.api.get(h.site.id, first.id, actor)).rejects.toMatchObject({ status: 404 });
  });
  it("rejects a new start without current applied V3 configuration or trusted clock, while replay remains available", async () => {
    const h = await harness();
    const snapshots = new AutomationSnapshotService({ now: () => new Date() });
    await db.$transaction(async tx => { await snapshots.lockMutation(tx); await snapshots.incrementDesiredRevision(tx, h.gateway.id); });
    await expect(h.start()).rejects.toMatchObject({ status: 409 });
    await h.configure();
    const { TemporaryControlsService } = require("./temporary-controls.service");
    const unavailable = new TemporaryControlsService(db, new SiteAccessService(db as never), new AutomationSnapshotService({ now: () => new Date() }), new TargetSnapshotService());
    await expect(unavailable.start(h.site.id, h.actor, h.input)).rejects.toMatchObject({ status: 503 });
    const first = await h.start();
    expect(await unavailable.start(h.site.id, h.actor, h.input)).toMatchObject({ id: first.id });
    expect(await unavailable.end(h.site.id, first.id, h.actor, { clientRequestId: randomUUID() })).toMatchObject({ state: "releasing" });
  });
  it("records end intent before end delivery and reuses the reserved release generation", async () => {
    const h = await harness(); const first = await h.start(); await h.end(first.id); await h.end(first.id);
    expect(await db.temporaryControlSession.findUnique({ where: { id: first.id } })).toMatchObject({ sessionRevision: 2, state: "releasing", releaseIntentAt: expect.any(Date) });
    const rows = await db.temporaryControlOutbox.findMany({ where: { sessionId: first.id, kind: "end" } });
    expect(rows).toHaveLength(1);
    expect(rows[0].payload).toMatchObject({ kind: "end", sessionRevision: 2, targets: [{ releaseGeneration: "2" }], originCommandHash: expect.any(String) });
    expect(await db.temporaryControlLease.findUnique({ where: { fixtureId: h.fixture.id } })).toMatchObject({ ownerSessionId: first.id, lastGeneration: 2n });
    const { TemporaryControlPublisher } = require("./temporary-control-publisher"); const published: any[] = [];
    await new TemporaryControlPublisher(db, { publishTopic: async (_topic: string, payload: unknown) => { published.push(payload); } },
      { assertHealthy: async () => { throw new Error("must not apply after end"); } }).processBatch();
    expect(published.filter(p => p.sessionId === first.id).map(p => p.kind)).toEqual(["end"]);
  });
  it("reauthorizes persisted control and rejects another site's identity", async () => {
    const h = await harness();
    await db.site.update({ where: { id: h.site.id }, data: { adminUserId: null } });
    await expect(h.start()).rejects.toMatchObject({ status: 404 });
    expect(await db.temporaryControlSession.count({ where: { siteId: h.site.id } })).toBe(0);
  });
  it("rolls back release evidence and owner resolution when durable ACK persistence fails", async () => {
    const h = await harness(); const first = await h.start(); await h.end(first.id);
    const result = await report(h, first.id, { sessionRevision: 2, targetGeneration: "2", kind: "release" });
    const { TemporaryControlResults } = require("./temporary-control-results");
    const failing = new TemporaryControlResults({ $transaction: (work: (tx: unknown) => Promise<unknown>) => db.$transaction(tx => work({ ...tx,
      temporaryControlOutbox: { ...tx.temporaryControlOutbox, upsert: async () => { throw new Error("fixture ACK write failed"); } } })) });
    await expect(failing.ingestTemporaryControlResult({ siteId: h.site.id, gatewayId: h.gateway.id }, result)).rejects.toThrow("fixture ACK write failed");
    expect(await db.temporaryControlResultReceipt.findUnique({ where: { eventId: result.eventId } })).toBeNull();
    expect(await db.temporaryControlLease.findUnique({ where: { fixtureId: h.fixture.id } })).toMatchObject({ ownerSessionId: first.id });
    expect(await db.temporaryControlTarget.findFirst({ where: { sessionId: first.id } })).toMatchObject({ resolvedAt: null });
  });
  it("keeps partial mutations owned until exact latest restoration and ignores old release against a new owner", async () => {
    const h = await harness(); const first = await h.start();
    const { TemporaryControlResults } = require("./temporary-control-results");
    const consumer = new TemporaryControlResults(db);
    const row = await db.temporaryControlSession.findUniqueOrThrow({ where: { id: first.id } });
    const raw = { schemaVersion: 1, sessionId: first.id, siteId: h.site.id, gatewayId: h.gateway.id,
      assignmentVersion: 1, admissionRevision: row.admissionRevision, originCommandHash: row.originCommandHash, originSequence: Number(row.originSequence),
      eventId: randomUUID(), sessionRevision: 1, kind: "apply", fixtureId: h.fixture.id, targetGeneration: "1",
      applyConfirmed: false, releaseConfirmed: false, configurationMayHaveChanged: true, partialMutation: "high_brightness",
      configurationReadback: null, rfWriteEvidence: "may_have_written", reason: "mode_write_failed", restorationRevision: null,
      restorationPayloadHash: null, observedAt: new Date().toISOString() };
    const send = (body: Record<string, unknown>) => consumer.ingestTemporaryControlResult({ siteId: h.site.id, gatewayId: h.gateway.id }, { ...body, resultHash: canonicalPayloadHash(body) });
    expect(await send(raw)).toMatchObject({ status: "applied" });
    expect(await h.api.get(h.site.id, first.id, h.actor)).toMatchObject({ state: "partial" });
    await h.end(first.id);
    const noRf = { ...raw, eventId: randomUUID(), sessionRevision: 2, kind: "release", targetGeneration: "2", configurationMayHaveChanged: false,
      partialMutation: "none", rfWriteEvidence: "not_started", reason: null, observedAt: new Date().toISOString() };
    await send(noRf);
    expect(await db.temporaryControlLease.findUnique({ where: { fixtureId: h.fixture.id } })).toMatchObject({ ownerSessionId: first.id });
    const { hash } = await h.configure();
    const release = { ...raw, eventId: randomUUID(), sessionRevision: 2, kind: "release", targetGeneration: "2", releaseConfirmed: true,
      partialMutation: "none", rfWriteEvidence: "observed", reason: null, configurationReadback: { configuredHighBrightnessPercent: 74, bioMode: "sensor" },
      restorationRevision: 2, restorationPayloadHash: hash, observedAt: new Date().toISOString() };
    await send({ ...release, eventId: randomUUID(), restorationPayloadHash: `sha256:${"c".repeat(64)}` });
    expect(await db.temporaryControlLease.findUnique({ where: { fixtureId: h.fixture.id } })).toMatchObject({ ownerSessionId: first.id });
    expect(await send(release)).toMatchObject({ status: "applied" });
    expect(await h.api.get(h.site.id, first.id, h.actor)).toMatchObject({ state: "restored" });
    const next = await h.start({ clientRequestId: randomUUID() });
    expect(await send(release)).toMatchObject({ status: "applied" });
    expect(await send({ ...release, eventId: randomUUID() })).toMatchObject({ status: "rejected" });
    expect(await db.temporaryControlLease.findUnique({ where: { fixtureId: h.fixture.id } })).toMatchObject({ ownerSessionId: next.id, lastGeneration: 4n });
    expect(await db.fixture.findUnique({ where: { id: h.fixture.id } })).toMatchObject({ brightness: 37, bioConfiguredBrightness: 74 });
  });
  it("refuses non-BIO and missing V3 durable/readback authority", async () => {
    const h = await harness();
    await db.gatewayAutomationProtocolSupport.updateMany({ where: { gatewayId: h.gateway.id }, data: { durableFixtureLease: false } });
    await expect(h.start()).rejects.toMatchObject({ status: 409 });
    const nonBio = await harness();
    await db.meshNode.update({ where: { id: nonBio.node.id }, data: { vehicleSensorProtocol: "bluez_stateful" } });
    await expect(nonBio.start()).rejects.toMatchObject({ status: 409 });
  });
  it.each(["apply", "release"])("treats equivalent ISO instants conservatively for %s confirmation", async kind => {
    const h = await harness(); const first = await h.start();
    if (kind === "release") await h.end(first.id);
    const { TemporaryControlResults } = require("./temporary-control-results"); const consumer = new TemporaryControlResults(db);
    const config = await db.gatewayAutomationConfiguration.findUniqueOrThrow({ where: { gatewayId: h.gateway.id } });
    const instant = new Date(Math.ceil(Date.now()/1000)*1000).toISOString();
    const revision = kind === "apply" ? {} : { kind, sessionRevision: 2, targetGeneration: "2" };
    const uncertain = await report(h, first.id, { ...revision, configurationMayHaveChanged: true, rfWriteEvidence: "may_have_written", observedAt: instant.replace(".000Z", "Z") });
    const confirmed = await report(h, first.id, { ...revision, configurationMayHaveChanged: true, rfWriteEvidence: "observed", observedAt: instant,
      applyConfirmed: kind === "apply", releaseConfirmed: kind === "release",
      configurationReadback: { configuredHighBrightnessPercent: 70, bioMode: "force-on" },
      ...(kind === "release" ? { restorationRevision: config.desiredRevision, restorationPayloadHash: config.payloadHash } : {}) });
    for (const result of [uncertain, confirmed]) expect(await consumer.ingestTemporaryControlResult({ siteId: h.site.id, gatewayId: h.gateway.id }, result)).toMatchObject({ status: "applied" });
    expect(await db.temporaryControlTarget.findFirst({ where: { sessionId: first.id } })).toMatchObject({ applyConfirmed: false, releaseConfirmed: false, resolvedAt: null });
    expect(await db.temporaryControlLease.findUnique({ where: { fixtureId: h.fixture.id } })).toMatchObject({ ownerSessionId: first.id });
    expect(await h.api.get(h.site.id, first.id, h.actor)).toMatchObject({ state: kind === "apply" ? "unknown" : "recovery_pending" });
  });
  it.each(["apply_readback_mismatch", "stale_restoration", "restoration_configuration_pending"])("retains identity-trusted mutation after %s and later RF0", async rejection => {
    const h = await harness(); const first = await h.start();
    const { TemporaryControlResults } = require("./temporary-control-results"); const consumer = new TemporaryControlResults(db);
    const config = await db.gatewayAutomationConfiguration.findUniqueOrThrow({ where: { gatewayId: h.gateway.id } });
    if (rejection !== "apply_readback_mismatch") await h.end(first.id);
    if (rejection === "restoration_configuration_pending") {
      const snapshots = new AutomationSnapshotService({ now: () => new Date() });
      await db.$transaction(async tx => { await snapshots.lockMutation(tx); await snapshots.incrementDesiredRevision(tx, h.gateway.id); });
    }
    const mutation = await report(h, first.id, { configurationMayHaveChanged: true, rfWriteEvidence: "observed",
      configurationReadback: { configuredHighBrightnessPercent: 69, bioMode: "force-on" },
      ...(rejection === "apply_readback_mismatch" ? { applyConfirmed: true } : { kind: "release", sessionRevision: 2, targetGeneration: "2", releaseConfirmed: true,
        restorationRevision: config.desiredRevision, restorationPayloadHash: rejection === "stale_restoration" ? `sha256:${"c".repeat(64)}` : config.payloadHash }) });
    const scope = { siteId: h.site.id, gatewayId: h.gateway.id };
    const ack = await consumer.ingestTemporaryControlResult(scope, mutation);
    expect(ack).toMatchObject({ status: "rejected", reason: rejection, resultHash: mutation.resultHash });
    const receipt = await db.temporaryControlResultReceipt.findUniqueOrThrow({ where: { eventId: mutation.eventId } });
    await h.end(first.id);
    await consumer.ingestTemporaryControlResult(scope, await report(h, first.id, { kind: "release", sessionRevision: 2, targetGeneration: "2" }));
    expect(await db.temporaryControlTarget.findFirst({ where: { sessionId: first.id } })).toMatchObject({ configurationMayHaveChanged: true, unchangedConfirmed: false, resolvedAt: null });
    expect(await db.temporaryControlLease.findUnique({ where: { fixtureId: h.fixture.id } })).toMatchObject({ ownerSessionId: first.id });
    expect(await h.api.get(h.site.id, first.id, h.actor)).toMatchObject({ state: "recovery_pending" });
    expect(await consumer.ingestTemporaryControlResult(scope, mutation)).toEqual(ack);
    expect(await db.temporaryControlResultReceipt.findUnique({ where: { eventId: mutation.eventId } })).toEqual(receipt);
    expect(await db.temporaryControlOutbox.findUnique({ where: { deduplicationKey: `ingested:${mutation.eventId}` } })).toMatchObject({ payload: ack });
  });
  it("rejects multi-Gateway and pending/unknown permanent command overlap without reserving anything", async () => {
    const h = await harness();
    const other = await db.gateway.create({ data: { siteId: h.site.id, name: "other", serialNumber: randomUUID(), firmwareVersion: "fixture" } });
    const node = await db.meshNode.create({ data: { gatewayId: other.id, deviceUuid: `bio:${randomUUID().replace(/-/g, "").slice(0,12)}`, meshAddress: "0x0100", firmwareVersion: "fixture", vehicleSensorProtocol: "bio_usb_pulse" } });
    const fixture = await db.fixture.create({ data: { siteId: h.site.id, floorId: h.fixture.floorId, gatewayId: other.id, meshNodeId: node.id, name: "other", ratedWatt: 20, x: 1, y: 1 } });
    await expect(h.start({ target: { type: "fixtures", fixtureIds: [h.fixture.id, fixture.id] } })).rejects.toMatchObject({ status: 409 });
    await db.command.create({ data: { siteId: h.site.id, requestedBy: h.actor.id, clientRequestId: randomUUID(), requestFingerprint: "fixture-fingerprint", targetType: "fixture", targetId: h.fixture.id, targetFixtureIds: [h.fixture.id], brightness: 30, outcome: "unknown" } });
    await expect(h.start()).rejects.toMatchObject({ status: 409 });
    expect(await db.temporaryControlLease.count({ where: { siteId: h.site.id } })).toBe(0);
  });
  it("promotes holiday pointer and actual V3 outbox atomically and rolls both back on a failed hook", async () => {
    const h = await harness(); const year = 2026;
    await db.$transaction(async tx => {
      const schedule = await tx.lightingSchedule.create({ data: { siteId: h.site.id, gatewayId: h.gateway.id, name: "holiday", status: "enabled",
        activeFrom: new Date(`${year}-01-01Z`), activeUntil: new Date(`${year}-12-31Z`), localStartTime: "08:00", localEndTime: "09:00", recurrenceKind: "daily",
        dimmingEnabled: true, brightnessPercent: 70, excludeHolidays: true, createdById: h.actor.id, updatedById: h.actor.id } });
      await tx.lightingScheduleFixture.create({ data: { scheduleId: schedule.id, fixtureId: h.fixture.id, siteId: h.site.id, gatewayId: h.gateway.id } });
    });
    const { HolidayDatasetService } = require("../automation/holiday-dataset.service");
    const snapshots = new AutomationSnapshotService({ now: () => new Date() });
    const provider = { fetchMonth: async (input: { year: number; month: number; page: number }) => ({ ...input, numOfRows: 100, totalCount: 0, items: [] }) };
    const before = await db.gatewayAutomationConfiguration.findUniqueOrThrow({ where: { gatewayId: h.gateway.id } });
    const broken = new HolidayDatasetService(db, { now: () => new Date() }, snapshots, provider,
      { onPromoted: async (tx: any, dataset: any) => { await snapshots.onPromoted(tx, dataset); throw new Error("fixture rollback"); } });
    expect(await broken.refreshYear(year)).toMatchObject({ status: "failed" }); await broken.onModuleDestroy();
    expect(await db.gatewayAutomationConfiguration.findUnique({ where: { gatewayId: h.gateway.id } })).toEqual(before);
    expect(await db.holidayYearCoverage.findUnique({ where: { country_year: { country: "KR", year } } })).toBeNull();
    const working = new HolidayDatasetService(db, { now: () => new Date() }, snapshots, provider, snapshots);
    expect(await working.refreshYear(year)).toMatchObject({ status: "promoted" }); await working.onModuleDestroy();
    expect(await db.gatewayAutomationConfiguration.findUnique({ where: { gatewayId: h.gateway.id } })).toMatchObject({ desiredRevision: before.desiredRevision+1, syncStatus: "PENDING" });
    const outbox = await db.mqttOutbox.findFirstOrThrow({ where: { gatewayId: h.gateway.id, revision: before.desiredRevision+1, applicationAckKey: null } });
    expect(outbox.payload).toMatchObject({ schemaVersion: 3, schedules: [{ excludeHolidays: true }], holidayDatasets: [{ year, dates: [] }] });
  });
  it("fences two publishers, treats PUBACK as transport only and keeps recovery after a terminal delivery batch", async () => {
    const h = await harness(); const first = await h.start();
    const { TemporaryControlPublisher } = require("./temporary-control-publisher");
    const { temporaryControlNow } = require("./temporary-controls.service");
    const published: any[] = [];
    const mqtt = { publishTopic: async (topic: string, payload: unknown) => { published.push({ topic, payload }); } };
    const a = new TemporaryControlPublisher(db, mqtt, { assertHealthy: temporaryControlNow });
    const b = new TemporaryControlPublisher(db, mqtt, { assertHealthy: temporaryControlNow });
    const [one, two] = await Promise.all([a.claimBatch(), b.claimBatch()]);
    expect(one.length + two.length).toBe(1);
    await (one.length ? a : b).publishClaimed((one.length ? one : two)[0]);
    expect(published).toHaveLength(1);
    expect(published[0].topic).toBe(`sites/${h.site.id}/gateways/${h.gateway.id}/temporary-control/command`);
    expect(published[0].payload).toMatchObject({ kind: "start", deliveryGeneration: expect.any(String), deliveryWindowMs: 10000, deliveryPayloadHash: expect.any(String) });
    expect(await h.api.get(h.site.id, first.id, h.actor)).toMatchObject({ state: "applying", results: [] });
    expect(await db.temporaryControlTarget.findFirst({ where: { sessionId: first.id } })).toMatchObject({ applyConfirmed: false });
    await h.end(first.id);
    await db.temporaryControlOutbox.updateMany({ where: { sessionId: first.id, kind: "end" }, data: { attempts: 9 } });
    const failing = new TemporaryControlPublisher(db, { publishTopic: async () => { throw new Error("mock offline"); } }, { assertHealthy: temporaryControlNow });
    await failing.processBatch();
    expect(await db.temporaryControlOutbox.count({ where: { sessionId: first.id, kind: "end", completedAt: null } })).toBe(1);
    expect(await db.temporaryControlOutbox.count({ where: { sessionId: first.id, kind: "end", completedAt: { not: null } } })).toBe(1);
    expect(await db.temporaryControlLease.findUnique({ where: { fixtureId: h.fixture.id } })).toMatchObject({ ownerSessionId: first.id });
  });
  it("rejects a late publisher completion after its lease token was replaced", async () => {
    const h = await harness(); const first = await h.start();
    const { TemporaryControlPublisher } = require("./temporary-control-publisher"); const { temporaryControlNow } = require("./temporary-controls.service");
    let entered!: () => void; let finish!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }); const pending = new Promise<void>(resolve => { finish = resolve; });
    const worker = new TemporaryControlPublisher(db, { publishTopic: () => { entered(); return pending; } }, { assertHealthy: temporaryControlNow });
    const claimed = await worker.claimBatch(); const record = claimed.find((r: any) => r.sessionId === first.id);
    const publishing = worker.publishClaimed(record); await started;
    await db.temporaryControlOutbox.update({ where: { id: record.id }, data: { leaseToken: "successor" } });
    finish(); await publishing;
    expect(await db.temporaryControlOutbox.findUnique({ where: { id: record.id } })).toMatchObject({ leaseToken: "successor", publishedAt: null });
    await db.temporaryControlOutbox.update({ where: { id: record.id }, data: { leaseToken: null, leaseUntil: null, nextAttemptAt: new Date(Date.now()+60_000) } });
  });
  it("retains RF0 targets in a mixed session until release revision can be acknowledged", async () => {
    const h = await harness();
    const node = await db.meshNode.create({ data: { gatewayId: h.gateway.id, deviceUuid: `bio:${randomUUID().replace(/-/g, "").slice(0,12)}`, meshAddress: "0x0101", firmwareVersion: "fixture", vehicleSensorProtocol: "bio_usb_pulse" } });
    const second = await db.fixture.create({ data: { siteId: h.site.id, floorId: h.fixture.floorId, gatewayId: h.gateway.id, meshNodeId: node.id, name: "second", ratedWatt: 20, x: 1, y: 1 } });
    const first = await h.start({ target: { type: "fixtures", fixtureIds: [h.fixture.id, second.id] } });
    const { TemporaryControlResults } = require("./temporary-control-results"); const consumer = new TemporaryControlResults(db);
    await consumer.ingestTemporaryControlResult({ siteId: h.site.id, gatewayId: h.gateway.id }, await report(h, first.id));
    expect(await db.temporaryControlLease.findUnique({ where: { fixtureId: h.fixture.id } })).toMatchObject({ ownerSessionId: first.id });
    await h.end(first.id);
    const released = await report(h, first.id, { sessionRevision: 2, targetGeneration: "2", kind: "release" });
    expect(await consumer.ingestTemporaryControlResult({ siteId: h.site.id, gatewayId: h.gateway.id }, released)).toMatchObject({ status: "applied" });
  });
  it("redacted_replay_and_late_release_never_unlock_new_owner", async () => {
    const at = new Date("2026-01-31T12:00:00Z"); const h = await harness(at); const first = await h.start(); await h.end(first.id);
    const { TemporaryControlResults } = require("./temporary-control-results"); const consumer = new TemporaryControlResults(db);
    const clock = jest.spyOn(require("./temporary-controls.service"), "temporaryControlNow").mockResolvedValue(new Date(at.getTime()+1000));
    const config = await db.gatewayAutomationConfiguration.findUniqueOrThrow({ where: { gatewayId: h.gateway.id } });
    const release = await report(h, first.id, { kind: "release", sessionRevision: 2, targetGeneration: "2", releaseConfirmed: true,
      configurationMayHaveChanged: true, rfWriteEvidence: "observed", configurationReadback: { configuredHighBrightnessPercent: 74, bioMode: "sensor" },
      restorationRevision: config.desiredRevision, restorationPayloadHash: config.payloadHash, observedAt: new Date(at.getTime()+1000).toISOString() });
    try { await consumer.ingestTemporaryControlResult({ siteId: h.site.id, gatewayId: h.gateway.id }, release); } finally { clock.mockRestore(); }
    const fingerprint = await db.temporaryControlOperationReceipt.findFirst({ where: { sessionId: first.id, operation: "start" } });
    const oldFlag = process.env.COMMAND_DETAIL_REDACTION_ENABLED;
    const { TemporaryControlRetention } = require("./temporary-control-retention");
    try {
      process.env.COMMAND_DETAIL_REDACTION_ENABLED = "0"; expect(await new TemporaryControlRetention(db).runBatch()).toBe(0);
      process.env.COMMAND_DETAIL_REDACTION_ENABLED = "1"; expect(await new TemporaryControlRetention(db).runBatch()).toBe(1);
    } finally { if (oldFlag === undefined) delete process.env.COMMAND_DETAIL_REDACTION_ENABLED; else process.env.COMMAND_DETAIL_REDACTION_ENABLED = oldFlag; }
    const count = await db.temporaryControlOutbox.count({ where: { sessionId: first.id, kind: { in: ["start", "end"] } } });
    expect(await h.start()).toMatchObject({ id: first.id, state: "restored", detailsRedacted: true, brightness: null, targets: [], results: [] });
    expect(await db.temporaryControlOperationReceipt.findFirst({ where: { sessionId: first.id, operation: "start" } })).toEqual(fingerprint);
    expect(await db.temporaryControlOutbox.count({ where: { sessionId: first.id, kind: { in: ["start", "end"] } } })).toBe(count);
    const next = await h.start({ clientRequestId: randomUUID() });
    expect(await consumer.ingestTemporaryControlResult({ siteId: h.site.id, gatewayId: h.gateway.id }, release)).toMatchObject({ status: "applied" });
    expect(await db.temporaryControlLease.findUnique({ where: { fixtureId: h.fixture.id } })).toMatchObject({ ownerSessionId: next.id, lastGeneration: 4n });
  });
  it("rejects new HTTP mutations after control revocation but delivers the already accepted immutable start", async () => {
    const h = await harness();
    const user = await db.user.create({ data: { organizationId: h.actor.organizationId, role: "viewer", loginId: randomUUID(), name: "operator", passwordHash: "unused" } });
    const actor = { ...h.actor, ...user };
    const membership = await db.siteMembership.create({ data: { userId: user.id, siteId: h.site.id, accessLevel: "control" } });
    const first = await h.api.start(h.site.id, actor, h.input);
    await db.siteMembership.update({ where: { id: membership.id }, data: { accessLevel: "read" } });
    const module = await Test.createTestingModule({ controllers: [TemporaryControlsController], providers: [SessionAuthGuard,
      { provide: TemporaryControlsService, useValue: h.api }, { provide: AuthService, useValue: { getUserBySessionToken: async () => actor } }] }).compile();
    const app = module.createNestApplication();
    try {
      await app.listen(0, "127.0.0.1"); const base = `${await app.getUrl()}/sites/${h.site.id}/temporary-controls`;
      const headers = { cookie: `${AuthService.sessionCookieName}=fixture`, "Content-Type": "application/json" };
      expect((await fetch(base, { method: "POST", headers, body: JSON.stringify({ ...h.input, clientRequestId: randomUUID() }) })).status).toBe(403);
      expect((await fetch(`${base}/${first.id}/end`, { method: "POST", headers, body: JSON.stringify({ clientRequestId: randomUUID() }) })).status).toBe(403);
    } finally { await app.close(); }
    const { TemporaryControlPublisher } = require("./temporary-control-publisher");
    const { temporaryControlNow } = require("./temporary-controls.service"); const published: any[] = [];
    await new TemporaryControlPublisher(db, { publishTopic: async (_topic: string, payload: unknown) => { published.push(payload); } },
      { assertHealthy: temporaryControlNow }).processBatch();
    expect(published.filter(p => p.sessionId === first.id)).toEqual([expect.objectContaining({ kind: "start", endsAt: first.endsAt, brightness: 70 })]);
    expect(await db.temporaryControlSession.findUnique({ where: { id: first.id } })).toMatchObject({ releaseIntentAt: null, endsAt: new Date(first.endsAt) });
    expect(await h.end(first.id)).toMatchObject({ state: "releasing" });
  });
  it("makes a newly persisted release eligible at the same DB sample used by its claiming batch", async () => {
    const h = await harness(); const first = await h.start();
    const now = new Date(Date.parse(first.startedAt)+500);
    const { ensureTemporaryRelease } = require("./temporary-controls.service");
    await db.$transaction(async tx => {
      await tx.$executeRaw`SELECT "lock_automation_membership_mutation"()`;
      await ensureTemporaryRelease(tx, await tx.temporaryControlSession.findUniqueOrThrow({ where: { id: first.id } }), now);
    });
    expect(await db.temporaryControlOutbox.findUnique({ where: { deduplicationKey: `end:${first.id}` } })).toMatchObject({ nextAttemptAt: now });
  });
  it("continues accepted expiry recovery after actor revocation and unavailable clock attestation", async () => {
    const h = await harness(new Date(Date.now()-61_000)); const first = await h.start();
    await db.site.update({ where: { id: h.site.id }, data: { adminUserId: null } });
    await expect(h.start({ clientRequestId: randomUUID() })).rejects.toMatchObject({ status: 404 });
    const { TemporaryControlPublisher } = require("./temporary-control-publisher"); const published: any[] = [];
    const publisher = new TemporaryControlPublisher(db, { publishTopic: async (_topic: string, payload: unknown) => { published.push(payload); } },
      { assertHealthy: async () => { throw new Error("attestor unavailable"); } });
    await publisher.processBatch();
    expect(published.filter(p => p.sessionId === first.id).map(p => p.kind)).toEqual(["end"]);
    expect(await db.temporaryControlSession.findUnique({ where: { id: first.id } })).toMatchObject({ sessionRevision: 2, releaseIntentAt: expect.any(Date), terminalAt: null });
    expect(await db.temporaryControlLease.findUnique({ where: { fixtureId: h.fixture.id } })).toMatchObject({ ownerSessionId: first.id });
  });

  it("operational clock reader blocks new reservations while preserving replay, query, end and accepted expiry recovery", async () => {
    const directory = mkdtempSync(join(realpathSync(tmpdir()), "bio-clock-admission-"));
    try {
      expect(createConfiguredCommandDbClockEvidenceSource({ COMMAND_DB_CLOCK_SOCKET_PATH:
        "/Library/Application Support/Kinda/ClockAttestor/runtime/evidence.sock" })).toBeInstanceOf(UnixCommandDbClockEvidenceSource);
      // This deliberately absent self-owned endpoint exercises reader failure without
      // accessing an installed service or granting a test process protected ownership.
      const health = new CommandDbClockHealth(new UnixCommandDbClockEvidenceSource(join(directory, "runtime/evidence.sock")));
      const h = await harness();
      const api = new TemporaryControlsService(db as never, new SiteAccessService(db as never),
        new AutomationSnapshotService({ now: () => new Date() }), new TargetSnapshotService(), health);
      await expect(api.start(h.site.id, h.actor, h.input as never)).rejects.toMatchObject({ status: 503 });
      expect(await db.temporaryControlSession.count({ where: { siteId: h.site.id } })).toBe(0);
      expect(await db.temporaryControlOutbox.count({ where: { siteId: h.site.id } })).toBe(0);
      expect(await db.temporaryControlLease.count({ where: { fixtureId: h.fixture.id } })).toBe(0);
      const first = await h.start();
      expect(await api.start(h.site.id, h.actor, h.input as never)).toMatchObject({ id: first.id });
      expect(await api.get(h.site.id, first.id, h.actor)).toMatchObject({ id: first.id });
      expect(await api.end(h.site.id, first.id, h.actor, { clientRequestId: randomUUID() })).toMatchObject({ state: "releasing" });
      const expired = await harness(new Date(Date.now() - 61_000)); const accepted = await expired.start();
      const { TemporaryControlPublisher } = require("./temporary-control-publisher"); const published: any[] = [];
      await new TemporaryControlPublisher(db, { publishTopic: async (_topic: string, payload: unknown) => published.push(payload) }, health).processBatch();
      expect(published.filter(p => p.sessionId === first.id).map(p => p.kind)).toEqual(["end"]);
      expect(published.filter(p => p.sessionId === accepted.id).map(p => p.kind)).toEqual(["end"]);
      expect(await db.temporaryControlSession.findUnique({ where: { id: accepted.id } })).toMatchObject({ sessionRevision: 2, releaseIntentAt: expect.any(Date), terminalAt: null });
      expect(await db.temporaryControlLease.findUnique({ where: { fixtureId: expired.fixture.id } })).toMatchObject({ ownerSessionId: accepted.id });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
});
