import { EnergyService } from "./energy.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { NotFoundException } from "@nestjs/common";

describe("EnergyService", () => {
  it("estimates kWh and cost from rated watt, brightness, hours, and tariff", () => {
    const service = new EnergyService({} as never, {} as never);
    const result = service.calculateEstimatedUsage({
      ratedWatt: 40,
      brightness: 50,
      hours: 10,
      tariffKwhRate: 160
    });

    expect(result.kwh).toBe(0.2);
    expect(result.cost).toBe(32);
  });

  it("estimates energy only from the authenticated user's accessible default site", async () => {
    const prisma = {
      site: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          tariffKwhRate: "160.00",
          floors: [{ fixtures: [{ ratedWatt: "40.00", brightness: 50 }] }]
        })
      }
    };
    const user: AuthenticatedUser = {
      id: "user-1", organizationId: "org-1", organizationType: "customer", email: "admin@example.com", name: "Admin", role: "admin", status: "active"
    };
    const siteAccess = {
      assert: jest.fn().mockResolvedValue({ id: "site-1" }),
      listAccessibleSiteIds: jest.fn().mockResolvedValue(["site-1"])
    };
    const service = new (EnergyService as any)(prisma, siteAccess);

    await service.getDefaultSiteEstimate(user);

    expect(siteAccess.assert).toHaveBeenCalledWith(user, "site-1", "read");
    expect(prisma.site.findFirstOrThrow).toHaveBeenCalledWith({
      where: { id: "site-1" },
      include: { floors: { include: { fixtures: true } } }
    });
  });

  it("uses a deterministic sorted accessible-site fallback when no siteId is selected", async () => {
    const prisma = {
      site: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          tariffKwhRate: "160.00",
          floors: [{ fixtures: [{ ratedWatt: "40.00", brightness: 50 }] }]
        })
      }
    };
    const user: AuthenticatedUser = {
      id: "user-1", organizationId: "org-1", organizationType: "service_provider", email: "operator@example.com", name: "Operator", role: "operator", status: "active"
    };
    const siteAccess = {
      assert: jest.fn().mockResolvedValue({ id: "site-a" }),
      listAccessibleSiteIds: jest.fn().mockResolvedValue(["site-b", "site-a"])
    };
    const service = new (EnergyService as any)(prisma, siteAccess);

    await service.getDefaultSiteEstimate(user);

    expect(siteAccess.assert).toHaveBeenCalledWith(user, "site-a", "read");
    expect(prisma.site.findFirstOrThrow).toHaveBeenCalledWith({
      where: { id: "site-a" },
      include: { floors: { include: { fixtures: true } } }
    });
  });

  it("does not query fixtures for an unauthorized site-scoped estimate", async () => {
    const user: AuthenticatedUser = {
      id: "user-1", organizationId: "org-1", organizationType: "customer", email: "viewer@example.com", name: "Viewer", role: "viewer", status: "active"
    };
    const prisma = { site: { findFirstOrThrow: jest.fn() } };
    const siteAccess = {
      listAccessibleSiteIds: jest.fn(),
      assert: jest.fn().mockRejectedValue(new NotFoundException("site not found"))
    };
    const service = new EnergyService(prisma as never, siteAccess as never);

    await expect(service.getSiteEstimate(user, "site-foreign")).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.site.findFirstOrThrow).not.toHaveBeenCalled();
  });

  it("does not return an estimate when the user has no accessible site", async () => {
    const user: AuthenticatedUser = {
      id: "user-1", organizationId: "org-1", organizationType: "service_provider", email: "operator@example.com", name: "Operator", role: "operator", status: "active"
    };
    const prisma = { site: { findFirstOrThrow: jest.fn() } };
    const siteAccess = { listAccessibleSiteIds: jest.fn().mockResolvedValue([]), assert: jest.fn() };

    await expect(new EnergyService(prisma as never, siteAccess as never).getDefaultSiteEstimate(user)).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(prisma.site.findFirstOrThrow).not.toHaveBeenCalled();
  });
});
