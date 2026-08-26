import { describe, expect, it, vi } from "vitest";
import {
  applyProvisionDevice,
  applyProvisioningScan,
  publishProvisioningScanLifecycle
} from "./gateway";
import { StubProvisioningAdapter, StubProvisioningScannerAdapter } from "../test/stub-adapters";

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
