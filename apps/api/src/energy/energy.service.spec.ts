import { EnergyService } from "./energy.service";

describe("EnergyService", () => {
  it("estimates kWh and cost from rated watt, brightness, hours, and tariff", () => {
    const service = new EnergyService({} as never);
    const result = service.calculateEstimatedUsage({
      ratedWatt: 40,
      brightness: 50,
      hours: 10,
      tariffKwhRate: 160
    });

    expect(result.kwh).toBe(0.2);
    expect(result.cost).toBe(32);
  });

  it("estimates energy only from the authenticated organization default site", async () => {
    const prisma = {
      site: {
        findFirstOrThrow: jest.fn().mockResolvedValue({
          tariffKwhRate: "160.00",
          floors: [{ fixtures: [{ ratedWatt: "40.00", brightness: 50 }] }]
        })
      }
    };
    const service = new EnergyService(prisma as never);

    await service.getDefaultSiteEstimate("organization-1");

    expect(prisma.site.findFirstOrThrow).toHaveBeenCalledWith({
      where: { organizationId: "organization-1" },
      include: { floors: { include: { fixtures: true } } }
    });
  });
});
