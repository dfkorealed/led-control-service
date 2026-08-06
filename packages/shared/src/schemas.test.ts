import { describe, expect, it } from "vitest";
import {
  EDITOR_MAX_FIXTURE_UPDATES,
  EDITOR_MAX_EXPECTED_REVISION,
  EDITOR_MAX_ID_LENGTH,
  EDITOR_MAX_MAP_OBJECT_MUTATIONS,
  EDITOR_MAX_TEXT_LENGTH,
  EDITOR_REVISION_DEFAULT_LIMIT,
  POSTGRES_INT_MAX,
  editorRevisionListQuerySchema,
  floorEditorSnapshotSchema,
  legacyFloorPlanEffectiveSchema,
  parseFloorEditorSnapshot,
  positivePostgresIntSchema,
  fixtureLayoutUpdateSchema,
  floorMapObjectDraftSchema,
  floorPlanUpdateSchema,
  provisionDeviceSchema,
  provisioningCompletedSchema,
  provisioningFailedSchema,
  provisioningScanStartSchema,
  restoreFloorEditorRevisionSchema,
  saveEditorStateSchema,
  unprovisionedDeviceFoundSchema
} from "./schemas";
import { mqttTopics } from "./mqtt";

describe("shared schemas", () => {
  it("defines provisioning MQTT topics and validates discovered node events", () => {
    expect(
      mqttTopics.provisioningScanStart(
        "00000000-0000-4000-8000-000000000003",
        "00000000-0000-4000-8000-000000000004"
      )
    ).toBe(
      "sites/00000000-0000-4000-8000-000000000003/gateways/00000000-0000-4000-8000-000000000004/commands/provisioning-scan-start"
    );

    const scanCommand = provisioningScanStartSchema.parse({
      sessionId: "11111111-1111-4111-8111-111111111111",
      siteId: "00000000-0000-4000-8000-000000000003",
      gatewayId: "00000000-0000-4000-8000-000000000004",
      floorId: "00000000-0000-4000-8000-000000000005",
      requestedBy: "55555555-5555-4555-8555-555555555555",
      requestedAt: "2026-07-01T00:00:00.000Z"
    });

    expect(scanCommand.floorId).toBe("00000000-0000-4000-8000-000000000005");

    const discovered = unprovisionedDeviceFoundSchema.parse({
      sessionId: "11111111-1111-4111-8111-111111111111",
      deviceUuid: "esp32h2-demo-001",
      serialNumber: "LC-B2-001",
      rssi: -54,
      oobCapability: "static-oob",
      firmwareVersion: "esp32h2-0.1.0",
      discoveredAt: "2026-07-01T00:00:01.000Z"
    });

    expect(discovered.rssi).toBe(-54);
  });

  it("defines provisioning command and result event contracts", () => {
    expect(
      mqttTopics.provisionDevice(
        "00000000-0000-4000-8000-000000000003",
        "00000000-0000-4000-8000-000000000004"
      )
    ).toBe(
      "sites/00000000-0000-4000-8000-000000000003/gateways/00000000-0000-4000-8000-000000000004/commands/provision-device"
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

  it("validates atomic floor editor save and restore inputs", () => {
    const save = saveEditorStateSchema.parse({
      expectedRevision: 3,
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
    expect(restoreFloorEditorRevisionSchema.parse({ expectedRevision: 4 })).toEqual({ expectedRevision: 4 });
    expect(() => saveEditorStateSchema.parse({ ...save, expectedRevision: -1 })).toThrow();
    expect(() => restoreFloorEditorRevisionSchema.parse({ expectedRevision: 1.5 })).toThrow();

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
      fixtureUpdates: [],
      objectCreates: [],
      objectUpdates: [],
      objectDeletes: []
    };
    expect(saveEditorStateSchema.parse(base).expectedRevision).toBe(EDITOR_MAX_EXPECTED_REVISION);
    expect(() => saveEditorStateSchema.parse({ ...base, expectedRevision: POSTGRES_INT_MAX })).toThrow();
    expect(() => restoreFloorEditorRevisionSchema.parse({ expectedRevision: POSTGRES_INT_MAX })).toThrow();
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
