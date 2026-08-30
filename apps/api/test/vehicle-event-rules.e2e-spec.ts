import { BadRequestException, type CanActivate, type ExecutionContext, type INestApplication } from "@nestjs/common";
import type { VehicleSensorCapabilityReportV1 } from "@led-control/shared";
import { Test } from "@nestjs/testing";
import { Prisma, PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { request } from "node:http";
import { SiteAccessService } from "../src/access/site-access.service";
import { AutomationClock } from "../src/automation/automation-clock";
import { AutomationModule } from "../src/automation/automation.module";
import { canonicalPayloadHash } from "../src/automation/automation-payload-hash";
import { VehicleSensorCapabilityService } from "../src/automation/vehicle-sensor-capability.service";
import type { AuthenticatedUser } from "../src/auth/auth.types";
import { SessionAuthGuard } from "../src/auth/session-auth.guard";
import { PrismaService } from "../src/prisma/prisma.service";

const databaseUrl = process.env.AUTOMATION_VEHICLE_EVENT_RULES_TEST_DATABASE_URL;
const describeWithPostgres = databaseUrl ? describe : describe.skip;
const FIXED_NOW = new Date("2026-08-31T23:00:00.000Z");
let automationNow = FIXED_NOW;

describeWithPostgres("vehicle event rules PostgreSQL E2E", () => {
  let app: INestApplication;
  let prisma: PrismaService;
  let capabilityService: VehicleSensorCapabilityService;
  let baseUrl: string;
  const actors = new Map<string, AuthenticatedUser>();

  beforeAll(async () => {
    process.env.DATABASE_URL = databaseUrl;
    const authGuard: CanActivate = {
      canActivate(context: ExecutionContext) {
        const req = context.switchToHttp().getRequest<{ headers: Record<string, string>; user?: AuthenticatedUser }>();
        const actor = actors.get(req.headers["x-test-actor"]);
        if (!actor) return false;
        req.user = actor;
        return true;
      }
    };
    const module = await Test.createTestingModule({ imports: [AutomationModule] })
      .overrideGuard(SessionAuthGuard)
      .useValue(authGuard)
      .overrideProvider(AutomationClock)
      .useValue({ now: () => new Date(automationNow) })
      .compile();
    app = module.createNestApplication();
    await app.listen(0, "127.0.0.1");
    const address = app.getHttpServer().address();
    if (!address || typeof address === "string") throw new Error("test server did not bind a TCP port");
    baseUrl = `http://127.0.0.1:${address.port}`;
    prisma = app.get(PrismaService);
    capabilityService = app.get(VehicleSensorCapabilityService);
  });

  afterAll(async () => {
    await app?.close();
  });

  it("allows viewer reads, restricts writes to the assigned admin, and hides operator and foreign resources", async () => {
    const first = await createScenario(prisma, actors);
    const second = await createScenario(prisma, actors);
    const created = await api(
      "POST",
      `/sites/${first.siteId}/automation/vehicle-event-rules`,
      first.actorKeys.admin,
      ruleBody(first)
    );
    expect(created.status).toBe(201);

    expect((await api(
      "GET",
      `/sites/${first.siteId}/automation/vehicle-event-rules`,
      first.actorKeys.viewer
    )).status).toBe(200);
    expect((await api(
      "POST",
      `/sites/${first.siteId}/automation/vehicle-event-rules`,
      first.actorKeys.viewer,
      ruleBody(first)
    )).status).toBe(403);
    expect((await api(
      "POST",
      `/sites/${first.siteId}/automation/vehicle-event-rules`,
      first.actorKeys.operator,
      ruleBody(first)
    )).status).toBe(404);
    expect((await api(
      "GET",
      `/sites/${first.siteId}/automation/vehicle-event-rules?limit=invalid`,
      second.actorKeys.admin
    )).status).toBe(404);
    expect((await api(
      "GET",
      `/sites/${first.siteId}/automation/vehicle-event-rules?limit=invalid`,
      first.actorKeys.operator
    )).status).toBe(404);
    const malformedViewerQuery = await api(
      "GET",
      `/sites/${first.siteId}/automation/vehicle-event-rules?limit=invalid`,
      first.actorKeys.viewer
    );
    expect(malformedViewerQuery.status).toBe(400);
    expect(malformedViewerQuery.body).toMatchObject({
      message: "invalid vehicle event rule list query"
    });

    const ruleId = (created.body as { id: string }).id;
    expect((await api(
      "PATCH",
      `/sites/${second.siteId}/automation/vehicle-event-rules/${ruleId}`,
      second.actorKeys.admin,
      { name: "Foreign update" }
    )).status).toBe(404);
    expect((await api(
      "DELETE",
      `/sites/${second.siteId}/automation/vehicle-event-rules/${ruleId}`,
      second.actorKeys.admin
    )).status).toBe(404);
  });

  it("accepts only verified supported vehicle sensor sources without exposing foreign fixture IDs", async () => {
    const scenario = await createScenario(prisma, actors, "unknown");
    const path = `/sites/${scenario.siteId}/automation/vehicle-event-rules`;

    const unknown = await api("POST", path, scenario.actorKeys.admin, ruleBody(scenario, {
      name: "Unknown source"
    }));
    expect(unknown.status).toBe(400);
    expect(JSON.stringify(unknown.body)).not.toContain(scenario.fixtureIds[0]);

    await capabilityService.applyReport(capabilityReport(scenario, scenario.meshNodeIds[0], "supported", 1));
    const capable = await api("POST", path, scenario.actorKeys.admin, ruleBody(scenario, {
      name: "Verified source"
    }));
    expect(capable.status).toBe(201);

    await capabilityService.applyReport(capabilityReport(scenario, scenario.meshNodeIds[0], "unsupported", 2));
    const unsupported = await api("POST", path, scenario.actorKeys.admin, ruleBody(scenario, {
      name: "Unsupported source"
    }));
    expect(unsupported.status).toBe(400);
    expect(JSON.stringify(unsupported.body)).not.toContain(scenario.fixtureIds[0]);

    const foreign = await createScenario(prisma, actors);
    const foreignSource = await api("POST", path, scenario.actorKeys.admin, ruleBody(scenario, {
      name: "Foreign source",
      sourceFixtureIds: [foreign.fixtureIds[0]]
    }));
    expect(foreignSource.status).toBe(400);
    expect(JSON.stringify(foreignSource.body)).not.toContain(foreign.fixtureIds[0]);
  });

  it("applies supported reports without an automation revision and hides forged ownership", async () => {
    const scenario = await createScenario(prisma, actors, "unknown");
    const supportedReport = capabilityReport(scenario, scenario.meshNodeIds[0], "supported", 1);

    await expect(capabilityService.applyReport(supportedReport)).resolves.toMatchObject({
      eventId: supportedReport.eventId,
      capabilityRevision: 1,
      status: "applied",
      errorCode: null
    });
    expect(await prisma.meshNode.findUniqueOrThrow({ where: { id: scenario.meshNodeIds[0] } }))
      .toMatchObject({
        vehicleSensorCapabilityStatus: "supported",
        vehicleSensorCapabilityVerifiedAt: new Date(supportedReport.verifiedAt),
        vehicleSensorCapabilityRevision: 1n,
        vehicleSensorServerBound: true,
        vehicleVendorEventModelBound: true
      });
    expect(await prisma.processedGatewayEvent.findUniqueOrThrow({ where: { eventId: supportedReport.eventId } }))
      .toMatchObject({
        gatewayId: scenario.gatewayId,
        sequence: 1n,
        eventType: "vehicle_sensor_capability",
        payloadHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/)
      });
    expect(await prisma.gatewayAutomationConfiguration.findUnique({ where: { gatewayId: scenario.gatewayId } }))
      .toBeNull();
    expect(await prisma.mqttOutbox.count({
      where: { gatewayId: scenario.gatewayId, revision: { not: null } }
    })).toBe(0);

    const foreign = await createScenario(prisma, actors, "unknown");
    const forged = capabilityReport(scenario, foreign.meshNodeIds[0], "supported", 1);
    const error: unknown = await capabilityService.applyReport(forged).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(BadRequestException);
    const response = (error as BadRequestException).getResponse();
    expect(JSON.stringify(response)).not.toContain(foreign.meshNodeIds[0]);
    expect(JSON.stringify(response)).not.toContain(scenario.siteId);
    expect(await prisma.meshNode.findUniqueOrThrow({ where: { id: foreign.meshNodeIds[0] } }))
      .toMatchObject({ vehicleSensorCapabilityStatus: "unknown", vehicleSensorCapabilityVerifiedAt: null });
  });

  it("allows two nodes on one Gateway to report revision one sequentially while same-node collisions reject", async () => {
    const scenario = await createScenario(prisma, actors, "unknown");
    const first = capabilityReport(scenario, scenario.meshNodeIds[0], "supported", 1);
    const second = capabilityReport(scenario, scenario.meshNodeIds[1], "supported", 1);

    await expect(capabilityService.applyReport(first)).resolves.toMatchObject({ status: "applied" });
    await expect(capabilityService.applyReport(second)).resolves.toMatchObject({ status: "applied" });
    await expect(capabilityService.applyReport({ ...first, eventId: randomUUID() })).resolves.toMatchObject({
      status: "rejected",
      errorCode: "capability_event_conflict"
    });

    expect(await prisma.$queryRaw<Array<{ meshNodeId: string; sequence: bigint }>>(Prisma.sql`
      SELECT "meshNodeId", "sequence"
      FROM "ProcessedGatewayEvent"
      WHERE "eventId" IN (${Prisma.join([first.eventId, second.eventId])})
      ORDER BY "meshNodeId"
    `)).toEqual([
      { meshNodeId: scenario.meshNodeIds[0], sequence: 1n },
      { meshNodeId: scenario.meshNodeIds[1], sequence: 1n }
    ].sort((left, right) => left.meshNodeId.localeCompare(right.meshNodeId)));
  });

  it("serializes concurrent revision-one reports independently for two nodes on one Gateway", async () => {
    const scenario = await createScenario(prisma, actors, "unknown");
    const reports = scenario.meshNodeIds.slice(0, 2).map((meshNodeId) =>
      capabilityReport(scenario, meshNodeId, "supported", 1)
    );

    await expect(Promise.all(reports.map((input) => capabilityService.applyReport(input))))
      .resolves.toEqual(reports.map((input) => expect.objectContaining({
        eventId: input.eventId,
        meshNodeId: input.meshNodeId,
        status: "applied"
      })));
    expect(await prisma.processedGatewayEvent.count({
      where: { eventId: { in: reports.map(({ eventId }) => eventId) } }
    })).toBe(2);
  });

  it("reconciles a millisecond-equal migrated revision-one baseline without changing capability state", async () => {
    const scenario = await createScenario(prisma, actors, "unknown");
    const input = {
      ...capabilityReport(scenario, scenario.meshNodeIds[0], "supported", 1),
      verifiedAt: "2026-08-30T01:02:03.456789Z"
    };
    await prisma.meshNode.update({
      where: { id: input.meshNodeId },
      data: {
        vehicleSensorCapabilityStatus: "supported",
        vehicleSensorCapabilityVerifiedAt: new Date(input.verifiedAt),
        vehicleSensorCapabilityRevision: 1n,
        vehicleSensorServerBound: true,
        vehicleVendorEventModelBound: true
      }
    });

    await expect(capabilityService.applyReport(input)).resolves.toMatchObject({
      status: "duplicate",
      errorCode: null
    });
    expect(await prisma.processedGatewayEvent.findUniqueOrThrow({ where: { eventId: input.eventId } }))
      .toMatchObject({ sequence: 1n, occurredAt: new Date("2026-08-30T01:02:03.456Z") });
    expect(await prisma.gatewayAutomationConfiguration.findUnique({ where: { gatewayId: scenario.gatewayId } }))
      .toBeNull();
  });

  it("keeps original and same-Gateway cross-node conflict ACKs immutable across both replays", async () => {
    const scenario = await createScenario(prisma, actors, "unknown");
    const original = capabilityReport(scenario, scenario.meshNodeIds[0], "supported", 1);
    const conflicting = {
      ...capabilityReport(scenario, scenario.meshNodeIds[1], "supported", 1),
      eventId: original.eventId
    };
    const firstIngestedAt = new Date("2026-08-31T20:00:00.000Z");
    automationNow = firstIngestedAt;

    try {
      const originalAck = await capabilityService.applyReport(original);
      automationNow = new Date("2026-08-31T21:00:00.000Z");
      const conflictAck = await capabilityService.applyReport(conflicting);
      expect(conflictAck).toMatchObject({
        eventId: original.eventId,
        meshNodeId: scenario.meshNodeIds[1],
        status: "rejected",
        errorCode: "capability_event_conflict",
        ingestedAt: automationNow.toISOString()
      });

      const originalKey = capabilityAckKey(original);
      const conflictKey = capabilityAckKey(conflicting);
      const beforeOriginal = await prisma.mqttOutbox.findUniqueOrThrow({ where: { applicationAckKey: originalKey } });
      const beforeConflict = await prisma.mqttOutbox.findUniqueOrThrow({ where: { applicationAckKey: conflictKey } });
      expect(beforeOriginal).toMatchObject({
        applicationAckKey: originalKey,
        dispatchId: null,
        gatewayId: scenario.gatewayId,
        revision: null,
        payloadHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
        topic: `sites/${scenario.siteId}/gateways/${scenario.gatewayId}/acks/automation/vehicle-sensor-capability-ingested`,
        payload: expect.objectContaining({
          eventId: original.eventId,
          meshNodeId: scenario.meshNodeIds[0],
          status: "applied",
          ingestedAt: firstIngestedAt.toISOString()
        })
      });
      expect(beforeConflict).toMatchObject({
        applicationAckKey: conflictKey,
        payload: expect.objectContaining({
          eventId: original.eventId,
          meshNodeId: scenario.meshNodeIds[1],
          status: "rejected",
          ingestedAt: conflictAck.ingestedAt
        })
      });
      await prisma.mqttOutbox.update({
        where: { applicationAckKey: conflictKey },
        data: {
          attempts: 10,
          deadLetteredAt: new Date("2026-08-31T21:30:00.000Z"),
          lastError: "conflict ACK publish exhausted"
        }
      });

      automationNow = new Date("2026-08-31T22:00:00.000Z");
      await expect(capabilityService.applyReport(original)).resolves.toEqual(originalAck);
      await expect(capabilityService.applyReport(conflicting)).resolves.toEqual(conflictAck);

      const afterOriginal = await prisma.mqttOutbox.findUniqueOrThrow({ where: { applicationAckKey: originalKey } });
      const afterConflict = await prisma.mqttOutbox.findUniqueOrThrow({ where: { applicationAckKey: conflictKey } });
      expect({ payload: afterOriginal.payload, payloadHash: afterOriginal.payloadHash })
        .toEqual({ payload: beforeOriginal.payload, payloadHash: beforeOriginal.payloadHash });
      expect({ payload: afterConflict.payload, payloadHash: afterConflict.payloadHash })
        .toEqual({ payload: beforeConflict.payload, payloadHash: beforeConflict.payloadHash });
      expect(afterConflict).toMatchObject({
        attempts: 0,
        nextAttemptAt: automationNow,
        deadLetteredAt: null,
        lastError: null
      });
      expect(await prisma.processedGatewayEvent.count({ where: { eventId: original.eventId } })).toBe(1);
      expect(await prisma.meshNode.findUniqueOrThrow({ where: { id: scenario.meshNodeIds[1] } }))
        .toMatchObject({
          vehicleSensorCapabilityStatus: "unknown",
          vehicleSensorCapabilityRevision: 0n
        });
    } finally {
      automationNow = FIXED_NOW;
    }
  });

  it.each([
    ["original then altered", ["original", "altered"]],
    ["altered then original", ["altered", "original"]]
  ] as const)("keeps same-node report-hash ACKs immutable when replaying %s", async (_label, replayOrder) => {
    const scenario = await createScenario(prisma, actors, "unknown");
    const original = capabilityReport(scenario, scenario.meshNodeIds[0], "supported", 1);
    const altered = {
      ...original,
      status: "unsupported" as const,
      sensorServerBound: false,
      vendorVehicleEventModelBound: false
    };
    automationNow = new Date("2026-08-31T20:00:00.000Z");

    try {
      const originalAck = await capabilityService.applyReport(original);
      automationNow = new Date("2026-08-31T20:05:00.000Z");
      const alteredAck = await capabilityService.applyReport(altered);
      expect(originalAck).toMatchObject({
        status: "applied",
        errorCode: null,
        reportPayloadHash: canonicalPayloadHash(original)
      });
      expect(alteredAck).toMatchObject({
        status: "rejected",
        errorCode: "capability_event_conflict",
        reportPayloadHash: canonicalPayloadHash(altered)
      });

      const originalKey = capabilityAckKey(original);
      const alteredKey = capabilityAckKey(altered);
      expect(originalKey).not.toBe(alteredKey);
      expect(Math.max(originalKey.length, alteredKey.length)).toBeLessThanOrEqual(255);
      const beforeOriginal = await prisma.mqttOutbox.findUniqueOrThrow({
        where: { applicationAckKey: originalKey }
      });
      const beforeAltered = await prisma.mqttOutbox.findUniqueOrThrow({
        where: { applicationAckKey: alteredKey }
      });
      await prisma.mqttOutbox.update({
        where: { applicationAckKey: originalKey },
        data: {
          attempts: 4,
          nextAttemptAt: new Date("2026-09-01T04:00:00.000Z"),
          publishedAt: new Date("2026-08-31T20:01:00.000Z"),
          lastError: "original ACK may have been lost"
        }
      });
      await prisma.mqttOutbox.update({
        where: { applicationAckKey: alteredKey },
        data: {
          attempts: 10,
          nextAttemptAt: new Date("2026-09-01T04:00:00.000Z"),
          deadLetteredAt: new Date("2026-08-31T20:06:00.000Z"),
          lastError: "altered ACK publish exhausted"
        }
      });

      automationNow = new Date("2026-08-31T21:00:00.000Z");
      const reports = { original, altered };
      const acknowledgements = { original: originalAck, altered: alteredAck };
      for (const identity of replayOrder) {
        await expect(capabilityService.applyReport(reports[identity]))
          .resolves.toEqual(acknowledgements[identity]);
      }

      const afterOriginal = await prisma.mqttOutbox.findUniqueOrThrow({
        where: { applicationAckKey: originalKey }
      });
      const afterAltered = await prisma.mqttOutbox.findUniqueOrThrow({
        where: { applicationAckKey: alteredKey }
      });
      for (const [before, after] of [
        [beforeOriginal, afterOriginal],
        [beforeAltered, afterAltered]
      ] as const) {
        expect(after).toMatchObject({
          attempts: 0,
          nextAttemptAt: automationNow,
          publishedAt: null,
          deadLetteredAt: null,
          lastError: null,
          payload: before.payload,
          payloadHash: before.payloadHash
        });
      }
      expect(await prisma.mqttOutbox.count({
        where: {
          applicationAckKey: {
            startsWith: `vehicle-sensor-capability:${scenario.gatewayId}:${scenario.meshNodeIds[0]}:${original.eventId}:`
          }
        }
      })).toBe(2);
      expect(await prisma.processedGatewayEvent.count({ where: { eventId: original.eventId } })).toBe(1);
      expect(await prisma.meshNode.findUniqueOrThrow({ where: { id: scenario.meshNodeIds[0] } }))
        .toMatchObject({
          vehicleSensorCapabilityStatus: "supported",
          vehicleSensorCapabilityRevision: 1n,
          vehicleSensorServerBound: true,
          vehicleVendorEventModelBound: true
        });
    } finally {
      automationNow = FIXED_NOW;
    }
  });

  it("revives published-lost and dead-lettered exact ACKs without changing payload identity", async () => {
    const scenario = await createScenario(prisma, actors, "unknown");
    const publishedReport = capabilityReport(scenario, scenario.meshNodeIds[0], "supported", 1);
    const deadLetteredReport = capabilityReport(scenario, scenario.meshNodeIds[1], "supported", 1);
    automationNow = new Date("2026-08-31T20:00:00.000Z");

    try {
      const publishedAck = await capabilityService.applyReport(publishedReport);
      const deadLetteredAck = await capabilityService.applyReport(deadLetteredReport);
      const publishedKey = capabilityAckKey(publishedReport);
      const deadLetteredKey = capabilityAckKey(deadLetteredReport);
      const beforePublished = await prisma.mqttOutbox.findUniqueOrThrow({ where: { applicationAckKey: publishedKey } });
      const beforeDeadLettered = await prisma.mqttOutbox.findUniqueOrThrow({ where: { applicationAckKey: deadLetteredKey } });
      await prisma.mqttOutbox.update({
        where: { applicationAckKey: publishedKey },
        data: {
          attempts: 4,
          nextAttemptAt: new Date("2026-09-01T04:00:00.000Z"),
          publishedAt: new Date("2026-08-31T20:01:00.000Z"),
          lastError: "application ACK may have been lost"
        }
      });
      await prisma.mqttOutbox.update({
        where: { applicationAckKey: deadLetteredKey },
        data: {
          attempts: 10,
          nextAttemptAt: new Date("2026-09-01T04:00:00.000Z"),
          deadLetteredAt: new Date("2026-08-31T20:02:00.000Z"),
          lastError: "MQTT publish exhausted"
        }
      });

      const revivedAt = new Date("2026-08-31T21:00:00.000Z");
      automationNow = revivedAt;
      await expect(capabilityService.applyReport(publishedReport)).resolves.toEqual(publishedAck);
      await expect(capabilityService.applyReport(deadLetteredReport)).resolves.toEqual(deadLetteredAck);

      const afterPublished = await prisma.mqttOutbox.findUniqueOrThrow({ where: { applicationAckKey: publishedKey } });
      const afterDeadLettered = await prisma.mqttOutbox.findUniqueOrThrow({ where: { applicationAckKey: deadLetteredKey } });
      for (const [before, after] of [
        [beforePublished, afterPublished],
        [beforeDeadLettered, afterDeadLettered]
      ] as const) {
        expect(after).toMatchObject({
          attempts: 0,
          nextAttemptAt: revivedAt,
          publishedAt: null,
          lockedBy: null,
          lockedAt: null,
          leaseExpiresAt: null,
          deadLetteredAt: null,
          lastError: null,
          payload: before.payload,
          payloadHash: before.payloadHash
        });
      }
    } finally {
      automationNow = FIXED_NOW;
    }
  });

  it("does not steal a live ACK publisher lease and revives an expired lease", async () => {
    const scenario = await createScenario(prisma, actors, "unknown");
    const activeReport = capabilityReport(scenario, scenario.meshNodeIds[0], "supported", 1);
    const expiredReport = capabilityReport(scenario, scenario.meshNodeIds[1], "supported", 1);
    automationNow = new Date("2026-08-31T20:00:00.000Z");

    try {
      const activeAck = await capabilityService.applyReport(activeReport);
      const expiredAck = await capabilityService.applyReport(expiredReport);
      const activeKey = capabilityAckKey(activeReport);
      const expiredKey = capabilityAckKey(expiredReport);
      const activeLeaseExpiresAt = new Date("2026-08-31T21:00:30.000Z");
      const activePublishedAt = new Date("2026-08-31T20:59:30.000Z");
      const expiredLeaseExpiresAt = new Date("2026-08-31T20:59:59.999Z");
      const delayedRetryAt = new Date("2026-09-01T04:00:00.000Z");
      await prisma.mqttOutbox.update({
        where: { applicationAckKey: activeKey },
        data: {
          attempts: 3,
          nextAttemptAt: delayedRetryAt,
          publishedAt: activePublishedAt,
          lockedBy: "active-publisher",
          lockedAt: new Date("2026-08-31T20:59:00.000Z"),
          leaseExpiresAt: activeLeaseExpiresAt,
          lastError: "publisher owns completion"
        }
      });
      await prisma.mqttOutbox.update({
        where: { applicationAckKey: expiredKey },
        data: {
          attempts: 5,
          nextAttemptAt: delayedRetryAt,
          lockedBy: "expired-publisher",
          lockedAt: new Date("2026-08-31T20:59:00.000Z"),
          leaseExpiresAt: expiredLeaseExpiresAt,
          lastError: "publisher crashed"
        }
      });
      const beforeActive = await prisma.mqttOutbox.findUniqueOrThrow({ where: { applicationAckKey: activeKey } });
      const beforeExpired = await prisma.mqttOutbox.findUniqueOrThrow({ where: { applicationAckKey: expiredKey } });

      const replayedAt = new Date("2026-08-31T21:00:00.000Z");
      automationNow = replayedAt;
      await expect(capabilityService.applyReport(activeReport)).resolves.toEqual(activeAck);
      await expect(capabilityService.applyReport(expiredReport)).resolves.toEqual(expiredAck);

      const afterActive = await prisma.mqttOutbox.findUniqueOrThrow({ where: { applicationAckKey: activeKey } });
      const afterExpired = await prisma.mqttOutbox.findUniqueOrThrow({ where: { applicationAckKey: expiredKey } });
      expect(afterActive).toMatchObject({
        attempts: 3,
        nextAttemptAt: delayedRetryAt,
        publishedAt: activePublishedAt,
        lockedBy: "active-publisher",
        lockedAt: new Date("2026-08-31T20:59:00.000Z"),
        leaseExpiresAt: activeLeaseExpiresAt,
        lastError: "publisher owns completion",
        payload: beforeActive.payload,
        payloadHash: beforeActive.payloadHash
      });
      expect(afterExpired).toMatchObject({
        attempts: 0,
        nextAttemptAt: replayedAt,
        publishedAt: null,
        lockedBy: null,
        lockedAt: null,
        leaseExpiresAt: null,
        deadLetteredAt: null,
        lastError: null,
        payload: beforeExpired.payload,
        payloadHash: beforeExpired.payloadHash
      });
    } finally {
      automationNow = FIXED_NOW;
    }
  });

  it("orders reports, rejects altered same-identity payloads, and snapshots once", async () => {
    const scenario = await createScenario(prisma, actors);
    const path = `/sites/${scenario.siteId}/automation/vehicle-event-rules`;
    const first = await api("POST", path, scenario.actorKeys.admin, ruleBody(scenario, { name: "Downgrade A" }));
    const second = await api("POST", path, scenario.actorKeys.admin, ruleBody(scenario, { name: "Downgrade B" }));
    expect([first.status, second.status]).toEqual([201, 201]);
    const ruleIds = [(first.body as { id: string }).id, (second.body as { id: string }).id].sort();
    const unsupportedReport = capabilityReport(scenario, scenario.meshNodeIds[0], "unsupported", 2);

    const unsupportedAck = await capabilityService.applyReport(unsupportedReport);
    expect(unsupportedAck).toMatchObject({
      eventId: unsupportedReport.eventId,
      capabilityRevision: 2,
      status: "applied",
      errorCode: null
    });
    expect(await prisma.vehicleEventRule.findMany({
      where: { id: { in: ruleIds } },
      select: { id: true, status: true },
      orderBy: { id: "asc" }
    })).toEqual(ruleIds.map((id) => ({ id, status: "disabled" })));
    expect(await prisma.meshNode.findUniqueOrThrow({ where: { id: scenario.meshNodeIds[0] } }))
      .toMatchObject({
        vehicleSensorCapabilityStatus: "unsupported",
        vehicleSensorCapabilityVerifiedAt: new Date(unsupportedReport.verifiedAt),
        vehicleSensorCapabilityRevision: 2n,
        vehicleSensorServerBound: false,
        vehicleVendorEventModelBound: false
      });
    expect(await prisma.gatewayAutomationConfiguration.findUniqueOrThrow({ where: { gatewayId: scenario.gatewayId } }))
      .toMatchObject({ desiredRevision: 3, syncStatus: "PENDING" });
    expect((await prisma.mqttOutbox.findFirstOrThrow({
      where: { gatewayId: scenario.gatewayId, revision: 3 }
    })).payload).toMatchObject({
      revision: 3,
      vehicleEventRules: ruleIds.map((id) => expect.objectContaining({ id, status: "disabled" }))
    });

    await expect(capabilityService.applyReport(unsupportedReport)).resolves.toEqual(unsupportedAck);
    expect(await prisma.mqttOutbox.count({
      where: { gatewayId: scenario.gatewayId, revision: { not: null } }
    })).toBe(3);

    const conflictingReplay = {
      ...unsupportedReport,
      status: "supported" as const,
      sensorServerBound: true,
      vendorVehicleEventModelBound: true
    };
    await expect(capabilityService.applyReport(conflictingReplay)).resolves.toMatchObject({
      status: "rejected",
      errorCode: "capability_event_conflict",
      reportPayloadHash: canonicalPayloadHash(conflictingReplay)
    });
    expect(await prisma.mqttOutbox.count({
      where: { gatewayId: scenario.gatewayId, revision: { not: null } }
    })).toBe(3);
    expect((await api(
      "PATCH",
      `${path}/${ruleIds[0]}`,
      scenario.actorKeys.admin,
      { status: "enabled" }
    )).status).toBe(400);

    const supportedReport = capabilityReport(
      scenario,
      scenario.meshNodeIds[0],
      "supported",
      4
    );
    await expect(capabilityService.applyReport(supportedReport)).resolves.toMatchObject({
      capabilityRevision: 4,
      status: "applied",
      errorCode: null
    });
    expect(await prisma.mqttOutbox.count({
      where: { gatewayId: scenario.gatewayId, revision: { not: null } }
    })).toBe(3);

    const staleUnsupported = capabilityReport(
      scenario,
      scenario.meshNodeIds[0],
      "unsupported",
      3
    );
    await expect(capabilityService.applyReport(staleUnsupported)).resolves.toMatchObject({
      capabilityRevision: 3,
      status: "stale",
      errorCode: null
    });
    expect(await prisma.meshNode.findUniqueOrThrow({ where: { id: scenario.meshNodeIds[0] } }))
      .toMatchObject({
        vehicleSensorCapabilityStatus: "supported",
        vehicleSensorCapabilityRevision: 4n,
        vehicleSensorServerBound: true,
        vehicleVendorEventModelBound: true
      });
    expect(await prisma.processedGatewayEvent.findUniqueOrThrow({ where: { eventId: staleUnsupported.eventId } }))
      .toMatchObject({ sequence: 3n, eventType: "vehicle_sensor_capability" });
    expect(await prisma.mqttOutbox.count({
      where: { gatewayId: scenario.gatewayId, revision: { not: null } }
    })).toBe(3);
    const reenabled = await api(
      "PATCH",
      `${path}/${ruleIds[0]}`,
      scenario.actorKeys.admin,
      { status: "enabled" }
    );
    expect(reenabled.status).toBe(200);
    expect(reenabled.body).toMatchObject({ status: "enabled", desiredRevision: 4 });
  });

  it("preserves an existing schedule while disabling and re-enabling an event rule snapshot", async () => {
    const scenario = await createScenario(prisma, actors);
    const schedule = await api(
      "POST",
      `/sites/${scenario.siteId}/automation/schedules`,
      scenario.actorKeys.admin,
      scheduleBody([scenario.fixtureIds[2]])
    );
    expect(schedule.status).toBe(201);
    const scheduleId = (schedule.body as { id: string }).id;

    const created = await api(
      "POST",
      `/sites/${scenario.siteId}/automation/vehicle-event-rules`,
      scenario.actorKeys.admin,
      ruleBody(scenario, { name: "Toggle event" })
    );
    expect(created.status).toBe(201);
    const ruleId = (created.body as { id: string }).id;
    expect((await prisma.mqttOutbox.findFirstOrThrow({
      where: { gatewayId: scenario.gatewayId, revision: 2 }
    })).payload).toMatchObject({
      schedules: [expect.objectContaining({ id: scheduleId })],
      vehicleEventRules: [expect.objectContaining({ id: ruleId, status: "enabled" })]
    });

    const disabled = await api(
      "PATCH",
      `/sites/${scenario.siteId}/automation/vehicle-event-rules/${ruleId}`,
      scenario.actorKeys.admin,
      { status: "disabled" }
    );
    expect(disabled.status).toBe(200);
    expect((await prisma.mqttOutbox.findFirstOrThrow({
      where: { gatewayId: scenario.gatewayId, revision: 3 }
    })).payload).toMatchObject({
      schedules: [expect.objectContaining({ id: scheduleId })],
      vehicleEventRules: [expect.objectContaining({ id: ruleId, status: "disabled" })]
    });

    const reenabled = await api(
      "PATCH",
      `/sites/${scenario.siteId}/automation/vehicle-event-rules/${ruleId}`,
      scenario.actorKeys.admin,
      { status: "enabled" }
    );
    expect(reenabled.status).toBe(200);
    expect((await prisma.mqttOutbox.findFirstOrThrow({
      where: { gatewayId: scenario.gatewayId, revision: 4 }
    })).payload).toMatchObject({
      schedules: [expect.objectContaining({ id: scheduleId })],
      vehicleEventRules: [expect.objectContaining({ id: ruleId, status: "enabled" })]
    });
  });

  it("serializes concurrent schedule and event creates into complete consecutive snapshots", async () => {
    const scenario = await createScenario(prisma, actors);
    const [schedule, eventRule] = await Promise.all([
      api(
        "POST",
        `/sites/${scenario.siteId}/automation/schedules`,
        scenario.actorKeys.admin,
        scheduleBody([scenario.fixtureIds[2]], { name: "Concurrent schedule" })
      ),
      api(
        "POST",
        `/sites/${scenario.siteId}/automation/vehicle-event-rules`,
        scenario.actorKeys.admin,
        ruleBody(scenario, { name: "Concurrent event" })
      )
    ]);

    expect([schedule.status, eventRule.status]).toEqual([201, 201]);
    expect([
      (schedule.body as { desiredRevision: number }).desiredRevision,
      (eventRule.body as { desiredRevision: number }).desiredRevision
    ].sort()).toEqual([1, 2]);
    expect(await prisma.gatewayAutomationConfiguration.findUniqueOrThrow({
      where: { gatewayId: scenario.gatewayId }
    })).toMatchObject({ desiredRevision: 2, syncStatus: "PENDING" });
    const latest = await prisma.mqttOutbox.findFirstOrThrow({
      where: { gatewayId: scenario.gatewayId, revision: 2 }
    });
    expect(latest.payload).toMatchObject({
      revision: 2,
      schedules: [expect.objectContaining({ id: (schedule.body as { id: string }).id })],
      vehicleEventRules: [expect.objectContaining({ id: (eventRule.body as { id: string }).id })]
    });
  });

  it("validates hold, brightness, distinct registered source/target fixtures, and one shared Gateway", async () => {
    const scenario = await createScenario(prisma, actors);
    const unregistered = await prisma.fixture.create({ data: {
      floorId: scenario.floorId,
      name: "Unregistered sensor",
      ratedWatt: 20,
      x: 80,
      y: 0,
      status: "online"
    } });
    const otherGateway = await prisma.gateway.create({ data: {
      siteId: scenario.siteId,
      name: "Other gateway",
      serialNumber: `VEHICLE-OTHER-${randomUUID()}`,
      firmwareVersion: "test"
    } });
    const otherNode = await prisma.meshNode.create({ data: {
      gatewayId: otherGateway.id,
      meshAddress: "0200",
      firmwareVersion: "test"
    } });
    const otherFixture = await prisma.fixture.create({ data: {
      floorId: scenario.floorId,
      meshNodeId: otherNode.id,
      name: "Other gateway target",
      ratedWatt: 20,
      x: 100,
      y: 0,
      status: "online"
    } });

    const invalidBodies = [
      ruleBody(scenario, { sourceFixtureIds: [] }),
      ruleBody(scenario, { targetFixtureIds: [] }),
      ruleBody(scenario, { sourceFixtureIds: [scenario.fixtureIds[0], scenario.fixtureIds[0]] }),
      ruleBody(scenario, { targetFixtureIds: [scenario.fixtureIds[1], scenario.fixtureIds[1]] }),
      ruleBody(scenario, { holdSeconds: 4 }),
      ruleBody(scenario, { holdSeconds: 1801 }),
      ruleBody(scenario, { holdSeconds: 5.5 }),
      ruleBody(scenario, { action: { dimmingEnabled: true, brightnessPercent: -1 } }),
      ruleBody(scenario, { action: { dimmingEnabled: true, brightnessPercent: 101 } }),
      ruleBody(scenario, { action: { dimmingEnabled: true, brightnessPercent: 20.5 } }),
      ruleBody(scenario, { sourceFixtureIds: [unregistered.id] })
    ];
    for (const body of invalidBodies) {
      expect((await api(
        "POST",
        `/sites/${scenario.siteId}/automation/vehicle-event-rules`,
        scenario.actorKeys.admin,
        body
      )).status).toBe(400);
    }

    const crossGateway = await api(
      "POST",
      `/sites/${scenario.siteId}/automation/vehicle-event-rules`,
      scenario.actorKeys.admin,
      ruleBody(scenario, { targetFixtureIds: [otherFixture.id] })
    );
    expect(crossGateway.status).toBe(409);
    expect(crossGateway.body).toMatchObject({ code: "single_gateway_required" });
    expect(await prisma.vehicleEventRule.count({ where: { siteId: scenario.siteId } })).toBe(0);
    expect(await prisma.mqttOutbox.count({ where: { gatewayId: scenario.gatewayId } })).toBe(0);
  });

  it("writes exact children, default hold, normalized action, revisions, full snapshots, and latest detection/execution", async () => {
    const scenario = await createScenario(prisma, actors);
    const { holdSeconds: _omittedHold, ...body } = ruleBody(scenario, {
      sourceFixtureIds: [scenario.fixtureIds[1], scenario.fixtureIds[0]],
      targetFixtureIds: [scenario.fixtureIds[2]],
      action: { dimmingEnabled: false, brightnessPercent: 7 }
    });
    const created = await api(
      "POST",
      `/sites/${scenario.siteId}/automation/vehicle-event-rules`,
      scenario.actorKeys.admin,
      body
    );

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      gatewayId: scenario.gatewayId,
      sourceFixtureIds: [scenario.fixtureIds[0], scenario.fixtureIds[1]].sort(),
      targetFixtureIds: [scenario.fixtureIds[2]],
      sourceCount: 2,
      targetCount: 1,
      action: { dimmingEnabled: false, brightnessPercent: 100 },
      holdSeconds: 60,
      desiredRevision: 1,
      appliedRevision: 0,
      syncStatus: "PENDING",
      lastDetection: null,
      lastExecution: null
    });
    const ruleId = (created.body as { id: string }).id;
    expect(await prisma.vehicleEventRule.findUniqueOrThrow({
      where: { id: ruleId },
      select: { dimmingEnabled: true, brightnessPercent: true, holdSeconds: true, sourceCount: true, targetCount: true }
    })).toEqual({
      dimmingEnabled: false,
      brightnessPercent: 100,
      holdSeconds: 60,
      sourceCount: 2,
      targetCount: 1
    });
    expect((await prisma.vehicleEventSource.findMany({
      where: { ruleId },
      orderBy: { fixtureId: "asc" },
      select: { fixtureId: true }
    })).map(({ fixtureId }) => fixtureId)).toEqual([scenario.fixtureIds[0], scenario.fixtureIds[1]].sort());
    expect((await prisma.vehicleEventTarget.findMany({
      where: { ruleId },
      select: { fixtureId: true }
    })).map(({ fixtureId }) => fixtureId)).toEqual([scenario.fixtureIds[2]]);

    const configuration = await prisma.gatewayAutomationConfiguration.findUniqueOrThrow({
      where: { gatewayId: scenario.gatewayId }
    });
    const firstOutbox = await prisma.mqttOutbox.findFirstOrThrow({
      where: { gatewayId: scenario.gatewayId, revision: 1 }
    });
    expect(configuration).toMatchObject({ desiredRevision: 1, appliedRevision: 0, syncStatus: "PENDING" });
    expect(firstOutbox.payload).toMatchObject({
      revision: 1,
      schedules: [],
      vehicleEventRules: [{
        id: ruleId,
        name: "Garage entry",
        status: "enabled",
        sourceFixtureIds: [scenario.fixtureIds[0], scenario.fixtureIds[1]].sort(),
        targetFixtureIds: [scenario.fixtureIds[2]],
        action: { dimmingEnabled: false, brightnessPercent: 100 },
        holdSeconds: 60
      }]
    });

    await prisma.automationExecution.createMany({ data: [
      executionData(scenario, ruleId, 1, "vehicle_detected", "2026-09-01T00:00:00.000Z"),
      executionData(scenario, ruleId, 2, "event_started", "2026-09-01T00:01:00.000Z"),
      executionData(scenario, ruleId, 3, "action_result", "2026-09-01T00:02:00.000Z")
    ] });
    const listed = await api(
      "GET",
      `/sites/${scenario.siteId}/automation/vehicle-event-rules`,
      scenario.actorKeys.viewer
    );
    expect(listed.status).toBe(200);
    expect(listed.body).toMatchObject({
      total: 1,
      items: [expect.objectContaining({
        id: ruleId,
        sourceCount: 2,
        targetCount: 1,
        syncStatus: "PENDING",
        lastDetection: expect.objectContaining({ kind: "vehicle_detected", sequence: "1" }),
        lastExecution: expect.objectContaining({ kind: "action_result", sequence: "3" })
      })]
    });

    const updated = await api(
      "PATCH",
      `/sites/${scenario.siteId}/automation/vehicle-event-rules/${ruleId}`,
      scenario.actorKeys.admin,
      { name: "Updated entry", holdSeconds: 1800, action: { dimmingEnabled: true, brightnessPercent: 0 } }
    );
    expect(updated.status).toBe(200);
    expect(updated.body).toMatchObject({
      name: "Updated entry",
      holdSeconds: 1800,
      action: { dimmingEnabled: true, brightnessPercent: 0 },
      desiredRevision: 2,
      lastDetection: expect.objectContaining({ sequence: "1" }),
      lastExecution: expect.objectContaining({ sequence: "3" })
    });
    expect(await prisma.gatewayAutomationConfiguration.findUniqueOrThrow({ where: { gatewayId: scenario.gatewayId } }))
      .toMatchObject({ desiredRevision: 2, syncStatus: "PENDING" });
    expect((await prisma.mqttOutbox.findFirstOrThrow({
      where: { gatewayId: scenario.gatewayId, revision: 2 }
    })).payload).toMatchObject({
      revision: 2,
      vehicleEventRules: [expect.objectContaining({
        id: ruleId,
        holdSeconds: 1800,
        action: { dimmingEnabled: true, brightnessPercent: 0 }
      })]
    });

    const removed = await api(
      "DELETE",
      `/sites/${scenario.siteId}/automation/vehicle-event-rules/${ruleId}`,
      scenario.actorKeys.admin
    );
    expect(removed.status).toBe(200);
    expect(removed.body).toMatchObject({ id: ruleId, deleted: true, desiredRevision: 3, syncStatus: "PENDING" });
    expect((await prisma.mqttOutbox.findFirstOrThrow({
      where: { gatewayId: scenario.gatewayId, revision: 3 }
    })).payload).toMatchObject({ revision: 3, vehicleEventRules: [] });
  });

  it("moves source and target snapshots between Gateways and advances both full snapshots atomically", async () => {
    const scenario = await createScenario(prisma, actors);
    const created = await api(
      "POST",
      `/sites/${scenario.siteId}/automation/vehicle-event-rules`,
      scenario.actorKeys.admin,
      ruleBody(scenario)
    );
    const ruleId = (created.body as { id: string }).id;
    const secondGateway = await prisma.gateway.create({ data: {
      siteId: scenario.siteId,
      name: "Move gateway",
      serialNumber: `VEHICLE-MOVE-${randomUUID()}`,
      firmwareVersion: "test"
    } });
    const movedFixtureIds: string[] = [];
    for (const [index, meshAddress] of ["0300", "0301"].entries()) {
      const node = await prisma.meshNode.create({ data: {
        gatewayId: secondGateway.id,
        meshAddress,
        firmwareVersion: "test",
        ...(index === 0 ? {
          vehicleSensorCapabilityStatus: "supported" as const,
          vehicleSensorCapabilityVerifiedAt: new Date(),
          vehicleSensorCapabilityRevision: 1n,
          vehicleSensorServerBound: true,
          vehicleVendorEventModelBound: true
        } : {})
      } });
      const fixture = await prisma.fixture.create({ data: {
        floorId: scenario.floorId,
        meshNodeId: node.id,
        name: `Moved ${index}`,
        ratedWatt: 20,
        x: 120 + index * 20,
        y: 0,
        status: "online"
      } });
      movedFixtureIds.push(fixture.id);
    }

    const moved = await api(
      "PATCH",
      `/sites/${scenario.siteId}/automation/vehicle-event-rules/${ruleId}`,
      scenario.actorKeys.admin,
      { sourceFixtureIds: [movedFixtureIds[0]], targetFixtureIds: [movedFixtureIds[1]] }
    );
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({
      gatewayId: secondGateway.id,
      sourceFixtureIds: [movedFixtureIds[0]],
      targetFixtureIds: [movedFixtureIds[1]],
      desiredRevision: 1,
      appliedRevision: 0
    });
    expect((await prisma.mqttOutbox.findFirstOrThrow({
      where: { gatewayId: scenario.gatewayId, revision: 2 }
    })).payload).toMatchObject({ vehicleEventRules: [] });
    expect((await prisma.mqttOutbox.findFirstOrThrow({
      where: { gatewayId: secondGateway.id, revision: 1 }
    })).payload).toMatchObject({
      vehicleEventRules: [expect.objectContaining({
        id: ruleId,
        sourceFixtureIds: [movedFixtureIds[0]],
        targetFixtureIds: [movedFixtureIds[1]]
      })]
    });
  });

  it("serializes concurrent creates into consecutive revisions and complete snapshots", async () => {
    const scenario = await createScenario(prisma, actors);
    const [first, second] = await Promise.all([
      api(
        "POST",
        `/sites/${scenario.siteId}/automation/vehicle-event-rules`,
        scenario.actorKeys.admin,
        ruleBody(scenario, { name: "Concurrent A" })
      ),
      api(
        "POST",
        `/sites/${scenario.siteId}/automation/vehicle-event-rules`,
        scenario.actorKeys.admin,
        ruleBody(scenario, { name: "Concurrent B" })
      )
    ]);

    expect([first.status, second.status]).toEqual([201, 201]);
    expect([(first.body as { desiredRevision: number }).desiredRevision,
      (second.body as { desiredRevision: number }).desiredRevision].sort()).toEqual([1, 2]);
    expect(await prisma.gatewayAutomationConfiguration.findUniqueOrThrow({ where: { gatewayId: scenario.gatewayId } }))
      .toMatchObject({ desiredRevision: 2, syncStatus: "PENDING" });
    const outboxes = await prisma.mqttOutbox.findMany({
      where: { gatewayId: scenario.gatewayId },
      orderBy: { revision: "asc" }
    });
    expect(outboxes.map(({ revision }) => revision)).toEqual([1, 2]);
    expect((outboxes[1].payload as { vehicleEventRules: unknown[] }).vehicleEventRules).toHaveLength(2);
  });

  it("reauthorizes a stale assigned admin only after acquiring the global automation lock", async () => {
    const scenario = await createScenario(prisma, actors);
    const lockClient = new PrismaClient({ datasourceUrl: databaseUrl });
    const siteAccess = app.get(SiteAccessService);
    const originalAssert = siteAccess.assert.bind(siteAccess);
    let signalOuterCheck!: () => void;
    const outerCheck = new Promise<void>((resolve) => { signalOuterCheck = resolve; });
    let releaseLock!: () => void;
    const holdLock = new Promise<void>((resolve) => { releaseLock = resolve; });
    let signalLockHeld!: () => void;
    const lockHeld = new Promise<void>((resolve) => { signalLockHeld = resolve; });
    const assertSpy = jest.spyOn(siteAccess, "assert").mockImplementation(async (...args) => {
      const result = await originalAssert(...args);
      if (args[1] === scenario.siteId && args[2] === "manage") signalOuterCheck();
      return result;
    });
    const blocker = lockClient.$transaction(async (tx) => {
      await tx.$executeRaw(Prisma.sql`SELECT "lock_automation_membership_mutation"()`);
      signalLockHeld();
      await holdLock;
    });

    try {
      await lockHeld;
      const mutation = api(
        "POST",
        `/sites/${scenario.siteId}/automation/vehicle-event-rules`,
        scenario.actorKeys.admin,
        ruleBody(scenario, { name: "Stale admin" })
      );
      await outerCheck;
      const site = await prisma.site.findUniqueOrThrow({
        where: { id: scenario.siteId },
        select: { organizationId: true }
      });
      const replacement = await prisma.user.create({ data: {
        organizationId: site.organizationId,
        loginId: `vehicle_replacement_${randomUUID()}`,
        email: `vehicle-replacement-${randomUUID()}@example.com`,
        name: "Replacement admin",
        passwordHash: "not-used",
        role: "admin"
      } });
      await prisma.site.update({ where: { id: scenario.siteId }, data: { adminUserId: replacement.id } });
      releaseLock();

      expect((await mutation).status).toBe(404);
      expect(await prisma.vehicleEventRule.count({ where: { siteId: scenario.siteId } })).toBe(0);
    } finally {
      releaseLock();
      await blocker;
      assertSpy.mockRestore();
      await lockClient.$disconnect();
    }
  });

  it("rolls back parent, source, target, revision, and outbox when snapshot persistence fails", async () => {
    const scenario = await createScenario(prisma, actors);
    const suffix = randomUUID().replaceAll("-", "");
    const triggerName = `vehicle_outbox_failure_${suffix}`;
    const functionName = `raise_vehicle_outbox_failure_${suffix}`;
    await prisma.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."gatewayId" = '${scenario.gatewayId}' THEN
          RAISE EXCEPTION 'injected vehicle outbox failure';
        END IF;
        RETURN NEW;
      END;
      $$;
    `);
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE INSERT ON "MqttOutbox"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"();
    `);

    try {
      const failed = await api(
        "POST",
        `/sites/${scenario.siteId}/automation/vehicle-event-rules`,
        scenario.actorKeys.admin,
        ruleBody(scenario, { name: "Rollback injection" })
      );
      expect(failed.status).toBe(500);
      expect(await prisma.vehicleEventRule.count({ where: { siteId: scenario.siteId } })).toBe(0);
      expect(await prisma.vehicleEventSource.count({ where: { siteId: scenario.siteId } })).toBe(0);
      expect(await prisma.vehicleEventTarget.count({ where: { siteId: scenario.siteId } })).toBe(0);
      expect(await prisma.gatewayAutomationConfiguration.findUnique({ where: { gatewayId: scenario.gatewayId } }))
        .toBeNull();
      expect(await prisma.mqttOutbox.count({ where: { gatewayId: scenario.gatewayId } })).toBe(0);
    } finally {
      await prisma.$executeRawUnsafe(`DROP TRIGGER "${triggerName}" ON "MqttOutbox";`);
      await prisma.$executeRawUnsafe(`DROP FUNCTION "${functionName}"();`);
    }
  });

  it("uses bounded stable keyset pagination and keeps total with the page snapshot", async () => {
    const scenario = await createScenario(prisma, actors);
    const tiedAt = new Date("2026-08-30T02:00:00.000Z");
    const ids = Array.from({ length: 5 }, () => randomUUID()).sort();
    await insertDirectRules(prisma, scenario, ids.map((id, index) => ({
      id,
      name: `Tied ${index}`,
      createdAt: tiedAt
    })));

    const first = await api(
      "GET",
      `/sites/${scenario.siteId}/automation/vehicle-event-rules?limit=2`,
      scenario.actorKeys.viewer
    );
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ total: 5, nextCursor: expect.any(String) });
    expect((first.body as { items: Array<{ id: string }> }).items.map(({ id }) => id)).toEqual(ids.slice(0, 2));
    const cursor = (first.body as { nextCursor: string }).nextCursor;
    expect(decodeCursor(cursor)).toEqual({
      v: 1,
      siteId: scenario.siteId,
      createdAt: tiedAt.toISOString(),
      id: ids[1]
    });
    await prisma.vehicleEventRule.delete({ where: { id: ids[1] } });

    const second = await api(
      "GET",
      `/sites/${scenario.siteId}/automation/vehicle-event-rules?limit=2&cursor=${cursor}`,
      scenario.actorKeys.viewer
    );
    expect(second.body).toMatchObject({ total: 4, nextCursor: expect.any(String) });
    expect((second.body as { items: Array<{ id: string }> }).items.map(({ id }) => id)).toEqual(ids.slice(2, 4));
    const third = await api(
      "GET",
      `/sites/${scenario.siteId}/automation/vehicle-event-rules?limit=2&cursor=${(second.body as { nextCursor: string }).nextCursor}`,
      scenario.actorKeys.viewer
    );
    expect(third.body).toMatchObject({ total: 4, nextCursor: null });
    expect((third.body as { items: Array<{ id: string }> }).items.map(({ id }) => id)).toEqual(ids.slice(4));
    expect((await api(
      "GET",
      `/sites/${scenario.siteId}/automation/vehicle-event-rules?limit=101`,
      scenario.actorKeys.viewer
    )).status).toBe(400);
  });

  async function api(method: string, path: string, actorKey: string, body?: unknown) {
    const url = new URL(path, baseUrl);
    const payload = body === undefined ? undefined : JSON.stringify(body);
    return new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      const req = request(url, {
        method,
        headers: {
          "x-test-actor": actorKey,
          ...(payload ? { "content-type": "application/json", "content-length": Buffer.byteLength(payload) } : {})
        }
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null });
        });
      });
      req.on("error", reject);
      if (payload) req.write(payload);
      req.end();
    });
  }
});

async function createScenario(
  prisma: PrismaService,
  actors: Map<string, AuthenticatedUser>,
  sourceCapability: "supported" | "unknown" = "supported"
) {
  const suffix = randomUUID().slice(0, 8);
  const customer = await prisma.organization.create({ data: { name: `Vehicle customer ${suffix}`, type: "customer" } });
  const serviceProvider = await prisma.organization.findFirst({ where: { type: "service_provider" } })
    ?? await prisma.organization.create({ data: { name: "Vehicle test operator", type: "service_provider" } });
  const admin = await prisma.user.create({ data: {
    organizationId: customer.id,
    loginId: `vehicle_admin_${suffix}`,
    email: `vehicle-admin-${suffix}@example.com`,
    name: "Vehicle admin",
    passwordHash: "not-used",
    role: "admin"
  } });
  const viewer = await prisma.user.create({ data: {
    organizationId: customer.id,
    loginId: `vehicle_viewer_${suffix}`,
    email: `vehicle-viewer-${suffix}@example.com`,
    name: "Vehicle viewer",
    passwordHash: "not-used",
    role: "viewer"
  } });
  const operator = await prisma.user.findFirst({ where: { role: "operator" } })
    ?? await prisma.user.create({ data: {
      organizationId: serviceProvider.id,
      loginId: "vehicle_test_operator",
      email: "vehicle-test-operator@example.com",
      name: "Vehicle operator",
      passwordHash: "not-used",
      role: "operator"
    } });
  const foreignAdmin = await prisma.user.create({ data: {
    organizationId: customer.id,
    loginId: `vehicle_foreign_${suffix}`,
    email: `vehicle-foreign-${suffix}@example.com`,
    name: "Foreign vehicle admin",
    passwordHash: "not-used",
    role: "admin"
  } });
  const site = await prisma.site.create({ data: {
    organizationId: customer.id,
    adminUserId: admin.id,
    name: `Vehicle site ${suffix}`,
    timeZone: "Asia/Seoul"
  } });
  await prisma.siteMembership.create({ data: { siteId: site.id, userId: viewer.id } });
  const floor = await prisma.floor.create({ data: { siteId: site.id, name: "B1", level: -1 } });
  const gateway = await prisma.gateway.create({ data: {
    siteId: site.id,
    name: "Gateway",
    serialNumber: `VEHICLE-${suffix}`,
    firmwareVersion: "test"
  } });
  const fixtureIds: string[] = [];
  const meshNodeIds: string[] = [];
  for (const [index, meshAddress] of ["0100", "0101", "0102"].entries()) {
    const meshNode = await prisma.meshNode.create({ data: {
      gatewayId: gateway.id,
      meshAddress,
      firmwareVersion: "test"
    } });
    meshNodeIds.push(meshNode.id);
    const fixture = await prisma.fixture.create({ data: {
      floorId: floor.id,
      meshNodeId: meshNode.id,
      name: `Fixture ${index + 1}`,
      ratedWatt: 20,
      x: index * 20,
      y: 0,
      status: "online"
    } });
    fixtureIds.push(fixture.id);
  }
  if (sourceCapability === "supported") {
    await prisma.$executeRaw(Prisma.sql`
      UPDATE "MeshNode"
      SET "vehicleSensorCapabilityStatus" = 'supported',
          "vehicleSensorCapabilityVerifiedAt" = CURRENT_TIMESTAMP,
          "vehicleSensorCapabilityRevision" = 1,
          "vehicleSensorServerBound" = true,
          "vehicleVendorEventModelBound" = true
      WHERE "id" IN (${Prisma.join(meshNodeIds.slice(0, 2))})
    `);
  }

  const actorKeys = {
    admin: `vehicle-admin-${suffix}`,
    viewer: `vehicle-viewer-${suffix}`,
    operator: `vehicle-operator-${suffix}`,
    foreignAdmin: `vehicle-foreign-admin-${suffix}`
  };
  actors.set(actorKeys.admin, actor(admin, customer.id, "customer"));
  actors.set(actorKeys.viewer, actor(viewer, customer.id, "customer"));
  actors.set(actorKeys.operator, actor(operator, operator.organizationId, "service_provider"));
  actors.set(actorKeys.foreignAdmin, actor(foreignAdmin, customer.id, "customer"));
  return {
    siteId: site.id,
    gatewayId: gateway.id,
    floorId: floor.id,
    adminId: admin.id,
    fixtureIds,
    meshNodeIds,
    actorKeys
  };
}

async function insertDirectRules(
  prisma: PrismaService,
  scenario: Scenario,
  rules: Array<{ id: string; name: string; createdAt: Date }>
) {
  await prisma.$transaction(async (tx) => {
    await tx.$executeRaw(Prisma.sql`SELECT "lock_automation_membership_mutation"()`);
    for (const rule of rules) {
      await tx.vehicleEventRule.create({ data: {
        id: rule.id,
        siteId: scenario.siteId,
        gatewayId: scenario.gatewayId,
        name: rule.name,
        status: "disabled",
        dimmingEnabled: true,
        brightnessPercent: 70,
        holdSeconds: 60,
        createdById: scenario.adminId,
        updatedById: scenario.adminId,
        createdAt: rule.createdAt,
        updatedAt: rule.createdAt
      } });
      await tx.vehicleEventSource.create({ data: {
        ruleId: rule.id,
        fixtureId: scenario.fixtureIds[0],
        siteId: scenario.siteId,
        gatewayId: scenario.gatewayId
      } });
      await tx.vehicleEventTarget.create({ data: {
        ruleId: rule.id,
        fixtureId: scenario.fixtureIds[1],
        siteId: scenario.siteId,
        gatewayId: scenario.gatewayId
      } });
    }
  });
}

type Scenario = Awaited<ReturnType<typeof createScenario>>;

function ruleBody(scenario: Scenario, overrides: Record<string, unknown> = {}) {
  return {
    name: "Garage entry",
    status: "enabled",
    sourceFixtureIds: [scenario.fixtureIds[0]],
    targetFixtureIds: [scenario.fixtureIds[1]],
    action: { dimmingEnabled: true, brightnessPercent: 70 },
    holdSeconds: 60,
    ...overrides
  };
}

function scheduleBody(fixtureIds: string[], overrides: Record<string, unknown> = {}) {
  return {
    name: "Vehicle companion schedule",
    status: "enabled",
    activeFrom: "2026-09-01T00:00:00.000Z",
    activeUntil: "2026-09-30T00:00:00.000Z",
    localStartTime: "09:00",
    localEndTime: "10:00",
    recurrence: {
      kind: "daily",
      weeklyDays: [],
      monthlyDay: null,
      yearlyMonth: null,
      yearlyDay: null
    },
    action: { dimmingEnabled: true, brightnessPercent: 40 },
    target: { type: "fixtures", fixtureIds },
    ...overrides
  };
}

function capabilityReport(
  scenario: Pick<Scenario, "siteId" | "gatewayId">,
  meshNodeId: string,
  status: "supported" | "unsupported",
  capabilityRevision: number
): VehicleSensorCapabilityReportV1 {
  return {
    schemaVersion: 1,
    eventId: randomUUID(),
    siteId: scenario.siteId,
    gatewayId: scenario.gatewayId,
    meshNodeId,
    capabilityRevision,
    status,
    verifiedAt: "2026-08-30T01:02:03.456Z",
    sensorServerBound: status === "supported",
    vendorVehicleEventModelBound: status === "supported"
  };
}

function capabilityAckKey(report: VehicleSensorCapabilityReportV1) {
  return `vehicle-sensor-capability:${report.gatewayId}:${report.meshNodeId}:${report.eventId}:${canonicalPayloadHash(report)}`;
}

function executionData(
  scenario: Scenario,
  ruleId: string,
  sequence: number,
  kind: "vehicle_detected" | "event_started" | "action_result",
  occurredAt: string
) {
  return {
    siteId: scenario.siteId,
    gatewayId: scenario.gatewayId,
    eventId: randomUUID(),
    sequence,
    revision: 1,
    ruleId,
    vehicleEventRuleId: ruleId,
    kind,
    occurredAt: new Date(occurredAt),
    payload: { result: kind }
  };
}

function decodeCursor(cursor: string) {
  return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as {
    v: number;
    siteId: string;
    createdAt: string;
    id: string;
  };
}

function actor(
  user: { id: string; loginId: string; name: string; role: "operator" | "admin" | "viewer"; status: "active" | "disabled" },
  organizationId: string,
  organizationType: "service_provider" | "customer"
): AuthenticatedUser {
  return { ...user, organizationId, organizationType };
}
