import { BadRequestException } from "@nestjs/common";
import type { VehicleSensorCapabilityReportV1 } from "@led-control/shared";
import { createHash } from "node:crypto";
import { VehicleSensorCapabilityService } from "./vehicle-sensor-capability.service";

const SITE_ID = "00000000-0000-4000-8000-000000000001";
const GATEWAY_ID = "00000000-0000-4000-8000-000000000002";
const NODE_ID = "00000000-0000-4000-8000-000000000003";
const FIXTURE_ID = "00000000-0000-4000-8000-000000000004";
const RULE_A_ID = "00000000-0000-4000-8000-000000000005";
const RULE_B_ID = "00000000-0000-4000-8000-000000000006";
const EVENT_ID = "00000000-0000-4000-8000-000000000007";
const VERIFIED_AT = "2026-08-30T00:00:00.000Z";
const INGESTED_AT = new Date("2026-08-30T00:01:00.000Z");
const FIRST_INGESTED_AT = "2026-08-30T00:00:30.000Z";
const CAPABILITY_EVENT_TYPE = "vehicle_sensor_capability";
const APPLICATION_ACK_KEY = `vehicle-sensor-capability:${GATEWAY_ID}:${EVENT_ID}`;
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
  ruleIds?: string[];
} = {}) {
  const calls: string[] = [];
  let storedAck = options.storedAck
    ? { payload: options.storedAck, payloadHash: canonicalHash(options.storedAck) }
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
      upsert: jest.fn().mockImplementation(({ create, update }: {
        create: { payload: ReturnType<typeof acknowledgement>; payloadHash: string };
        update: Partial<{ payload: ReturnType<typeof acknowledgement>; payloadHash: string }>;
      }) => {
        calls.push("ack");
        storedAck = storedAck
          ? { ...storedAck, ...update }
          : { payload: create.payload, payloadHash: create.payloadHash };
        return Promise.resolve(storedAck);
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
    expect(tx.mqttOutbox.upsert).toHaveBeenCalledWith({
      where: { applicationAckKey: APPLICATION_ACK_KEY },
      create: {
        gatewayId: GATEWAY_ID,
        applicationAckKey: APPLICATION_ACK_KEY,
        revision: null,
        payloadHash: canonicalHash(appliedAck),
        topic: APPLICATION_ACK_TOPIC,
        payload: appliedAck
      },
      update: {}
    });
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
    expect(tx.mqttOutbox.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { applicationAckKey: APPLICATION_ACK_KEY },
      update: {}
    }));
  });

  it("rejects a conflicting eventId or capability revision without mutation", async () => {
    const input = report();
    const conflict = processedEvent(input, `sha256:${"f".repeat(64)}`);
    const firstAck = acknowledgement(input, "applied", null, FIRST_INGESTED_AT);
    const { service, tx, automationSnapshot } = testContext({
      eventById: conflict,
      storedAck: firstAck
    });

    await expect(service.applyReport(input)).resolves.toEqual({
      schemaVersion: 1,
      eventId: EVENT_ID,
      gatewayId: GATEWAY_ID,
      meshNodeId: NODE_ID,
      capabilityRevision: 7,
      status: "rejected",
      errorCode: "capability_event_conflict",
      ingestedAt: FIRST_INGESTED_AT
    });
    expect(tx.meshNode.update).not.toHaveBeenCalled();
    expect(tx.processedGatewayEvent.create).not.toHaveBeenCalled();
    expect(automationSnapshot.incrementDesiredRevision).not.toHaveBeenCalled();
    expect(tx.mqttOutbox.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({
        payload: expect.objectContaining({
          status: "rejected",
          errorCode: "capability_event_conflict",
          ingestedAt: FIRST_INGESTED_AT
        })
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
    expect(tx.mqttOutbox.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
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
