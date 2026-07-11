import { describe, expect, it, vi } from "vitest";
import { BootstrapClient } from "./bootstrap-client";

describe("BootstrapClient", () => {
  it("returns a validated assignment without exposing credentials", async () => {
    const request = vi.fn().mockResolvedValue({
      status: "assigned",
      assignment: {
        siteId: "site-1",
        gatewayId: "gateway-1",
        serialNumber: "GW-001",
        mqttUrl: "mqtts://broker.example:8883",
        configVersion: 2
      },
      claimCode: "must-not-be-consumed"
    });
    const client = new BootstrapClient({ serialNumber: "GW-001", request });

    await expect(client.fetchAssignment()).resolves.toEqual({
      siteId: "site-1",
      gatewayId: "gateway-1",
      serialNumber: "GW-001",
      mqttUrl: "mqtts://broker.example:8883",
      configVersion: 2
    });
    expect(request).toHaveBeenCalledWith({ serialNumber: "GW-001" });
  });

  it("returns null while the gateway remains unclaimed", async () => {
    const client = new BootstrapClient({
      serialNumber: "GW-001",
      request: vi.fn().mockResolvedValue({ status: "unclaimed", retryAfterSeconds: 10 })
    });

    await expect(client.fetchAssignment()).resolves.toBeNull();
  });

  it("rejects an assignment issued for another serial", async () => {
    const client = new BootstrapClient({
      serialNumber: "GW-001",
      request: vi.fn().mockResolvedValue({
        status: "assigned",
        assignment: {
          siteId: "site-1",
          gatewayId: "gateway-1",
          serialNumber: "GW-OTHER",
          mqttUrl: "mqtts://broker.example:8883",
          configVersion: 1
        }
      })
    });

    await expect(client.fetchAssignment()).rejects.toThrow("serial mismatch");
  });
});
