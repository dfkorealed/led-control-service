import { describe, expect, it, vi } from "vitest";
import {
  applyProvisionDevice,
  applyProvisioningScan,
  handleAutomationConfigPayload,
  publishProvisioningScanLifecycle
} from "./gateway";
import { StubProvisioningAdapter, StubProvisioningScannerAdapter } from "../test/stub-adapters";
import { AutomationRuntimeError } from "./automation/automation-runtime";
import { automationSnapshot } from "./automation/automation-test-fixtures";
import { configuredVehicleSensorSourceFixtureIds } from "./gateway";

describe("gateway provisioning", () => {
  it("creates discovered node events from provisioning scan commands", async () => {
    const nodes = await applyProvisioningScan(new StubProvisioningScannerAdapter({ count: 2, floorName: "B1" }), {
      sessionId: "11111111-1111-4111-8111-111111111111",
      siteId: "22222222-2222-4222-8222-222222222222",
      gatewayId: "33333333-3333-4333-8333-333333333333",
      floorId: "44444444-4444-4444-8444-444444444444",
      scanCorrelationId: "55555555-5555-4555-8555-555555555555",
      scanAttempt: 1,
      requestedAt: "2026-07-01T00:00:00.000Z"
    });

    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({
      deviceUuid: "esp32h2-b1-001",
      serialNumber: "LC-B1-001",
      oobCapability: "static-oob"
    });
  });

  it("returns provisioning completed and failed result payloads", async () => {
    const command = {
      sessionId: "11111111-1111-4111-8111-111111111111",
      siteId: "22222222-2222-4222-8222-222222222222",
      gatewayId: "33333333-3333-4333-8333-333333333333",
      nodeId: "44444444-4444-4444-8444-444444444444",
      deviceUuid: "esp32h2-b1-001",
      meshAddress: "0x0101",
      requestedAt: "2026-07-01T00:00:00.000Z"
    };

    await expect(applyProvisionDevice(new StubProvisioningAdapter(), command)).resolves.toEqual({
      completed: expect.objectContaining({
        sessionId: command.sessionId,
        nodeId: command.nodeId,
        deviceUuid: command.deviceUuid,
        meshAddress: "0x0101"
      })
    });

    await expect(
      applyProvisionDevice(
        {
          async identify() {},
          async provision() {
            throw new Error("provisioning timeout");
          }
        },
        command
      )
    ).resolves.toEqual({
      failed: expect.objectContaining({
        sessionId: command.sessionId,
        nodeId: command.nodeId,
        deviceUuid: command.deviceUuid,
        errorMessage: "provisioning timeout"
      })
    });
  });

  it("publishes only own UUID nodes followed by exactly one completed terminal event", async () => {
    const command = {
      sessionId: "11111111-1111-4111-8111-111111111111",
      siteId: "22222222-2222-4222-8222-222222222222",
      gatewayId: "33333333-3333-4333-8333-333333333333",
      floorId: "44444444-4444-4444-8444-444444444444",
      scanCorrelationId: "55555555-5555-4555-8555-555555555555",
      scanAttempt: 1,
      requestedAt: "2026-07-01T00:00:00.000Z"
    };
    const publish = vi.fn().mockResolvedValue(undefined);

    await publishProvisioningScanLifecycle({
      adapter: { scan: async () => [
        { deviceUuid: "44464b4c454401010101aabbccddeeff", serialNumber: "own", rssi: -50, oobCapability: "none", firmwareVersion: "1.0.0" },
        { deviceUuid: "other-vendor:001", serialNumber: "other", rssi: -51, oobCapability: "none", firmwareVersion: "1.0.0" }
      ] },
      command,
      nextEnvelope: async () => ({ eventId: "66666666-6666-4666-8666-666666666666", sequence: 1, occurredAt: "2026-08-26T00:00:00.000Z" }),
      publish
    });

    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[0][1]).toMatchObject({ deviceUuid: "44464b4c454401010101aabbccddeeff" });
    expect(publish.mock.calls[1][1]).toMatchObject({ acceptedNodeCount: 1 });
  });

  it("publishes exactly one failed terminal event when scanning throws", async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    await publishProvisioningScanLifecycle({
      adapter: { scan: async () => { throw new Error("Bluetooth adapter /secret/path unavailable"); } },
      command: {
        sessionId: "11111111-1111-4111-8111-111111111111", siteId: "22222222-2222-4222-8222-222222222222",
        gatewayId: "33333333-3333-4333-8333-333333333333", floorId: "44444444-4444-4444-8444-444444444444",
        scanCorrelationId: "55555555-5555-4555-8555-555555555555", scanAttempt: 1, requestedAt: "2026-07-01T00:00:00.000Z"
      },
      nextEnvelope: async () => ({ eventId: "66666666-6666-4666-8666-666666666666", sequence: 1, occurredAt: "2026-08-26T00:00:00.000Z" }),
      publish
    });

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][1]).toMatchObject({ code: "bluetooth_unavailable", message: "Bluetooth 기능을 사용할 수 없습니다." });
    expect(JSON.stringify(publish.mock.calls[0][1])).not.toContain("/secret/path");
  });

  it("does not publish a second terminal event when completed publish acknowledgement fails", async () => {
    const publish = vi.fn().mockRejectedValueOnce(new Error("broker acknowledgement lost"));

    await expect(publishProvisioningScanLifecycle({
      adapter: { scan: async () => [] },
      command: {
        sessionId: "11111111-1111-4111-8111-111111111111", siteId: "22222222-2222-4222-8222-222222222222",
        gatewayId: "33333333-3333-4333-8333-333333333333", floorId: "44444444-4444-4444-8444-444444444444",
        scanCorrelationId: "55555555-5555-4555-8555-555555555555", scanAttempt: 1, requestedAt: "2026-07-01T00:00:00.000Z"
      },
      nextEnvelope: async () => ({ eventId: "66666666-6666-4666-8666-666666666666", sequence: 1, occurredAt: "2026-08-26T00:00:00.000Z" }),
      publish
    })).rejects.toThrow("broker acknowledgement lost");

    expect(publish).toHaveBeenCalledTimes(1);
    expect(publish.mock.calls[0][1]).toMatchObject({ acceptedNodeCount: 0 });
  });
});

describe("configuredVehicleSensorSourceFixtureIds", () => {
  it("returns unique sources from enabled vehicle rules only", () => {
    const snapshot = automationSnapshot(4);
    const rule = {
      id: "00000000-0000-4000-8000-000000000098",
      name: "entrance vehicle sensor",
      status: "enabled" as const,
      sourceFixtureIds: ["source-b", "source-a"],
      targetFixtureIds: ["target-a"],
      action: { dimmingEnabled: true, brightnessPercent: 80 },
      holdSeconds: 60
    };
    snapshot.vehicleEventRules = [rule, {
      ...rule,
      id: "00000000-0000-4000-8000-000000000099",
      sourceFixtureIds: ["source-a"],
      status: "disabled"
    }];

    expect(configuredVehicleSensorSourceFixtureIds(snapshot)).toEqual(["source-a", "source-b"]);
    expect(configuredVehicleSensorSourceFixtureIds(null)).toEqual([]);
  });
});

describe("gateway automation config", () => {
  it("passes the applied ACK returned by hot reload to the durable recorder", async () => {
    const snapshot = automationSnapshot(4);
    const acknowledgement = {
      schemaVersion: 1 as const,
      gatewayId: snapshot.gatewayId,
      revision: 4,
      payloadHash: snapshot.payloadHash,
      status: "applied" as const,
      errorCode: null,
      appliedAt: "2026-08-30T01:02:03.000Z"
    };
    const hotReload = vi.fn().mockResolvedValue(acknowledgement);
    const recordAcknowledgement = vi.fn().mockResolvedValue(undefined);

    await expect(handleAutomationConfigPayload(
      Buffer.from(JSON.stringify(snapshot)),
      { gatewayId: snapshot.gatewayId, hotReload },
      recordAcknowledgement
    )).resolves.toEqual(acknowledgement);

    expect(recordAcknowledgement).toHaveBeenCalledWith(acknowledgement);
  });

  it.each([
    ["snapshot_old_revision", "snapshot_old_revision"],
    ["snapshot_revision_conflict", "snapshot_revision_conflict"],
    ["snapshot_invalid", "snapshot_invalid"]
  ] as const)("records an exact rejected ACK for %s", async (_case, code) => {
    const snapshot = automationSnapshot(4);
    const hotReload = vi.fn().mockRejectedValue(new AutomationRuntimeError(
      code,
      code,
      snapshot.revision,
      snapshot.payloadHash
    ));
    const recordAcknowledgement = vi.fn().mockResolvedValue(undefined);

    await expect(handleAutomationConfigPayload(
      Buffer.from(JSON.stringify(snapshot)),
      { gatewayId: snapshot.gatewayId, hotReload },
      recordAcknowledgement,
      () => new Date("2026-08-30T01:02:03.000Z")
    )).resolves.toEqual({
      schemaVersion: 1,
      gatewayId: snapshot.gatewayId,
      revision: 4,
      payloadHash: snapshot.payloadHash,
      status: "rejected",
      errorCode: code,
      appliedAt: "2026-08-30T01:02:03.000Z"
    });
  });

  it("does not invent an ACK identity for malformed JSON", async () => {
    const hotReload = vi.fn();
    const recordAcknowledgement = vi.fn();

    await expect(handleAutomationConfigPayload(
      Buffer.from("{not-json}"),
      { gatewayId: "00000000-0000-4000-8000-000000000004", hotReload },
      recordAcknowledgement
    )).rejects.toMatchObject({ code: "snapshot_invalid" });

    expect(hotReload).not.toHaveBeenCalled();
    expect(recordAcknowledgement).not.toHaveBeenCalled();
  });
});
