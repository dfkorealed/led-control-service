import { ForbiddenException, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { SiteAccessService } from "../access/site-access.service";
import { PrismaService } from "../prisma/prisma.service";
import { CertificateLifecycleService } from "../pki/certificate-lifecycle.service";
import { GatewayOnboardingService } from "./gateway-onboarding.service";

describe("GatewayOnboardingService", () => {
  const siteId = "00000000-0000-4000-8000-000000000003";
  const gatewayId = "00000000-0000-4000-8000-000000000004";
  const user: AuthenticatedUser = {
    id: "user-1", organizationId: "provider-org-1", organizationType: "service_provider", loginId: "fixture_user", email: "operator@example.com",
    name: "Operator", role: "operator", status: "active"
  };

  async function createFixture() {
    const serviceForHash = new GatewayOnboardingService({} as PrismaService, {} as SiteAccessService);
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
    const siteAccess = { assert: jest.fn().mockResolvedValue({ id: siteId }) };
    return { service: new GatewayOnboardingService(prisma, siteAccess as unknown as SiteAccessService), prisma, inventory, siteAccess };
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

  it("rejects customer admins and viewers from claiming a gateway", async () => {
    const { service } = await createFixture();

    await expect(
      service.claimGateway({ ...user, organizationType: "customer", organizationId: "customer-org", role: "admin" }, { siteId, serialNumber: "GW-PROD-001", claimCode: "claim-code-1234", name: "B2" })
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      service.claimGateway({ ...user, organizationType: "customer", organizationId: "customer-org", role: "viewer" }, { siteId, serialNumber: "GW-PROD-001", claimCode: "claim-code-1234", name: "B2" })
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("hides gateway claim from an unassigned operator", async () => {
    const { service, siteAccess } = await createFixture();
    siteAccess.assert.mockRejectedValue(new NotFoundException("site not found"));

    await expect(
      service.claimGateway(user, { siteId, serialNumber: "GW-PROD-001", claimCode: "claim-code-1234", name: "B2" })
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("does not expose assignment when the device certificate fingerprint differs", async () => {
    const { service } = await createFixture();

    await expect(service.bootstrapGateway({ serialNumber: "GW-PROD-001", certificateFingerprint: "FF:EE:DD" })).rejects.toBeInstanceOf(
      UnauthorizedException
    );
  });

  it("keeps inventory disabled when certificate revocation partially fails and retries on the next request", async () => {
    const { prisma } = await createFixture();
    prisma.gatewayInventory.findUnique.mockResolvedValue({ claimedGateway: { siteId } });
    const disabledInventory = { id: "inventory-1", disabledAt: null as Date | null };
    prisma.gatewayInventory.findFirst = jest.fn().mockImplementation(() => Promise.resolve(disabledInventory));
    prisma.gatewayInventory.update = jest.fn().mockImplementation(() => {
      disabledInventory.disabledAt = new Date();
      return Promise.resolve(disabledInventory);
    });
    const lifecycle = {
      revokeInventoryCertificates: jest
        .fn()
        .mockRejectedValueOnce(new Error("Vault unavailable"))
        .mockResolvedValueOnce({ revoked: 2 })
    } as unknown as CertificateLifecycleService;
    const service = new GatewayOnboardingService(prisma, { assert: jest.fn().mockResolvedValue({ id: siteId }) } as unknown as SiteAccessService, lifecycle);

    await expect(service.disableInventory(user, "inventory-1")).rejects.toThrow("certificate revocation pending");
    await expect(service.disableInventory(user, "inventory-1")).resolves.toEqual({ status: "disabled", revoked: 2 });

    expect(prisma.gatewayInventory.update).toHaveBeenCalledTimes(1);
    expect(lifecycle.revokeInventoryCertificates).toHaveBeenCalledTimes(2);
  });

  it("rejects inventory disable outside the administrator organization", async () => {
    const { prisma } = await createFixture();
    prisma.gatewayInventory.findUnique.mockResolvedValue({ claimedGateway: { siteId } });
    prisma.gatewayInventory.findFirst = jest.fn().mockResolvedValue(null);
    const lifecycle = { revokeInventoryCertificates: jest.fn() } as unknown as CertificateLifecycleService;
    const service = new GatewayOnboardingService(prisma, { assert: jest.fn().mockResolvedValue({ id: siteId }) } as unknown as SiteAccessService, lifecycle);

    await expect(service.disableInventory(user, "inventory-1")).rejects.toThrow("inventory not found");

    expect(lifecycle.revokeInventoryCertificates).not.toHaveBeenCalled();
  });
});
