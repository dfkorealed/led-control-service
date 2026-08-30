import { BadRequestException } from "@nestjs/common";
import type { VehicleSensorCapabilityReportV1 } from "@led-control/shared";
import { createHash } from "node:crypto";
import { VehicleSensorCapabilityService } from "./vehicle-sensor-capability.service";

const SITE_ID = "00000000-0000-4000-8000-000000000001";
const GATEWAY_ID = "00000000-0000-4000-8000-000000000002";
const NODE_ID = "00000000-0000-4000-8000-000000000003";
const NODE_B_ID = "00000000-0000-4000-8000-000000000008";
const FIXTURE_ID = "00000000-0000-4000-8000-000000000004";
const RULE_A_ID = "00000000-0000-4000-8000-000000000005";
const RULE_B_ID = "00000000-0000-4000-8000-000000000006";
const EVENT_ID = "00000000-0000-4000-8000-000000000007";
const VERIFIED_AT = "2026-08-30T00:00:00.000Z";
const INGESTED_AT = new Date("2026-08-30T00:01:00.000Z");
const FIRST_INGESTED_AT = "2026-08-30T00:00:30.000Z";
const CAPABILITY_EVENT_TYPE = "vehicle_sensor_capability";
const REPORT_PAYLOAD_HASH = capabilityHash(report());
const APPLICATION_ACK_KEY =
  `vehicle-sensor-capability:${GATEWAY_ID}:${NODE_ID}:${EVENT_ID}:${REPORT_PAYLOAD_HASH}`;
const APPLICATION_ACK_TOPIC =
  `sites/${SITE_ID}/gateways/${GATEWAY_ID}/acks/automation/vehicle-sensor-capability-ingested`;

interface ScopeRow {
  id: string;
  vehicleSensorCapabilityStatus: "unknown" | "supported" | "unsupported";
  vehicleSensorCapabilityVerifiedAt: Date | null;
  vehicleSensorCapabilityRevision: bigint;
  vehicleSensorServerBound: boolean;
  vehicleVendorEventModelBound: boolean;
  fixtureId: string | null;
}

type CapabilityServiceConstructor = new (
  prisma: never,
  automationSnapshot: never,
  clock: never
) => VehicleSensorCapabilityService;

function report(overrides: Partial<VehicleSensorCapabilityReportV1> = {}): VehicleSensorCapabilityReportV1 {
  return {
    schemaVersion: 1,
    eventId: EVENT_ID,
    siteId: SITE_ID,
    gatewayId: GATEWAY_ID,
    meshNodeId: NODE_ID,
    capabilityRevision: 7,
    status: "supported",
    verifiedAt: VERIFIED_AT,
    sensorServerBound: true,
    vendorVehicleEventModelBound: true,
    ...overrides
  };
}

function defaultScopeRow(): ScopeRow {
  return {
    id: NODE_ID,
    vehicleSensorCapabilityStatus: "unknown",
    vehicleSensorCapabilityVerifiedAt: null,
    vehicleSensorCapabilityRevision: 0n,
    vehicleSensorServerBound: false,
    vehicleVendorEventModelBound: false,
    fixtureId: FIXTURE_ID
  };
}

function scopeRow(overrides: Partial<ReturnType<typeof defaultScopeRow>> = {}) {
  return { ...defaultScopeRow(), ...overrides };
}

function processedEvent(input: VehicleSensorCapabilityReportV1, payloadHash = capabilityHash(input)) {
  return {
    eventId: input.eventId,
    gatewayId: input.gatewayId,
    meshNodeId: input.meshNodeId,
    fixtureId: FIXTURE_ID,
    sequence: BigInt(input.capabilityRevision),
    eventType: CAPABILITY_EVENT_TYPE,
    payloadHash,
    occurredAt: new Date(input.verifiedAt)
  };
}

function acknowledgement(
  input: VehicleSensorCapabilityReportV1,
  status: "applied" | "stale" | "duplicate" | "rejected",
  errorCode: string | null,
  ingestedAt = INGESTED_AT.toISOString()
) {
  return {
    schemaVersion: 1 as const,
    eventId: input.eventId,
    gatewayId: input.gatewayId,
    meshNodeId: input.meshNodeId,
    capabilityRevision: input.capabilityRevision,
    reportPayloadHash: capabilityHash(input),
    status,
    errorCode,
    ingestedAt
  };
}

function testContext(options: {
  node?: ReturnType<typeof defaultScopeRow> | null;
  eventById?: ReturnType<typeof processedEvent> | null;
  eventByRevision?: ReturnType<typeof processedEvent> | null;
  storedAck?: ReturnType<typeof acknowledgement> | null;
  storedOutbox?: Partial<{
    attempts: number;
    nextAttemptAt: Date;
    publishedAt: Date | null;
    lockedBy: string | null;
    lockedAt: Date | null;
    leaseExpiresAt: Date | null;
    deadLetteredAt: Date | null;
    lastError: string | null;
  }>;
  revivalUpdateCount?: number;
  ruleIds?: string[];
} = {}) {
  const calls: string[] = [];
  let storedAck = options.storedAck
    ? {
      id: "ack-outbox-1",
      payload: options.storedAck,
      payloadHash: canonicalHash(options.storedAck),
      attempts: 0,
      nextAttemptAt: INGESTED_AT,
      publishedAt: null,
      lockedBy: null,
      lockedAt: null,
      leaseExpiresAt: null,
      deadLetteredAt: null,
      lastError: null,
      ...options.storedOutbox
    }
    : null;
  const tx = {
    $queryRaw: jest.fn().mockImplementation(() => {
      calls.push("scope");
      return Promise.resolve(options.node === null ? [] : [options.node ?? scopeRow()]);
    }),
    meshNode: {
      update: jest.fn().mockImplementation(() => {
        calls.push("metadata");
        return Promise.resolve({});
      })
    },
    processedGatewayEvent: {
      findUnique: jest.fn().mockImplementation(({ where }: { where: Record<string, unknown> }) => {
        if (!("eventId" in where)) throw new Error("capability revision lookup must be node-scoped");
        calls.push("event-id");
        return Promise.resolve(options.eventById ?? null);
      }),
      findFirst: jest.fn().mockImplementation(() => {
        calls.push("revision-id");
        return Promise.resolve(options.eventByRevision ?? null);
      }),
      create: jest.fn().mockImplementation(() => {
        calls.push("ledger");
        return Promise.resolve({});
      })
    },
    mqttOutbox: {
      findUnique: jest.fn().mockImplementation(() => {
        calls.push("ack-read");
        return Promise.resolve(storedAck);
      }),
      create: jest.fn().mockImplementation(({ data }: {
        data: { payload: ReturnType<typeof acknowledgement>; payloadHash: string };
      }) => {
        calls.push("ack");
        storedAck = {
          id: "ack-outbox-1",
          attempts: 0,
          nextAttemptAt: INGESTED_AT,
          publishedAt: null,
          lockedBy: null,
          lockedAt: null,
          leaseExpiresAt: null,
          deadLetteredAt: null,
          lastError: null,
          ...data
        };
        return Promise.resolve(storedAck);
      }),
      updateMany: jest.fn().mockImplementation(({ data }: {
        data: Partial<NonNullable<typeof storedAck>>;
      }) => {
        calls.push("ack-revive");
        const count = options.revivalUpdateCount ?? 0;
        if (count === 1 && storedAck) storedAck = { ...storedAck, ...data };
        return Promise.resolve({ count });
      })
    },
    vehicleEventRule: {
      findMany: jest.fn().mockResolvedValue((options.ruleIds ?? []).map((id) => ({ id }))),
      updateMany: jest.fn().mockImplementation(() => {
        calls.push("disable");
        return Promise.resolve({ count: options.ruleIds?.length ?? 0 });
      })
    }
  };
  const automationSnapshot = {
    lockMutation: jest.fn().mockImplementation(() => {
      calls.push("lock");
      return Promise.resolve();
    }),
    incrementDesiredRevision: jest.fn().mockImplementation(() => {
      calls.push("snapshot");
      return Promise.resolve({ desiredRevision: 9, appliedRevision: 4, syncStatus: "PENDING" });
    })
  };
  const Service = VehicleSensorCapabilityService as unknown as CapabilityServiceConstructor;
  const service = new Service(
    { $transaction: jest.fn((callback) => callback(tx)) } as never,
    automationSnapshot as never,
    { now: () => INGESTED_AT } as never
  );
  return { service, tx, automationSnapshot, calls };
}

describe("VehicleSensorCapabilityService", () => {
  it("rejects a malformed report before opening a transaction", async () => {
    const prisma = { $transaction: jest.fn() };
    const Service = VehicleSensorCapabilityService as unknown as CapabilityServiceConstructor;
    const service = new Service(prisma as never, {} as never, {} as never);

    await expect(service.applyReport({ ...report(), capabilityRevision: 0 }))
      .rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("locks the active claimed inventory identity inside authenticated MQTT ingestion", async () => {
    const { service, tx } = testContext();

    await service.applyReport(report(), {
      siteId: SITE_ID,
      gatewayId: GATEWAY_ID,
      requireActiveClaim: true
    });

    const sql = tx.$queryRaw.mock.calls[0][0].strings.join(" ");
    expect(sql).toContain('INNER JOIN "GatewayInventory" AS inventory');
    expect(sql).toContain('certificate."purpose" = \'mqtt\'');
    expect(sql).toContain('certificate."status" = \'active\'');
    expect(sql).toContain("FOR UPDATE OF node, gateway, inventory");
  });

  it("acquires the automation lock before rejecting a forged scope without identifiers", async () => {
    const { service, tx, calls } = testContext({ node: null });
    const forged = report({ siteId: "00000000-0000-4000-8000-000000000099" });

    const error: unknown = await service.applyReport(forged).catch((caught: unknown) => caught);

    expect(calls).toEqual(["lock", "scope"]);
    expect(error).toBeInstanceOf(BadRequestException);
    const response = (error as BadRequestException).getResponse();
    expect(JSON.stringify(response)).not.toContain(forged.siteId);
    expect(JSON.stringify(response)).not.toContain(NODE_ID);
    expect(tx.processedGatewayEvent.findUnique).not.toHaveBeenCalled();
  });

  it("applies a higher supported revision and stores the canonical complete-report hash", async () => {
    const input = report();
    const { service, tx, automationSnapshot, calls } = testContext();

    await expect(service.applyReport(input)).resolves.toEqual({
      schemaVersion: 1,
      eventId: EVENT_ID,
      gatewayId: GATEWAY_ID,
      meshNodeId: NODE_ID,
      capabilityRevision: 7,
      reportPayloadHash: REPORT_PAYLOAD_HASH,
      status: "applied",
      errorCode: null,
      ingestedAt: INGESTED_AT.toISOString()
    });
    expect(tx.meshNode.update).toHaveBeenCalledWith({
      where: { id: NODE_ID },
      data: {
        vehicleSensorCapabilityStatus: "supported",
        vehicleSensorCapabilityVerifiedAt: new Date(VERIFIED_AT),
        vehicleSensorCapabilityRevision: 7n,
        vehicleSensorServerBound: true,
        vehicleVendorEventModelBound: true
      }
    });
    expect(tx.processedGatewayEvent.create).toHaveBeenCalledWith({
      data: {
        eventId: EVENT_ID,
        gatewayId: GATEWAY_ID,
        meshNodeId: NODE_ID,
        fixtureId: FIXTURE_ID,
        sequence: 7n,
        eventType: CAPABILITY_EVENT_TYPE,
        payloadHash: capabilityHash(input),
        occurredAt: new Date(VERIFIED_AT)
      }
    });
    const appliedAck = acknowledgement(input, "applied", null);
    expect(tx.mqttOutbox.create).toHaveBeenCalledWith({
      data: {
        gatewayId: GATEWAY_ID,
        applicationAckKey: APPLICATION_ACK_KEY,
        revision: null,
        payloadHash: canonicalHash(appliedAck),
        topic: APPLICATION_ACK_TOPIC,
        payload: appliedAck
      }
    });
    expect(APPLICATION_ACK_KEY.length).toBeLessThanOrEqual(255);
    expect(automationSnapshot.incrementDesiredRevision).not.toHaveBeenCalled();
    expect(calls).toEqual([
      "lock",
      "scope",
      "event-id",
      "revision-id",
      "metadata",
      "ledger",
      "ack-read",
      "ack"
    ]);
  });

  it("reuses the first durable ACK payload and timestamp for an exact redelivery", async () => {
    const input = report();
    const firstAck = acknowledgement(input, "applied", null, FIRST_INGESTED_AT);
    const { service, tx } = testContext({
      eventByRevision: processedEvent(input),
      storedAck: firstAck
    });

    await expect(service.applyReport(input)).resolves.toEqual(firstAck);
    expect(tx.meshNode.update).not.toHaveBeenCalled();
    expect(tx.processedGatewayEvent.create).not.toHaveBeenCalled();
    expect(tx.mqttOutbox.updateMany).toHaveBeenCalledWith({
      where: {
        id: "ack-outbox-1",
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: INGESTED_AT } }],
        AND: [{
          OR: [
            { publishedAt: { not: null } },
            { deadLetteredAt: { not: null } },
            { leaseExpiresAt: { lte: INGESTED_AT } }
          ]
        }]
      },
      data: {
        attempts: 0,
        nextAttemptAt: INGESTED_AT,
        publishedAt: null,
        lockedBy: null,
        lockedAt: null,
        leaseExpiresAt: null,
        deadLetteredAt: null,
        lastError: null
      }
    });
  });

  it("stores a cross-node eventId conflict under the incoming node ACK key without mutation", async () => {
    const original = report();
    const input = report({ meshNodeId: NODE_B_ID });
    const conflict = processedEvent(original);
    const { service, tx, automationSnapshot } = testContext({
      eventById: conflict,
      node: scopeRow({ id: NODE_B_ID, fixtureId: null })
    });

    await expect(service.applyReport(input)).resolves.toEqual({
      schemaVersion: 1,
      eventId: EVENT_ID,
      gatewayId: GATEWAY_ID,
      meshNodeId: NODE_B_ID,
      capabilityRevision: 7,
      reportPayloadHash: capabilityHash(input),
      status: "rejected",
      errorCode: "capability_event_conflict",
      ingestedAt: INGESTED_AT.toISOString()
    });
    expect(tx.meshNode.update).not.toHaveBeenCalled();
    expect(tx.processedGatewayEvent.create).not.toHaveBeenCalled();
    expect(automationSnapshot.incrementDesiredRevision).not.toHaveBeenCalled();
    expect(tx.mqttOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        applicationAckKey:
          `vehicle-sensor-capability:${GATEWAY_ID}:${NODE_B_ID}:${EVENT_ID}:${capabilityHash(input)}`,
        payload: expect.objectContaining({
          meshNodeId: NODE_B_ID,
          reportPayloadHash: capabilityHash(input),
          status: "rejected",
          errorCode: "capability_event_conflict",
          ingestedAt: INGESTED_AT.toISOString()
        })
      })
    });
  });

  it("stores a same-node altered report conflict under its own report-hash ACK key", async () => {
    const original = report();
    const altered = report({
      status: "unsupported",
      sensorServerBound: false,
      vendorVehicleEventModelBound: false
    });
    const { service, tx, automationSnapshot } = testContext({
      eventById: processedEvent(original),
      eventByRevision: processedEvent(original),
      node: scopeRow({
        vehicleSensorCapabilityStatus: "supported",
        vehicleSensorCapabilityVerifiedAt: new Date(VERIFIED_AT),
        vehicleSensorCapabilityRevision: 7n,
        vehicleSensorServerBound: true,
        vehicleVendorEventModelBound: true
      })
    });

    await expect(service.applyReport(altered)).resolves.toEqual(
      acknowledgement(altered, "rejected", "capability_event_conflict")
    );
    expect(tx.mqttOutbox.findUnique).toHaveBeenCalledWith({
      where: {
        applicationAckKey:
          `vehicle-sensor-capability:${GATEWAY_ID}:${NODE_ID}:${EVENT_ID}:${capabilityHash(altered)}`
      }
    });
    expect(tx.mqttOutbox.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        applicationAckKey:
          `vehicle-sensor-capability:${GATEWAY_ID}:${NODE_ID}:${EVENT_ID}:${capabilityHash(altered)}`,
        payload: acknowledgement(altered, "rejected", "capability_event_conflict")
      })
    });
    expect(capabilityHash(altered)).not.toBe(capabilityHash(original));
    expect(tx.meshNode.update).not.toHaveBeenCalled();
    expect(tx.processedGatewayEvent.create).not.toHaveBeenCalled();
    expect(automationSnapshot.incrementDesiredRevision).not.toHaveBeenCalled();
  });

  it.each([
    ["published", { publishedAt: new Date("2026-08-30T00:00:40.000Z") }],
    ["dead-lettered", { deadLetteredAt: new Date("2026-08-30T00:00:50.000Z") }]
  ])("revives a %s exact ACK without replacing its first payload", async (_label, storedOutbox) => {
    const input = report();
    const firstAck = acknowledgement(input, "applied", null, FIRST_INGESTED_AT);
    const { service, tx } = testContext({
      eventByRevision: processedEvent(input),
      storedAck: firstAck,
      storedOutbox: {
        attempts: 9,
        nextAttemptAt: new Date("2026-08-30T02:00:00.000Z"),
        lastError: "publish failed",
        ...storedOutbox
      },
      revivalUpdateCount: 1
    });

    await expect(service.applyReport(input)).resolves.toEqual(firstAck);
    expect(tx.mqttOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        attempts: 0,
        nextAttemptAt: INGESTED_AT,
        publishedAt: null,
        deadLetteredAt: null,
        lastError: null
      })
    }));
    const resetData = tx.mqttOutbox.updateMany.mock.calls[0][0].data;
    expect(resetData).not.toHaveProperty("payload");
    expect(resetData).not.toHaveProperty("payloadHash");
  });

  it("does not steal a live ACK publisher lease", async () => {
    const input = report();
    const firstAck = acknowledgement(input, "applied", null, FIRST_INGESTED_AT);
    const { service, tx } = testContext({
      eventByRevision: processedEvent(input),
      storedAck: firstAck,
      storedOutbox: {
        attempts: 3,
        publishedAt: new Date("2026-08-30T00:00:40.000Z"),
        lockedBy: "active-publisher",
        lockedAt: new Date("2026-08-30T00:00:50.000Z"),
        leaseExpiresAt: new Date("2026-08-30T00:01:30.000Z"),
        lastError: "pending publisher completion"
      },
      revivalUpdateCount: 0
    });

    await expect(service.applyReport(input)).resolves.toEqual(firstAck);
    expect(tx.mqttOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [{ leaseExpiresAt: null }, { leaseExpiresAt: { lte: INGESTED_AT } }]
      })
    }));
  });

  it("revives an expired ACK publisher lease", async () => {
    const input = report();
    const firstAck = acknowledgement(input, "applied", null, FIRST_INGESTED_AT);
    const { service, tx } = testContext({
      eventByRevision: processedEvent(input),
      storedAck: firstAck,
      storedOutbox: {
        attempts: 3,
        nextAttemptAt: new Date("2026-08-30T02:00:00.000Z"),
        lockedBy: "expired-publisher",
        lockedAt: new Date("2026-08-30T00:00:10.000Z"),
        leaseExpiresAt: new Date("2026-08-30T00:00:59.999Z"),
        lastError: "publisher crashed"
      },
      revivalUpdateCount: 1
    });

    await expect(service.applyReport(input)).resolves.toEqual(firstAck);
    expect(tx.mqttOutbox.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        attempts: 0,
        nextAttemptAt: INGESTED_AT,
        lockedBy: null,
        lockedAt: null,
        leaseExpiresAt: null,
        lastError: null
      })
    }));
  });

  it("rejects a different event that collides with the same node capability revision", async () => {
    const input = report();
    const occupyingReport = report({ eventId: "00000000-0000-4000-8000-000000000099" });
    const { service, tx, automationSnapshot } = testContext({
      eventByRevision: processedEvent(occupyingReport)
    });

    await expect(service.applyReport(input)).resolves.toMatchObject({
      status: "rejected",
      errorCode: "capability_event_conflict"
    });
    expect(tx.meshNode.update).not.toHaveBeenCalled();
    expect(tx.processedGatewayEvent.create).not.toHaveBeenCalled();
    expect(automationSnapshot.incrementDesiredRevision).not.toHaveBeenCalled();
  });

  it("persists a lower revision as stale without changing node or automation state", async () => {
    const input = report({ capabilityRevision: 6 });
    const { service, tx, automationSnapshot } = testContext({
      node: scopeRow({
        vehicleSensorCapabilityStatus: "supported",
        vehicleSensorCapabilityVerifiedAt: new Date(VERIFIED_AT),
        vehicleSensorCapabilityRevision: 9n,
        vehicleSensorServerBound: true,
        vehicleVendorEventModelBound: true
      })
    });

    await expect(service.applyReport(input)).resolves.toMatchObject({
      capabilityRevision: 6,
      status: "stale",
      errorCode: null
    });
    expect(tx.processedGatewayEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        meshNodeId: NODE_ID,
        sequence: 6n,
        payloadHash: capabilityHash(input)
      })
    });
    expect(tx.meshNode.update).not.toHaveBeenCalled();
    expect(automationSnapshot.incrementDesiredRevision).not.toHaveBeenCalled();
  });

  it("reconciles an exact ledger-free migration baseline as duplicate", async () => {
    const input = report();
    const { service, tx } = testContext({
      node: scopeRow({
        vehicleSensorCapabilityStatus: "supported",
        vehicleSensorCapabilityVerifiedAt: new Date(VERIFIED_AT),
        vehicleSensorCapabilityRevision: 7n,
        vehicleSensorServerBound: true,
        vehicleVendorEventModelBound: true
      })
    });

    await expect(service.applyReport(input)).resolves.toMatchObject({
      status: "duplicate",
      errorCode: null
    });
    expect(tx.processedGatewayEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        eventId: EVENT_ID,
        meshNodeId: NODE_ID,
        sequence: 7n,
        payloadHash: capabilityHash(input)
      })
    });
    expect(tx.meshNode.update).not.toHaveBeenCalled();
  });

  it("rejects a ledger-free equal revision when migrated state differs", async () => {
    const input = report();
    const { service, tx } = testContext({
      node: scopeRow({
        vehicleSensorCapabilityStatus: "unsupported",
        vehicleSensorCapabilityVerifiedAt: new Date(VERIFIED_AT),
        vehicleSensorCapabilityRevision: 7n,
        vehicleSensorServerBound: false,
        vehicleVendorEventModelBound: true
      })
    });

    await expect(service.applyReport(input)).resolves.toMatchObject({
      status: "rejected",
      errorCode: "capability_state_conflict"
    });
    expect(tx.processedGatewayEvent.create).not.toHaveBeenCalled();
    expect(tx.meshNode.update).not.toHaveBeenCalled();
  });

  it("disables every enabled source rule, snapshots once, then stores a higher unsupported revision", async () => {
    const input = report({
      capabilityRevision: 8,
      status: "unsupported",
      sensorServerBound: false
    });
    const { service, tx, automationSnapshot, calls } = testContext({
      node: scopeRow({
        vehicleSensorCapabilityStatus: "supported",
        vehicleSensorCapabilityVerifiedAt: new Date(VERIFIED_AT),
        vehicleSensorCapabilityRevision: 7n,
        vehicleSensorServerBound: true,
        vehicleVendorEventModelBound: true
      }),
      ruleIds: [RULE_B_ID, RULE_A_ID]
    });

    await expect(service.applyReport(input)).resolves.toMatchObject({
      capabilityRevision: 8,
      status: "applied",
      errorCode: null
    });
    expect(tx.vehicleEventRule.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [RULE_A_ID, RULE_B_ID] }, status: "enabled" },
      data: { status: "disabled" }
    });
    expect(automationSnapshot.incrementDesiredRevision).toHaveBeenCalledTimes(1);
    expect(automationSnapshot.incrementDesiredRevision).toHaveBeenCalledWith(tx, GATEWAY_ID);
    expect(tx.meshNode.update).toHaveBeenCalledWith({
      where: { id: NODE_ID },
      data: {
        vehicleSensorCapabilityStatus: "unsupported",
        vehicleSensorCapabilityVerifiedAt: new Date(VERIFIED_AT),
        vehicleSensorCapabilityRevision: 8n,
        vehicleSensorServerBound: false,
        vehicleVendorEventModelBound: true
      }
    });
    expect(calls).toEqual([
      "lock",
      "scope",
      "event-id",
      "revision-id",
      "disable",
      "snapshot",
      "metadata",
      "ledger",
      "ack-read",
      "ack"
    ]);
  });

  it("stores Number.MAX_SAFE_INTEGER in the BigInt ledger while ACK revision stays JSON-safe", async () => {
    const input = report({ capabilityRevision: Number.MAX_SAFE_INTEGER });
    const { service, tx } = testContext();

    await expect(service.applyReport(input)).resolves.toMatchObject({
      capabilityRevision: Number.MAX_SAFE_INTEGER,
      status: "applied"
    });
    expect(tx.processedGatewayEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ sequence: BigInt(Number.MAX_SAFE_INTEGER) })
    });
    expect(tx.mqttOutbox.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        revision: null,
        payload: expect.objectContaining({ capabilityRevision: Number.MAX_SAFE_INTEGER })
      })
    }));
  });
});

function capabilityHash(value: VehicleSensorCapabilityReportV1) {
  return canonicalHash(value);
}

function canonicalHash(value: unknown) {
  return `sha256:${createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex")}`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)])
  );
}
