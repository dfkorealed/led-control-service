import { GatewayOnboardingController } from "./gateway-onboarding.controller";

describe("GatewayOnboardingController", () => {
  it("passes the authenticated user and request IP to claim", async () => {
    const service = { claimGateway: jest.fn().mockResolvedValue({ status: "claimed" }) };
    const controller = new GatewayOnboardingController(service as never);
    const user = { id: "user-1", organizationId: "org-1", role: "admin" } as never;
    const body = { siteId: "site-1", serialNumber: "GW-1", claimCode: "once", name: "B1 gateway" };

    await controller.claimGateway(user, body, { ip: "127.0.0.1", headers: {} } as never);

    expect(service.claimGateway).toHaveBeenCalledWith(user, { ...body, ipAddress: "127.0.0.1" });
  });

  it("uses only the fingerprint attached by the device certificate guard", async () => {
    const service = { bootstrapGateway: jest.fn().mockResolvedValue({ status: "assigned" }) };
    const controller = new GatewayOnboardingController(service as never);

    await controller.bootstrapGateway(
      { serialNumber: "GW-1", certificateFingerprint: "untrusted-body-value" } as never,
      { headers: {}, deviceCertificateFingerprint: "AABB01" } as never
    );

    expect(service.bootstrapGateway).toHaveBeenCalledWith({ serialNumber: "GW-1", certificateFingerprint: "AABB01" });
  });

  it("passes the authenticated user to inventory disable", async () => {
    const service = { disableInventory: jest.fn().mockResolvedValue({ status: "disabled" }) };
    const controller = new GatewayOnboardingController(service as never);
    const user = { id: "user-1", organizationId: "org-1", role: "admin" } as never;

    await controller.disableInventory(user, "inventory-1");

    expect(service.disableInventory).toHaveBeenCalledWith(user, "inventory-1");
  });
});
