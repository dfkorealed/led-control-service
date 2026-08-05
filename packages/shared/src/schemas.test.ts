import { describe, expect, it } from "vitest";
import {
  floorEditorSnapshotSchema,
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
        type: "text", x: 10, y: 20, width: null, height: null, rotation: 0,
        text: "Entrance", strokeColor: "#111111", strokeWidth: 2, locked: false, visible: true
      }]
    }).objectCreates[0]).toEqual({
      type: "text", x: 10, y: 20, width: null, height: null, rotation: 0,
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
});
