import { Prisma } from "@prisma/client";
import { EnergyDimensionHistoryService } from "./energy-dimension-history.service";

const ids = {
  site: "10000000-0000-4000-8000-000000000001",
  fixture: "10000000-0000-4000-8000-000000000002",
  identity: "10000000-0000-4000-8000-000000000003",
  floor: "10000000-0000-4000-8000-000000000004",
  group: "10000000-0000-4000-8000-000000000005",
  groupIdentity: "10000000-0000-4000-8000-000000000006"
};

describe("EnergyDimensionHistoryService", () => {
  it("creates a fixture identity and initial dimension in the caller transaction", async () => {
    const tx = harness();
    tx.energyFixtureIdentity.findUnique.mockResolvedValue(null);
    tx.energyFixtureIdentity.create.mockResolvedValue({ id: ids.identity });

    await expect(new EnergyDimensionHistoryService().recordFixtureDimensions(tx, fixtureInput())).resolves.toBe(ids.identity);

    expect(tx.energyFixtureIdentity.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ fixtureId: ids.fixture, siteId: ids.site })
    }));
    expect(tx.energyFixtureDimensionVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ energyFixtureId: ids.identity, name: "B1-L01", floorName: "B1" })
    }));
  });

  it("does not create a version when analytical dimensions are unchanged", async () => {
    const tx = harness();
    tx.energyFixtureIdentity.findUnique.mockResolvedValue({ id: ids.identity });
    tx.energyFixtureDimensionVersion.findFirst.mockResolvedValue({
      id: "version-1", name: "B1-L01", floorId: ids.floor, floorName: "B1", ratedWatt: new Prisma.Decimal(40)
    });

    await new EnergyDimensionHistoryService().recordFixtureDimensions(tx, fixtureInput());

    expect(tx.energyFixtureDimensionVersion.update).not.toHaveBeenCalled();
    expect(tx.energyFixtureDimensionVersion.create).not.toHaveBeenCalled();
  });

  it("closes the old fixture version before creating a changed version", async () => {
    const tx = harness();
    tx.energyFixtureIdentity.findUnique.mockResolvedValue({ id: ids.identity });
    tx.energyFixtureDimensionVersion.findFirst.mockResolvedValue({
      id: "version-1", name: "Old", floorId: ids.floor, floorName: "B1", ratedWatt: new Prisma.Decimal(40)
    });
    const effectiveAt = new Date("2026-09-11T10:00:00.000Z");

    await new EnergyDimensionHistoryService().recordFixtureDimensions(tx, fixtureInput({ effectiveAt }));

    expect(tx.energyFixtureDimensionVersion.update).toHaveBeenCalledWith({
      where: { id: "version-1" }, data: { effectiveTo: effectiveAt }
    });
    expect(tx.energyFixtureDimensionVersion.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ effectiveFrom: effectiveAt, name: "B1-L01" })
    }));
  });

  it("closes removed memberships and creates only newly added memberships", async () => {
    const tx = harness();
    tx.energyGroupIdentity.findUnique.mockResolvedValue({ id: ids.groupIdentity });
    tx.energyFixtureIdentity.findMany.mockResolvedValue([
      { id: "energy-a", fixtureId: "fixture-a" },
      { id: "energy-b", fixtureId: "fixture-b" }
    ]);
    tx.energyGroupMembershipVersion.findMany.mockResolvedValue([
      { id: "membership-a", energyFixtureId: "energy-a" }
    ]);
    const effectiveAt = new Date("2026-09-11T11:00:00.000Z");

    await new EnergyDimensionHistoryService().replaceGroupMemberships(tx, {
      groupId: ids.group,
      fixtureIds: ["fixture-b"],
      effectiveAt
    });

    expect(tx.energyGroupMembershipVersion.update).toHaveBeenCalledWith({
      where: { id: "membership-a" }, data: { effectiveTo: effectiveAt }
    });
    expect(tx.energyGroupMembershipVersion.create).toHaveBeenCalledWith({
      data: { energyGroupId: ids.groupIdentity, energyFixtureId: "energy-b", effectiveFrom: effectiveAt }
    });
  });
});

function fixtureInput(overrides: Record<string, unknown> = {}) {
  return {
    fixtureId: ids.fixture,
    siteId: ids.site,
    name: "B1-L01",
    floorId: ids.floor,
    floorName: "B1",
    ratedWatt: new Prisma.Decimal(40),
    trackingStartedAt: new Date("2026-09-01T00:00:00.000Z"),
    effectiveAt: new Date("2026-09-11T00:00:00.000Z"),
    ...overrides
  };
}

function harness(): any {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    energyFixtureIdentity: {
      findUnique: jest.fn(), create: jest.fn(), findMany: jest.fn()
    },
    energyFixtureDimensionVersion: {
      findFirst: jest.fn(), update: jest.fn(), create: jest.fn()
    },
    energyGroupIdentity: {
      findUnique: jest.fn(), create: jest.fn()
    },
    energyGroupDimensionVersion: {
      findFirst: jest.fn(), update: jest.fn(), create: jest.fn()
    },
    energyGroupMembershipVersion: {
      findMany: jest.fn(), update: jest.fn(), create: jest.fn(), updateMany: jest.fn()
    }
  };
}
