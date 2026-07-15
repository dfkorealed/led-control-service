import { describe, expect, it } from "vitest";
import {
  applyProvisionDevice,
  applyProvisioningScan
} from "./gateway";
import { StubProvisioningAdapter, StubProvisioningScannerAdapter } from "../test/stub-adapters";

describe("gateway provisioning", () => {
  it("creates discovered node events from provisioning scan commands", async () => {
    const nodes = await applyProvisioningScan(new StubProvisioningScannerAdapter({ count: 2, floorName: "B1" }), {
      sessionId: "11111111-1111-4111-8111-111111111111",
      siteId: "22222222-2222-4222-8222-222222222222",
      gatewayId: "33333333-3333-4333-8333-333333333333",
      floorId: "44444444-4444-4444-8444-444444444444",
      requestedBy: "55555555-5555-4555-8555-555555555555",
      requestedAt: "2026-07-01T00:00:00.000Z"
    });

    expect(nodes).toHaveLength(2);
    expect(nodes[0]).toMatchObject({
      sessionId: "11111111-1111-4111-8111-111111111111",
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
});
