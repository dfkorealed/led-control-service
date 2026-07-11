import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";
import { GatewayOnboardingService } from "./gateway-onboarding.service";

describe("GatewayOnboardingService", () => {
  const siteId = "00000000-0000-4000-8000-000000000003";
  const gatewayId = "00000000-0000-4000-8000-000000000004";
  const user = { id: "user-1", organizationId: "org-1", role: "admin" };

  async function createFixture() {
    const serviceForHash = new GatewayOnboardingService({} as PrismaService);
    const claimCodeHash = await serviceForHash.hashClaimCode("claim-code-1234");
    const inventory = {
      id: "inventory-1",
      serialNumber: "GW-PROD-001",
      claimCodeHash: claimCodeHash as string | null,
      certificateFingerprint: "AA:BB:CC",
      claimedGatewayId: null as string | null,
      claimedAt: null as Date | null,
      disabledAt: null as Date | null
    };
    const prisma: any = {
      gatewayInventory: { findUnique: jest.fn(async () => ({ ...inventory })) },
      gatewayClaimAudit: { count: jest.fn().mockResolvedValue(0), create: jest.fn().mockResolvedValue({}) },
      site: { findFirst: jest.fn().mockResolvedValue({ id: siteId, organizationId: "org-1" }) },
      gateway: {
        create: jest.fn().mockImplementation(async ({ data }) => ({ id: gatewayId, ...data }))
      },
      $transaction: jest.fn(async (callback: (tx: any) => Promise<unknown>) => callback(prisma))
    };
    prisma.gatewayInventory.updateMany = jest.fn().mockImplementation(async () => {
      if (inventory.claimedGatewayId || !inventory.claimCodeHash) return { count: 0 };
      inventory.claimedGatewayId = gatewayId;
      inventory.claimCodeHash = null;
      inventory.claimedAt = new Date();
      return { count: 1 };
    });
    return { service: new GatewayOnboardingService(prisma), prisma, inventory };
  }

  it("claims a manufactured gateway once and consumes the claim code", async () => {
    const { service, inventory } = await createFixture();

    const result = await service.claimGateway(user, {
      siteId,
      serialNumber: "GW-PROD-001",
      claimCode: "claim-code-1234",
      name: "B2 Gateway",
      ipAddress: "127.0.0.1"
    });

    expect(result).toMatchObject({ status: "claimed", gatewayId, siteId, serialNumber: "GW-PROD-001" });
    expect(inventory.claimCodeHash).toBeNull();
    await expect(
      service.claimGateway(user, { siteId, serialNumber: "GW-PROD-001", claimCode: "claim-code-1234", name: "B2 Gateway" })
    ).rejects.toThrow("gateway is already claimed");
  });

  it("rejects viewer claims", async () => {
    const { service } = await createFixture();

    await expect(
      service.claimGateway({ ...user, role: "viewer" }, { siteId, serialNumber: "GW-PROD-001", claimCode: "claim-code-1234", name: "B2" })
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("does not expose assignment when the device certificate fingerprint differs", async () => {
    const { service } = await createFixture();

    await expect(service.bootstrapGateway({ serialNumber: "GW-PROD-001", certificateFingerprint: "FF:EE:DD" })).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });
});
