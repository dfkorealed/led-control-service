import { enrollGatewayInventory } from "./enroll-gateway-inventory";

describe("enrollGatewayInventory", () => {
  it("stores only the claim hash and normalized certificate fingerprint", async () => {
    const create = jest.fn().mockResolvedValue({ id: "inventory-1" });
    const hash = jest.fn().mockResolvedValue("scrypt$salt$hash");
    await enrollGatewayInventory(
      { gatewayInventory: { create } },
      { serialNumber: " GW-001 ", claimCode: " one-time ", certificateFingerprint: "AA:".repeat(31) + "AA" },
      hash
    );
    expect(hash).toHaveBeenCalledWith("one-time");
    expect(create).toHaveBeenCalledWith({ data: {
      serialNumber: "GW-001", claimCodeHash: "scrypt$salt$hash", certificateFingerprint: "AA".repeat(32)
    } });
  });

  it("creates manufacturing inventory before a device certificate is issued", async () => {
    const create = jest.fn().mockResolvedValue({ id: "inventory-1" });
    const hash = jest.fn().mockResolvedValue("scrypt$salt$hash");

    await enrollGatewayInventory(
      { gatewayInventory: { create } },
      { serialNumber: " GW-001 ", claimCode: " one-time " },
      hash
    );

    expect(hash).toHaveBeenCalledWith("one-time");
    expect(create).toHaveBeenCalledWith({
      data: { serialNumber: "GW-001", claimCodeHash: "scrypt$salt$hash" }
    });
  });

  it("rejects an invalid certificate fingerprint before writing", async () => {
    const create = jest.fn();
    await expect(enrollGatewayInventory(
      { gatewayInventory: { create } },
      { serialNumber: "GW-001", claimCode: "once", certificateFingerprint: "not-a-fingerprint" },
      jest.fn()
    )).rejects.toThrow("certificateFingerprint must be a SHA-256 fingerprint");
    expect(create).not.toHaveBeenCalled();
  });
});
