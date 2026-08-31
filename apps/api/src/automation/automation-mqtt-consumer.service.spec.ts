import { canonicalPayloadHash } from "./automation-payload-hash";
import { AutomationMqttConsumerService } from "./automation-mqtt-consumer.service";

const SITE_ID = "00000000-0000-4000-8000-000000000001";
const OTHER_SITE_ID = "00000000-0000-4000-8000-000000000002";
const GATEWAY_ID = "00000000-0000-4000-8000-000000000003";
const OTHER_GATEWAY_ID = "00000000-0000-4000-8000-000000000004";
const RULE_ID = "00000000-0000-4000-8000-000000000005";
const FIXTURE_ID = "00000000-0000-4000-8000-000000000006";
const FIXTURE_ID_2 = "00000000-0000-4000-8000-000000000009";
const EVENT_ID = "00000000-0000-4000-8000-000000000007";
const MESH_NODE_ID = "00000000-0000-4000-8000-000000000008";
const COMMAND_ID = "00000000-0000-4000-8000-000000000010";
const MANUAL_OVERRIDE_ID = "00000000-0000-4000-8000-000000000011";
const NOW = new Date("2026-08-30T01:00:00.000Z");

describe("AutomationMqttConsumerService", () => {
  it("routes only exact automation topics and binds capability topic IDs to the strict payload", async () => {
    const harness = createHarness();
    const report = capabilityReport();

    await harness.service.handleMessage(
      `sites/${OTHER_SITE_ID}/gateways/${GATEWAY_ID}/events/automation/vehicle-sensor-capability`,
      Buffer.from(JSON.stringify(report))
    );
    await harness.service.handleMessage(
      `prefix/sites/${SITE_ID}/gateways/${GATEWAY_ID}/events/automation/vehicle-sensor-capability`,
      Buffer.from(JSON.stringify(report))
    );
    expect(harness.capability.applyReport).not.toHaveBeenCalled();

    await harness.service.handleMessage(
      `sites/${SITE_ID}/gateways/${GATEWAY_ID}/events/automation/vehicle-sensor-capability`,
      Buffer.from(JSON.stringify(report))
    );

    expect(harness.capability.applyReport).toHaveBeenCalledWith(report, {
      siteId: SITE_ID,
      gatewayId: GATEWAY_ID,
      requireActiveClaim: true
    });
  });

  it("ignores an unknown, reassigned, or inactive claimed Gateway without mutating state or creating an ACK", async () => {
    const harness = createHarness();
    harness.state.identityActive = false;

    await harness.service.handleMessage(
      `sites/${SITE_ID}/gateways/${GATEWAY_ID}/events/automation/execution`,
      Buffer.from(JSON.stringify(executionEvent()))
    );
    await harness.service.onConfigApplied(
      { siteId: SITE_ID, gatewayId: GATEWAY_ID },
      configAck(5, "applied", snapshot(5).payloadHash)
    );

    expect(harness.state.executions).toEqual([]);
    expect(harness.state.applicationAcks).toEqual([]);
    expect(harness.state.configuration).toMatchObject({ appliedRevision: 2, syncStatus: "PENDING" });
  });

  it("advances applied revisions monotonically and derives sync state from the current desired revision", async () => {
    const harness = createHarness();

    await harness.service.onConfigApplied(
      { siteId: SITE_ID, gatewayId: GATEWAY_ID },
      configAck(4, "applied", snapshot(4).payloadHash)
    );
    expect(harness.state.configuration).toMatchObject({
      appliedRevision: 4,
      syncStatus: "PENDING",
      lastErrorCode: null
    });

    await harness.service.onConfigApplied(
      { siteId: SITE_ID, gatewayId: GATEWAY_ID },
      configAck(3, "applied", snapshot(3).payloadHash)
    );
    expect(harness.state.configuration.appliedRevision).toBe(4);

    await harness.service.onConfigApplied(
      { siteId: SITE_ID, gatewayId: GATEWAY_ID },
      configAck(5, "applied", snapshot(5).payloadHash)
    );
    expect(harness.state.configuration).toMatchObject({ appliedRevision: 5, syncStatus: "APPLIED" });
  });

  it("rejects future or hash-mismatched config ACKs and lets only the exact desired rejection set a sanitized error", async () => {
    const harness = createHarness();

    await harness.service.onConfigApplied(
      { siteId: SITE_ID, gatewayId: GATEWAY_ID },
      configAck(6, "applied", snapshot(5).payloadHash)
    );
    await harness.service.onConfigApplied(
      { siteId: SITE_ID, gatewayId: GATEWAY_ID },
      configAck(5, "applied", `sha256:${"f".repeat(64)}`)
    );
    await harness.service.onConfigApplied(
      { siteId: SITE_ID, gatewayId: GATEWAY_ID },
      configAck(4, "rejected", snapshot(4).payloadHash, "old_revision_rejected")
    );
    expect(harness.state.configuration).toMatchObject({
      appliedRevision: 2,
      syncStatus: "PENDING",
      lastErrorCode: null
    });

    await harness.service.onConfigApplied(
      { siteId: SITE_ID, gatewayId: GATEWAY_ID },
      configAck(5, "rejected", snapshot(5).payloadHash, "disk /private/site/path")
    );
    expect(harness.state.configuration).toMatchObject({
      appliedRevision: 2,
      desiredRevision: 5,
      syncStatus: "REJECTED",
      lastErrorCode: "configuration_rejected"
    });
  });

  it("keeps an exact desired rejection when a lower applied revision arrives later", async () => {
    const harness = createHarness();

    await harness.service.onConfigApplied(
      { siteId: SITE_ID, gatewayId: GATEWAY_ID },
      configAck(5, "rejected", snapshot(5).payloadHash, "config_invalid")
    );
    await harness.service.onConfigApplied(
      { siteId: SITE_ID, gatewayId: GATEWAY_ID },
      configAck(4, "applied", snapshot(4).payloadHash)
    );

    expect(harness.state.configuration).toMatchObject({
      desiredRevision: 5,
      appliedRevision: 4,
      syncStatus: "REJECTED",
      lastErrorCode: "config_invalid"
    });
  });

  it("atomically stores one canonical execution, terminal fixture results, and an immutable durable ACK", async () => {
    const harness = createHarness();
    const event = executionEvent();

    await harness.service.onExecution({ siteId: SITE_ID, gatewayId: GATEWAY_ID }, event);
    const firstAck = structuredClone(harness.state.applicationAcks[0]);
    harness.state.applicationAcks[0].publishedAt = new Date("2026-08-30T01:01:00.000Z");
    harness.state.applicationAcks[0].attempts = 7;

    await harness.service.onExecution({ siteId: SITE_ID, gatewayId: GATEWAY_ID }, event);

    expect(harness.state.executions).toHaveLength(1);
    expect(harness.state.fixtureResults).toEqual([expect.objectContaining({
      fixtureSnapshotId: FIXTURE_ID,
      fixtureId: FIXTURE_ID,
      status: "succeeded",
      brightnessPercent: 80
    })]);
    expect(harness.state.executions[0]).toMatchObject({
      siteId: SITE_ID,
      gatewayId: GATEWAY_ID,
      eventId: EVENT_ID,
      sequence: 9n,
      vehicleEventRuleId: RULE_ID,
      payloadHash: canonicalPayloadHash(event)
    });
    expect(harness.state.applicationAcks).toHaveLength(1);
    expect(harness.state.applicationAcks[0]).toMatchObject({
      id: firstAck.id,
      applicationAckKey: `automation-execution:${GATEWAY_ID}:${EVENT_ID}:9:${canonicalPayloadHash(event)}`,
      topic: `sites/${SITE_ID}/gateways/${GATEWAY_ID}/acks/automation/execution-ingested`,
      payload: firstAck.payload,
      payloadHash: firstAck.payloadHash,
      createdAt: firstAck.createdAt,
      publishedAt: null,
      attempts: 0
    });
  });

  it("ingests a previous revision execution from its immutable snapshot after the current rule targets change", async () => {
    const harness = createHarness();
    harness.state.currentVehicleRule = { id: RULE_ID, targetFixtureIds: [FIXTURE_ID_2] };

    await harness.service.onExecution(
      { siteId: SITE_ID, gatewayId: GATEWAY_ID },
      executionEvent({ revision: 4 })
    );

    expect(harness.state.executions).toEqual([expect.objectContaining({
      revision: 4,
      ruleId: RULE_ID,
      vehicleEventRuleId: RULE_ID
    })]);
    expect(harness.state.fixtureResults).toEqual([expect.objectContaining({
      fixtureSnapshotId: FIXTURE_ID
    })]);
    expect(harness.state.applicationAcks).toHaveLength(1);
  });

  it("ingests a previous revision execution and immutable ACK after its rule is deleted", async () => {
    const harness = createHarness();
    harness.state.currentVehicleRule = null;

    await harness.service.onExecution(
      { siteId: SITE_ID, gatewayId: GATEWAY_ID },
      executionEvent({ revision: 4 })
    );

    expect(harness.state.executions).toEqual([expect.objectContaining({
      revision: 4,
      ruleId: RULE_ID,
      vehicleEventRuleId: null
    })]);
    expect(harness.state.fixtureResults).toHaveLength(1);
    expect(harness.state.applicationAcks).toHaveLength(1);
  });

  it("binds a manual action command source to the ManualOverride primary key and exact ACK", async () => {
    const harness = createHarness();
    const event = executionEvent({
      ruleId: null,
      occurrenceKey: `manual:${COMMAND_ID}`,
      payload: {
        sourceType: "manual_override" as const,
        sourceId: COMMAND_ID,
        results: [{
          fixtureId: FIXTURE_ID,
          status: "succeeded" as const,
          brightnessPercent: 60,
          faultCode: null,
          errorCode: null,
          occurredAt: "2026-08-30T00:59:00.000Z"
        }]
      }
    });

    await harness.service.onExecution({ siteId: SITE_ID, gatewayId: GATEWAY_ID }, event);

    expect(harness.state.executions).toEqual([expect.objectContaining({
      eventId: EVENT_ID,
      manualOverrideId: MANUAL_OVERRIDE_ID,
      lightingScheduleId: null,
      vehicleEventRuleId: null,
      payloadHash: canonicalPayloadHash(event)
    })]);
    expect(harness.state.fixtureResults).toEqual([expect.objectContaining({
      fixtureId: FIXTURE_ID,
      brightnessPercent: 60
    })]);
    expect(harness.state.applicationAcks).toEqual([expect.objectContaining({
      applicationAckKey: `automation-execution:${GATEWAY_ID}:${EVENT_ID}:9:${canonicalPayloadHash(event)}`,
      payload: expect.objectContaining({
        gatewayId: GATEWAY_ID,
        eventId: EVENT_ID,
        sequence: 9,
        reportPayloadHash: canonicalPayloadHash(event)
      })
    })]);
  });

  it("rejects a conflicting replay without changing the original execution or ACK", async () => {
    const harness = createHarness();
    const original = executionEvent();
    await harness.service.onExecution({ siteId: SITE_ID, gatewayId: GATEWAY_ID }, original);
    const before = snapshotState(harness.state);
    const conflict = executionEvent({
      payload: {
        ...original.payload,
        results: [{ ...original.payload.results[0], brightnessPercent: 81 }]
      }
    });

    await expect(harness.service.onExecution(
      { siteId: SITE_ID, gatewayId: GATEWAY_ID },
      conflict
    )).rejects.toThrow("execution replay conflict");

    expect(snapshotState(harness.state)).toEqual(before);
  });

  it("treats reordered terminal fixture results as the same canonical execution report", async () => {
    const harness = createHarness();
    const original = executionEvent();
    const secondResult = { ...original.payload.results[0], fixtureId: FIXTURE_ID_2 };
    const firstDelivery = executionEvent({
      payload: { ...original.payload, results: [original.payload.results[0], secondResult] }
    });
    const redelivery = executionEvent({
      payload: { ...original.payload, results: [secondResult, original.payload.results[0]] }
    });

    await harness.service.onExecution({ siteId: SITE_ID, gatewayId: GATEWAY_ID }, firstDelivery);
    await harness.service.onExecution({ siteId: SITE_ID, gatewayId: GATEWAY_ID }, redelivery);

    expect(harness.state.executions).toHaveLength(1);
    expect(harness.state.fixtureResults).toHaveLength(2);
    expect(harness.state.applicationAcks).toHaveLength(1);
  });

  it("rolls back the execution and fixture results when durable ACK creation fails", async () => {
    const harness = createHarness();
    harness.state.failAckCreate = true;

    await expect(harness.service.onExecution(
      { siteId: SITE_ID, gatewayId: GATEWAY_ID },
      executionEvent()
    )).rejects.toThrow("ack insert failed");

    expect(harness.state.executions).toEqual([]);
    expect(harness.state.fixtureResults).toEqual([]);
    expect(harness.state.applicationAcks).toEqual([]);
  });
});

function createHarness() {
  const state: State = {
    identityActive: true,
    failAckCreate: false,
    configuration: {
      gatewayId: GATEWAY_ID,
      siteId: SITE_ID,
      desiredRevision: 5,
      appliedRevision: 2,
      syncStatus: "PENDING",
      lastErrorCode: null,
      lastAppliedAt: null
    },
    configOutboxes: [3, 4, 5].map((revision) => ({
      id: `config-${revision}`,
      gatewayId: GATEWAY_ID,
      revision,
      payloadHash: snapshot(revision).payloadHash,
      dispatchId: null,
      applicationAckKey: null,
      payload: snapshot(revision)
    })),
    currentVehicleRule: { id: RULE_ID, targetFixtureIds: [FIXTURE_ID, FIXTURE_ID_2] },
    manualOverride: {
      id: MANUAL_OVERRIDE_ID,
      commandId: COMMAND_ID,
      fixtureIds: [FIXTURE_ID]
    },
    executions: [],
    fixtureResults: [],
    applicationAcks: []
  };
  const prisma = createPrisma(state);
  const capability = { applyReport: jest.fn().mockResolvedValue({}) };
  const service = new AutomationMqttConsumerService(
    prisma as never,
    capability as never,
    { now: () => NOW } as never
  );
  return { state, prisma, capability, service };
}

function createPrisma(state: State) {
  const tx: any = {
    $queryRaw: jest.fn(async (query: { strings?: readonly string[] }) => {
      const sql = query.strings?.join(" ") ?? "";
      if (sql.includes('FROM "GatewayAutomationConfiguration"')) {
        return state.identityActive ? [structuredClone(state.configuration)] : [];
      }
      if (sql.includes('FROM "Gateway"')) return state.identityActive ? [{ id: GATEWAY_ID }] : [];
      return [];
    }),
    mqttOutbox: {
      findFirst: jest.fn(async ({ where }: any) => state.configOutboxes.find((row) =>
        row.gatewayId === where.gatewayId && row.revision === where.revision &&
        row.payloadHash === where.payloadHash && row.dispatchId === null && row.applicationAckKey === null
      ) ?? null),
      findMany: jest.fn(async ({ where }: any) => state.configOutboxes.filter((row) =>
        row.gatewayId === where.gatewayId && row.revision === where.revision &&
        row.dispatchId === null && row.applicationAckKey === null
      ).map(({ payloadHash, payload }) => ({ payloadHash, payload }))),
      findUnique: jest.fn(async ({ where }: any) => state.applicationAcks.find((row) =>
        row.applicationAckKey === where.applicationAckKey
      ) ?? null),
      create: jest.fn(async ({ data }: any) => {
        if (state.failAckCreate) throw new Error("ack insert failed");
        const row = {
          id: `ack-${state.applicationAcks.length + 1}`,
          attempts: 0,
          nextAttemptAt: NOW,
          publishedAt: null,
          lockedBy: null,
          lockedAt: null,
          leaseExpiresAt: null,
          deadLetteredAt: null,
          supersededAt: null,
          lastError: null,
          createdAt: NOW,
          ...structuredClone(data)
        };
        state.applicationAcks.push(row);
        return row;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = state.applicationAcks.find((candidate) => candidate.id === where.id);
        if (!row) return { count: 0 };
        Object.assign(row, structuredClone(data));
        return { count: 1 };
      })
    },
    gatewayAutomationConfiguration: {
      update: jest.fn(async ({ data }: any) => {
        Object.assign(state.configuration, structuredClone(data));
        return structuredClone(state.configuration);
      })
    },
    lightingSchedule: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), findFirst: jest.fn() },
    vehicleEventRule: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findFirst: jest.fn(async ({ where }: any) => {
        if (
          where.id !== RULE_ID || where.siteId !== SITE_ID || where.gatewayId !== GATEWAY_ID ||
          !state.currentVehicleRule
        ) return null;
        return {
          id: state.currentVehicleRule.id,
          targets: state.currentVehicleRule.targetFixtureIds.map((fixtureId) => ({ fixtureId }))
        };
      })
    },
    manualOverride: {
      findFirst: jest.fn(async ({ where }: any) => {
        if (
          where.commandId !== state.manualOverride.commandId ||
          where.siteId !== SITE_ID || where.gatewayId !== GATEWAY_ID
        ) return null;
        return {
          id: state.manualOverride.id,
          fixtures: state.manualOverride.fixtureIds.map((fixtureId) => ({ fixtureId }))
        };
      })
    },
    automationExecution: {
      findUnique: jest.fn(async ({ where }: any) => state.executions.find((row) =>
        row.gatewayId === where.gatewayId_eventId_sequence.gatewayId &&
        row.eventId === where.gatewayId_eventId_sequence.eventId &&
        row.sequence === where.gatewayId_eventId_sequence.sequence
      ) ?? null),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `execution-${state.executions.length + 1}`, ...structuredClone(data) };
        state.executions.push(row);
        return row;
      })
    },
    automationExecutionFixtureResult: {
      createMany: jest.fn(async ({ data }: any) => {
        state.fixtureResults.push(...structuredClone(data));
        return { count: data.length };
      })
    }
  };
  return {
    ...tx,
    $transaction: jest.fn(async (callback: (value: typeof tx) => Promise<unknown>) => {
      const before = snapshotState(state);
      try {
        return await callback(tx);
      } catch (error) {
        restoreState(state, before);
        throw error;
      }
    })
  };
}

function snapshot(revision: number) {
  const withoutHash = {
    schemaVersion: 1 as const,
    siteId: SITE_ID,
    gatewayId: GATEWAY_ID,
    revision,
    timeZone: "Asia/Seoul",
    schedules: [],
    vehicleEventRules: [{
      id: RULE_ID,
      name: "Vehicle rule",
      status: "enabled" as const,
      sourceFixtureIds: [FIXTURE_ID_2],
      targetFixtureIds: [FIXTURE_ID, FIXTURE_ID_2],
      action: { dimmingEnabled: true, brightnessPercent: 80 },
      holdSeconds: 60
    }],
    generatedAt: `2026-08-30T00:0${revision}:00.000Z`
  };
  return { ...withoutHash, payloadHash: canonicalPayloadHash(withoutHash) };
}

function configAck(
  revision: number,
  status: "applied" | "rejected",
  payloadHash: string,
  errorCode: string | null = status === "rejected" ? "configuration_rejected" : null
) {
  return {
    schemaVersion: 1 as const,
    gatewayId: GATEWAY_ID,
    revision,
    payloadHash,
    status,
    errorCode,
    appliedAt: "2026-08-30T00:30:00.000Z"
  };
}

function executionEvent(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1 as const,
    eventId: EVENT_ID,
    sequence: 9,
    gatewayId: GATEWAY_ID,
    revision: 5,
    ruleId: RULE_ID,
    occurrenceKey: "vehicle:2026-08-30T00:00:00.000Z",
    kind: "action_result" as const,
    occurredAt: "2026-08-30T00:59:00.000Z",
    payload: {
      sourceType: "vehicle_event_rule" as const,
      sourceId: RULE_ID,
      results: [{
        fixtureId: FIXTURE_ID,
        status: "succeeded" as const,
        brightnessPercent: 80,
        faultCode: null,
        errorCode: null,
        occurredAt: "2026-08-30T00:59:00.000Z"
      }]
    },
    ...overrides
  };
}

function capabilityReport() {
  return {
    schemaVersion: 1 as const,
    eventId: EVENT_ID,
    siteId: SITE_ID,
    gatewayId: GATEWAY_ID,
    meshNodeId: MESH_NODE_ID,
    capabilityRevision: 1,
    status: "supported" as const,
    verifiedAt: "2026-08-30T00:00:00.000Z",
    sensorServerBound: true,
    vendorVehicleEventModelBound: true
  };
}

function snapshotState(state: State) {
  return structuredClone(state);
}

function restoreState(state: State, before: State) {
  for (const key of Object.keys(state) as Array<keyof State>) delete state[key];
  Object.assign(state, before);
}

interface State {
  identityActive: boolean;
  failAckCreate: boolean;
  configuration: any;
  configOutboxes: any[];
  currentVehicleRule: { id: string; targetFixtureIds: string[] } | null;
  manualOverride: { id: string; commandId: string; fixtureIds: string[] };
  executions: any[];
  fixtureResults: any[];
  applicationAcks: any[];
}
