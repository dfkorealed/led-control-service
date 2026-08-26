import { describe, expect, it } from "vitest";
import {
  EDITOR_MAX_FIXTURE_UPDATES,
  EDITOR_MAX_EXPECTED_REVISION,
  EDITOR_MAX_ID_LENGTH,
  EDITOR_MAX_MAP_OBJECT_MUTATIONS,
  EDITOR_MAX_TEXT_LENGTH,
  EDITOR_REVISION_DEFAULT_LIMIT,
  POSTGRES_INT_MAX,
  createRegistrationSessionSchema,
  createDimmingCommandSchema,
  createDimmingCommandRequestSchema,
  createFixtureGroupSchema,
  editorRevisionListQuerySchema,
  floorEditorSnapshotSchema,
  floorMapSnapshotSchema,
  legacyFloorPlanEffectiveSchema,
  parseFloorEditorSnapshot,
  positivePostgresIntSchema,
  registerFixtureBatchSchema,
  fixtureLayoutUpdateSchema,
  floorMapObjectDraftSchema,
  floorPlanUpdateSchema,
  provisionDeviceSchema,
  provisioningCompletedSchema,
  provisioningFailedSchema,
  provisioningScanCompletedSchema,
  provisioningScanFailedSchema,
  provisioningScanFoundSchema,
  provisioningScanStartSchema,
  restoreFloorEditorRevisionSchema,
  energySeriesPointSchema,
  energySummarySchema,
  fixtureGroupMetadataSchema,
  meshGroupSubscriptionResultSchema,
  meshGroupSubscriptionSyncSchema,
  saveEditorStateSchema,
} from "./schemas";
import { mqttTopicsV2 } from "./gateway-contracts";
import { mqttTopics } from "./mqtt";

describe("shared schemas", () => {
  it("validates all dimming target types and normalizes legacy requests", () => {
    const siteId = "00000000-0000-4000-8000-000000000003";
    const fixture1 = "11111111-1111-4111-8111-111111111111";
    const fixture2 = "22222222-2222-4222-8222-222222222222";

    expect(createDimmingCommandSchema.parse({
      siteId,
      clientRequestId: "33333333-3333-4333-8333-333333333333",
      target: { type: "fixtures", fixtureIds: [fixture1, fixture2] },
      brightness: 70
    }).target.type).toBe("fixtures");
    expect(createDimmingCommandSchema.parse({
      siteId,
      clientRequestId: "33333333-3333-4333-8333-333333333333",
      target: { type: "floor", floorId: fixture1 },
      brightness: 70
    }).target.type).toBe("floor");
    expect(createDimmingCommandSchema.parse({
      siteId,
      clientRequestId: "33333333-3333-4333-8333-333333333333",
      target: { type: "group", groupId: fixture1 },
      brightness: 70
    }).target.type).toBe("group");
    expect(createDimmingCommandRequestSchema.parse({
      siteId,
      clientRequestId: "33333333-3333-4333-8333-333333333333",
      targetType: "fixture",
      targetId: fixture1,
      brightness: 70
    })).toEqual({
      siteId,
      clientRequestId: "33333333-3333-4333-8333-333333333333",
      target: { type: "fixture", fixtureId: fixture1 },
      brightness: 70
    });
  });

  it("rejects empty or duplicate fixture target lists", () => {
    const siteId = "00000000-0000-4000-8000-000000000003";
    const fixtureId = "11111111-1111-4111-8111-111111111111";

    expect(() => createDimmingCommandSchema.parse({
      siteId,
      clientRequestId: "33333333-3333-4333-8333-333333333333",
      target: { type: "fixtures", fixtureIds: [] },
      brightness: 70
    })).toThrow();
    expect(() => createDimmingCommandSchema.parse({
      siteId,
      clientRequestId: "33333333-3333-4333-8333-333333333333",
      target: { type: "fixtures", fixtureIds: [fixtureId, fixtureId] },
      brightness: 70
    })).toThrow("fixtureIds must be unique");
  });

  it("validates batch and individual fixture registration settings", () => {
    const nodeId = "22222222-2222-4222-8222-222222222222";
    const batch = registerFixtureBatchSchema.parse({
      mode: "batch",
      defaults: { namePrefix: "B2-L", startNumber: 1, digits: 3, ratedWatt: "40.00", size: 20 },
      nodes: [{ nodeId, placement: { mode: "auto" } }]
    });
    expect(batch.mode).toBe("batch");
    expect(batch.defaults.ratedWatt).toBe("40.00");

    const individual = registerFixtureBatchSchema.parse({
      mode: "individual",
      defaults: { namePrefix: "B2-L", startNumber: 5, digits: 3 },
      nodes: [{
        nodeId,
        fixtureName: "입구 조명",
        ratedWatt: "35.50",
        size: 24,
        placement: { mode: "manual", x: 120, y: 240 }
      }]
    });
    expect(individual.mode).toBe("individual");
    expect(individual.nodes[0].fixtureName).toBe("입구 조명");
  });

  it("rejects duplicate nodes in a fixture registration batch", () => {
    const nodeId = "22222222-2222-4222-8222-222222222222";
    expect(() => registerFixtureBatchSchema.parse({
      mode: "batch",
      defaults: { namePrefix: "B2-L", startNumber: 1, digits: 3, ratedWatt: "40.00", size: 20 },
      nodes: [
        { nodeId, placement: { mode: "auto" } },
        { nodeId, placement: { mode: "auto" } }
      ]
    })).toThrow("nodeId must be unique within a registration batch");
  });

  it("requires an explicit site, floor, and gateway when creating a registration session", () => {
    expect(createRegistrationSessionSchema.parse({
      siteId: "00000000-0000-4000-8000-000000000003",
      floorId: "00000000-0000-4000-8000-000000000005",
      gatewayId: "00000000-0000-4000-8000-000000000004"
    })).toEqual({
      siteId: "00000000-0000-4000-8000-000000000003",
      floorId: "00000000-0000-4000-8000-000000000005",
      gatewayId: "00000000-0000-4000-8000-000000000004"
    });
    expect(() => createRegistrationSessionSchema.parse({
      siteId: "00000000-0000-4000-8000-000000000003",
      floorId: "00000000-0000-4000-8000-000000000005"
    })).toThrow();
  });

  it("correlates provisioning scan starts, found events, and terminal events", () => {
    expect(
      mqttTopicsV2.gatewayCommand(
        "00000000-0000-4000-8000-000000000003",
        "00000000-0000-4000-8000-000000000004",
        "provisioning/scan-start"
      )
    ).toBe(
      "sites/00000000-0000-4000-8000-000000000003/gateways/00000000-0000-4000-8000-000000000004/commands/provisioning/scan-start"
    );

    const scanCommand = provisioningScanStartSchema.parse({
      sessionId: "11111111-1111-4111-8111-111111111111",
      scanCorrelationId: "99999999-9999-4999-8999-999999999999",
      scanAttempt: 1,
      siteId: "00000000-0000-4000-8000-000000000003",
      gatewayId: "00000000-0000-4000-8000-000000000004",
      floorId: "00000000-0000-4000-8000-000000000005",
      requestedAt: "2026-07-01T00:00:00.000Z"
    });

    expect(scanCommand.floorId).toBe("00000000-0000-4000-8000-000000000005");

    const discovered = provisioningScanFoundSchema.parse({
      sessionId: "11111111-1111-4111-8111-111111111111",
      scanCorrelationId: "99999999-9999-4999-8999-999999999999",
      scanAttempt: 1,
      siteId: "00000000-0000-4000-8000-000000000003",
      gatewayId: "00000000-0000-4000-8000-000000000004",
      eventId: "33333333-3333-4333-8333-333333333334",
      sequence: 7,
      occurredAt: "2026-07-01T00:00:01.000Z",
      deviceUuid: "esp32h2-demo-001",
      serialNumber: "LC-B2-001",
      rssi: -54,
      oobCapability: "static-oob",
      firmwareVersion: "esp32h2-0.1.0"
    });

    expect(discovered.rssi).toBe(-54);

    const completed = provisioningScanCompletedSchema.parse({
      siteId: "00000000-0000-4000-8000-000000000003",
      gatewayId: "00000000-0000-4000-8000-000000000004",
      eventId: "44444444-4444-4444-8444-444444444444",
      sequence: 8,
      occurredAt: "2026-07-01T00:00:03.000Z",
      sessionId: "11111111-1111-4111-8111-111111111111",
      scanCorrelationId: "99999999-9999-4999-8999-999999999999",
      scanAttempt: 1,
      acceptedNodeCount: 0
    });
    expect(completed.acceptedNodeCount).toBe(0);

    expect(provisioningScanFailedSchema.parse({
      siteId: "00000000-0000-4000-8000-000000000003",
      gatewayId: "00000000-0000-4000-8000-000000000004",
      eventId: "55555555-5555-4555-8555-555555555555",
      sequence: 9,
      occurredAt: "2026-07-01T00:00:04.000Z",
      sessionId: "11111111-1111-4111-8111-111111111111",
      scanCorrelationId: "99999999-9999-4999-8999-999999999999",
      scanAttempt: 1,
      code: "scan_timeout",
      message: "Bluetooth scan timed out"
    }).code).toBe("scan_timeout");

    expect(() => provisioningScanCompletedSchema.parse({ ...completed, scanAttempt: 0 })).toThrow();
    expect(() => provisioningScanFailedSchema.parse({
      siteId: "00000000-0000-4000-8000-000000000003",
      gatewayId: "00000000-0000-4000-8000-000000000004",
      eventId: "55555555-5555-4555-8555-555555555555",
      sequence: 9,
      occurredAt: "2026-07-01T00:00:04.000Z",
      sessionId: "11111111-1111-4111-8111-111111111111",
      scanCorrelationId: "99999999-9999-4999-8999-999999999999",
      scanAttempt: 1,
      code: "unknown",
      message: "Bluetooth scan failed"
    })).toThrow();
  });

  it("defines provisioning command and result event contracts", () => {
    expect(mqttTopicsV2.gatewayCommand(
      "00000000-0000-4000-8000-000000000003",
      "00000000-0000-4000-8000-000000000004",
      "provisioning/provision-device"
    )).toBe(
      "sites/00000000-0000-4000-8000-000000000003/gateways/00000000-0000-4000-8000-000000000004/commands/provisioning/provision-device"
    );

    expect(
      provisionDeviceSchema.parse({
        sessionId: "11111111-1111-4111-8111-111111111111",
        siteId: "00000000-0000-4000-8000-000000000003",
        gatewayId: "00000000-0000-4000-8000-000000000004",
        nodeId: "22222222-2222-4222-8222-222222222222",
        deviceUuid: "esp32h2-demo-001",
        meshAddress: "0x0101",
        requestedAt: "2026-07-01T00:00:02.000Z"
      }).meshAddress
    ).toBe("0x0101");

    expect(
      provisioningCompletedSchema.parse({
        sessionId: "11111111-1111-4111-8111-111111111111",
        nodeId: "22222222-2222-4222-8222-222222222222",
        deviceUuid: "esp32h2-demo-001",
        meshAddress: "0x0101",
        firmwareVersion: "esp32h2-0.1.0",
        rssi: -61,
        hopCount: 1,
        completedAt: "2026-07-01T00:00:05.000Z"
      }).nodeId
    ).toBe("22222222-2222-4222-8222-222222222222");

    expect(
      provisioningFailedSchema.parse({
        sessionId: "11111111-1111-4111-8111-111111111111",
        nodeId: "22222222-2222-4222-8222-222222222222",
        deviceUuid: "esp32h2-demo-001",
        errorMessage: "provisioning timeout",
        failedAt: "2026-07-01T00:00:05.000Z"
      }).errorMessage
    ).toBe("provisioning timeout");
  });

  it("defines a complete desired mesh group membership set including deletion to empty", () => {
    expect(
      mqttTopics.meshGroupSubscriptionSync(
        "00000000-0000-4000-8000-000000000003",
        "00000000-0000-4000-8000-000000000004"
      )
    ).toBe(
      "sites/00000000-0000-4000-8000-000000000003/gateways/00000000-0000-4000-8000-000000000004/commands/mesh-group/subscription-sync"
    );
    expect(
      mqttTopics.meshGroupSubscriptionResult(
        "00000000-0000-4000-8000-000000000003",
        "00000000-0000-4000-8000-000000000004"
      )
    ).toBe(
      "sites/00000000-0000-4000-8000-000000000003/gateways/00000000-0000-4000-8000-000000000004/events/mesh-group/subscription-result"
    );

    const command = meshGroupSubscriptionSyncSchema.parse({
      siteId: "00000000-0000-4000-8000-000000000003",
      gatewayId: "00000000-0000-4000-8000-000000000004",
      groupId: "00000000-0000-4000-8000-000000000005",
      version: 2,
      groupAddress: "0xc000",
      desiredMembers: [
        {
          meshNodeId: "22222222-2222-4222-8222-222222222222",
          meshAddress: "0x0100"
        }
      ],
      requestedAt: "2026-08-20T09:00:00.000Z"
    });
    expect(command.desiredMembers).toHaveLength(1);

    expect(meshGroupSubscriptionResultSchema.parse({
      siteId: "00000000-0000-4000-8000-000000000003",
      gatewayId: "00000000-0000-4000-8000-000000000004",
      groupId: "00000000-0000-4000-8000-000000000005",
      version: 2,
      groupAddress: "0xc000",
      operations: [
        {
          operationId: "66666666-6666-4666-8666-666666666666",
          action: "add",
          meshNodeId: "22222222-2222-4222-8222-222222222222",
          status: "ready"
        }
      ],
      occurredAt: "2026-08-20T09:00:01.000Z"
    }).operations[0].status).toBe("ready");

    expect(meshGroupSubscriptionSyncSchema.parse({ ...command, desiredMembers: [] }).desiredMembers).toEqual([]);
    expect(() => meshGroupSubscriptionSyncSchema.parse({
      ...command,
      desiredMembers: [command.desiredMembers[0], command.desiredMembers[0]]
    })).toThrow("desiredMembers must be unique by meshNodeId");
    expect(() => meshGroupSubscriptionResultSchema.parse({
      siteId: command.siteId, gatewayId: command.gatewayId, groupId: command.groupId, version: command.version,
      groupAddress: command.groupAddress, occurredAt: "2026-08-20T09:00:01.000Z",
      operations: [
        { operationId: "66666666-6666-4666-8666-666666666666", action: "add", meshNodeId: "22222222-2222-4222-8222-222222222222", status: "ready" },
        { operationId: "66666666-6666-4666-8666-666666666666", action: "delete", meshNodeId: "33333333-3333-4333-8333-333333333333", status: "ready" }
      ]
    })).toThrow("operationId must be unique");
  });

  it("defines shared fixture group and state-based energy response contracts", () => {
    const group = createFixtureGroupSchema.parse({
      name: "B2 entrance",
      floorId: "00000000-0000-4000-8000-000000000005",
      gatewayId: "00000000-0000-4000-8000-000000000004",
      fixtureIds: ["11111111-1111-4111-8111-111111111111"]
    });
    expect(group.fixtureIds).toHaveLength(1);

    expect(fixtureGroupMetadataSchema.parse({
      id: "77777777-7777-4777-8777-777777777777",
      name: "B2 entrance",
      floorId: group.floorId,
      gatewayId: group.gatewayId,
      lifecycleStatus: "active",
      fixtureCount: 1,
      meshControlGroup: { status: "configuring", version: 1, error: null }
    }).lifecycleStatus).toBe("active");

    expect(energySummarySchema.parse({
      siteId: "00000000-0000-4000-8000-000000000003",
      timeZone: "Asia/Seoul",
      source: "state_based_estimate",
      generatedAt: "2026-08-26T00:00:00.000Z",
      today: { estimatedKwh: 1.2, estimatedCost: 120, knownSeconds: 3600, unknownSeconds: 0, dataStatus: "available" },
      monthToDate: { estimatedKwh: 2.4, estimatedCost: 240, knownSeconds: 7200, unknownSeconds: 0, dataStatus: "available" },
      yearToDate: { estimatedKwh: 3.6, estimatedCost: 360, knownSeconds: 10800, unknownSeconds: 0, dataStatus: "available" },
      monthForecast: { estimatedKwh: 4.8, estimatedCost: 480, observedKnownSeconds: 7200, reason: "available" },
      baseline24Hours: { estimatedKwh: 8, estimatedCost: 800, fixtureCount: 4, daysInMonth: 31 },
      estimatedSavings: { kwh: 3.2, cost: 320 },
      lastAggregatedAt: "2026-08-26T00:00:00.000Z"
    }).monthToDate.estimatedKwh).toBe(2.4);
    expect(energySeriesPointSchema.parse({
      source: "state_based_estimate",
      period: "2026-08-26",
      estimatedKwh: null,
      estimatedCost: null,
      knownSeconds: 0,
      unknownSeconds: 60,
      dataStatus: "partial"
    }).estimatedKwh).toBeNull();
  });

  it("validates atomic floor editor save and restore inputs", () => {
    const save = saveEditorStateSchema.parse({
      expectedRevision: 3,
      leaseToken: "lease-token",
      leaseFence: 7,
      floorPlan: null,
      fixtureUpdates: [{ id: "fixture-1", x: 120, y: 240, size: 24 }],
      objectCreates: [{
        type: "rectangle", x: 10, y: 20, width: 30, height: 40, rotation: 0,
        points: null, text: null, strokeColor: "#111111", fillColor: null,
        strokeWidth: 2, fontSize: null, zIndex: 1, locked: false, visible: true
      }],
      objectUpdates: [{ id: "object-1", patch: { x: 15, visible: false } }],
      objectDeletes: ["object-2"]
    });

    expect(save.expectedRevision).toBe(3);
    expect(save.floorPlan).toBeNull();
    expect(restoreFloorEditorRevisionSchema.parse({ expectedRevision: 4, leaseToken: "lease-token", leaseFence: 7 }))
      .toEqual({ expectedRevision: 4, leaseToken: "lease-token", leaseFence: 7 });
    expect(() => saveEditorStateSchema.parse({ ...save, expectedRevision: -1 })).toThrow();
    expect(() => restoreFloorEditorRevisionSchema.parse({ expectedRevision: 1.5, leaseToken: "lease-token", leaseFence: 7 })).toThrow();

    expect(saveEditorStateSchema.parse({
      ...save,
      objectCreates: [{
        type: "text", x: 10, y: 20, width: 120, height: 40, rotation: 0,
        text: "Entrance", strokeColor: "#111111", strokeWidth: 2, locked: false, visible: true
      }]
    }).objectCreates[0]).toEqual({
      type: "text", x: 10, y: 20, width: 120, height: 40, rotation: 0,
      text: "Entrance", strokeColor: "#111111", strokeWidth: 2, locked: false, visible: true
    });
  });

  it("validates persisted floor editor snapshots independently from runtime fixture state", () => {
    expect(floorEditorSnapshotSchema.parse({
      floorPlan: null,
      fixtures: [{ id: "fixture-1", name: "B2-L01", ratedWatt: "40.00", x: 10, y: 20, size: 24 }],
      objects: []
    })).toEqual({
      floorPlan: null,
      fixtures: [{ id: "fixture-1", name: "B2-L01", ratedWatt: "40.00", x: 10, y: 20, size: 24 }],
      objects: []
    });

    expect(() => floorEditorSnapshotSchema.parse({ floorPlan: null, fixtures: [{ id: "fixture-1" }], objects: [] }))
      .toThrow();
  });

  it("validates read-only floor map snapshots without fixture runtime state", () => {
    const snapshot = {
      floorId: "00000000-0000-4000-8000-000000000005",
      revision: 3,
      width: 1200,
      height: 800,
      floorPlan: null,
      objects: []
    };

    expect(floorMapSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(() => floorMapSnapshotSchema.parse({ ...snapshot, revision: -1 })).toThrow();
    expect(() => floorMapSnapshotSchema.parse({ ...snapshot, fixtures: [] })).toThrow();
  });

  it("parses legacy v1 snapshots without weakening atomic floor plan writes", () => {
    const legacySnapshot = {
      floorPlan: {
        imageUrl: "",
        sourceType: "none" as const,
        originalFileUrl: null,
        renderedImageUrl: null,
        width: 1200,
        height: 800
      },
      fixtures: [{ id: "fixture-1", name: "B2-L01", ratedWatt: "40.00", x: 10, y: 20, size: 24 }],
      objects: [{
        id: "legacy-object-1", type: "legacy-shape", x: 10, y: 20, width: null, height: null,
        rotation: 0, points: null, text: null, strokeColor: "#111111", fillColor: null,
        strokeWidth: 2, fontSize: null, zIndex: 0, locked: false, visible: true
      }]
    };

    expect(parseFloorEditorSnapshot(legacySnapshot)).toEqual(legacySnapshot);
    expect(floorEditorSnapshotSchema.parse(legacySnapshot)).toEqual(legacySnapshot);
    expect(() => floorPlanUpdateSchema.parse(legacySnapshot.floorPlan)).toThrow();
  });

  it("rejects unsafe legacy snapshot values", () => {
    const object = {
      id: "legacy-object-1", type: "rectangle", x: 0, y: 0, width: null, height: null,
      rotation: 0, points: null, text: null, strokeColor: "#111111", fillColor: null,
      strokeWidth: 2, fontSize: null, zIndex: 0, locked: false, visible: true
    };
    const snapshot = { floorPlan: null, fixtures: [], objects: [object] };

    expect(() => parseFloorEditorSnapshot({
      ...snapshot,
      objects: [{ ...object, points: { x: 1, y: 2 } }]
    })).toThrow();
    expect(() => parseFloorEditorSnapshot({
      ...snapshot,
      objects: [{ ...object, type: "x".repeat(201) }]
    })).toThrow();
  });

  it("requires complete non-empty source-specific floor plan data", () => {
    const imagePlan = {
      sourceType: "image" as const,
      imageUrl: "https://assets.example/floor.png",
      originalFileUrl: "https://assets.example/floor.png",
      renderedImageUrl: "https://assets.example/floor.png",
      width: 1200,
      height: 800
    };
    const pdfPlan = {
      ...imagePlan,
      sourceType: "pdf" as const,
      originalFileUrl: "https://assets.example/floor.pdf",
      renderedImageUrl: "https://assets.example/floor-rendered.png"
    };

    expect(floorPlanUpdateSchema.parse(imagePlan)).toEqual(imagePlan);
    expect(floorPlanUpdateSchema.parse(pdfPlan)).toEqual(pdfPlan);
    expect(() => floorPlanUpdateSchema.parse({ sourceType: "image" })).toThrow();
    expect(() => floorPlanUpdateSchema.parse({ ...imagePlan, imageUrl: "   " })).toThrow();
    expect(() => floorPlanUpdateSchema.parse({ ...imagePlan, sourceType: "none" })).toThrow();
    expect(() => floorPlanUpdateSchema.parse({ ...imagePlan, width: 0 })).toThrow();

    expect(legacyFloorPlanEffectiveSchema.parse({
      sourceType: "none",
      imageUrl: "",
      originalFileUrl: null,
      renderedImageUrl: null,
      width: 1200,
      height: 800
    })).toMatchObject({ sourceType: "none", imageUrl: "" });
    expect(legacyFloorPlanEffectiveSchema.parse(imagePlan)).toEqual(imagePlan);
    expect(() => legacyFloorPlanEffectiveSchema.parse({ ...imagePlan, imageUrl: "" })).toThrow();
    expect(() => legacyFloorPlanEffectiveSchema.parse({ ...imagePlan, originalFileUrl: null })).toThrow();
  });

  it("bounds PostgreSQL Int fields and editor request collection sizes", () => {
    const base = {
      expectedRevision: EDITOR_MAX_EXPECTED_REVISION,
      leaseToken: "lease-token",
      leaseFence: 7,
      fixtureUpdates: [],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: []
    };
    expect(saveEditorStateSchema.parse(base).expectedRevision).toBe(EDITOR_MAX_EXPECTED_REVISION);
    expect(() => saveEditorStateSchema.parse({ ...base, expectedRevision: POSTGRES_INT_MAX })).toThrow();
    expect(() => restoreFloorEditorRevisionSchema.parse({
      expectedRevision: POSTGRES_INT_MAX,
      leaseToken: "lease-token",
      leaseFence: 7
    })).toThrow();
    expect(positivePostgresIntSchema.parse("2147483647")).toBe(POSTGRES_INT_MAX);
    expect(() => positivePostgresIntSchema.parse("2147483648")).toThrow();
    expect(() => positivePostgresIntSchema.parse("1e100")).toThrow();

    const fixtureUpdates = Array.from({ length: EDITOR_MAX_FIXTURE_UPDATES }, (_, index) => ({
      id: `fixture-${index}`,
      x: index
    }));
    expect(saveEditorStateSchema.parse({ ...base, fixtureUpdates }).fixtureUpdates).toHaveLength(
      EDITOR_MAX_FIXTURE_UPDATES
    );
    expect(() => saveEditorStateSchema.parse({
      ...base,
      fixtureUpdates: [...fixtureUpdates, { id: "fixture-over-limit", x: 0 }]
    })).toThrow();

    expect(() => saveEditorStateSchema.parse({
      ...base,
      objectDeletes: Array.from({ length: EDITOR_MAX_MAP_OBJECT_MUTATIONS + 1 }, (_, index) => `object-${index}`)
    })).toThrow();
  });

  it("bounds editor strings and validates type-specific point arrays", () => {
    const triangle = {
      type: "triangle" as const,
      x: 10,
      y: 20,
      width: 30,
      height: 40,
      rotation: 0,
      points: [{ x: 15, y: 0 }, { x: 30, y: 40 }, { x: 0, y: 40 }],
      text: null,
      strokeColor: "#111111",
      fillColor: null,
      strokeWidth: 2,
      fontSize: null,
      zIndex: POSTGRES_INT_MAX,
      locked: false,
      visible: true
    };

    expect(floorMapObjectDraftSchema.parse(triangle)).toEqual(triangle);
    expect(() => floorMapObjectDraftSchema.parse({ ...triangle, type: "rectangle", points: triangle.points })).toThrow();
    expect(() => floorMapObjectDraftSchema.parse({ ...triangle, points: {} })).toThrow();
    expect(() => floorMapObjectDraftSchema.parse({ ...triangle, points: triangle.points.slice(0, 2) })).toThrow();
    expect(() => floorMapObjectDraftSchema.parse({ ...triangle, zIndex: POSTGRES_INT_MAX + 1 })).toThrow();
    expect(() => floorMapObjectDraftSchema.parse({ ...triangle, text: "x".repeat(EDITOR_MAX_TEXT_LENGTH + 1) })).toThrow();
    expect(() => fixtureLayoutUpdateSchema.parse({ id: "x".repeat(EDITOR_MAX_ID_LENGTH + 1), x: 1 })).toThrow();
  });

  it("coerces and bounds floor editor revision cursor pagination", () => {
    expect(editorRevisionListQuerySchema.parse({})).toEqual({ limit: EDITOR_REVISION_DEFAULT_LIMIT });
    expect(editorRevisionListQuerySchema.parse({ cursor: "42", limit: "10" })).toEqual({ cursor: 42, limit: 10 });
    expect(() => editorRevisionListQuerySchema.parse({ cursor: "-1" })).toThrow();
    expect(() => editorRevisionListQuerySchema.parse({ limit: "101" })).toThrow();
  });
});
