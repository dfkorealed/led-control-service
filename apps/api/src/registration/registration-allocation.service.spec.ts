import { NotFoundException } from "@nestjs/common";
import { RegistrationAllocationService } from "./registration-allocation.service";

describe("RegistrationAllocationService", () => {
  const floorId = "00000000-0000-4000-8000-000000000003";
  const gatewayId = "00000000-0000-4000-8000-000000000004";

  it("reserves consecutive fixture numbers and mesh addresses from locked counters", async () => {
    const tx: any = {
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ nextFixtureSequence: 0 }])
        .mockResolvedValueOnce([{ nextMeshUnicastAddress: 0x0100 }]),
      floor: { update: jest.fn().mockResolvedValue({ nextFixtureSequence: 3 }) },
      gateway: { update: jest.fn().mockResolvedValue({ nextMeshUnicastAddress: 0x0102 }) }
    };
    const service = new RegistrationAllocationService();

    await expect(service.reserveFixtureNumbers(tx, floorId, 3)).resolves.toEqual([1, 2, 3]);
    await expect(service.reserveMeshAddresses(tx, gatewayId, 2)).resolves.toEqual(["0x0100", "0x0101"]);
    expect(tx.floor.update).toHaveBeenCalledWith({
      where: { id: floorId },
      data: { nextFixtureSequence: { increment: 3 } },
      select: { nextFixtureSequence: true }
    });
    expect(tx.gateway.update).toHaveBeenCalledWith({
      where: { id: gatewayId },
      data: { nextMeshUnicastAddress: { increment: 2 } },
      select: { nextMeshUnicastAddress: true }
    });
  });

  it("advances a floor counter to the requested minimum without reusing skipped numbers", async () => {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ nextFixtureSequence: 5 }]),
      floor: { update: jest.fn().mockResolvedValue({ nextFixtureSequence: 11 }) }
    };
    const service = new RegistrationAllocationService();

    await expect(service.reserveFixtureNumbers(tx, floorId, 2, 10)).resolves.toEqual([10, 11]);
    expect(tx.floor.update).toHaveBeenCalledWith(expect.objectContaining({
      data: { nextFixtureSequence: { increment: 6 } }
    }));
  });

  it("rejects mesh reservations after the unicast range is exhausted without updating", async () => {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([{ nextMeshUnicastAddress: 0x8000 }]),
      gateway: { update: jest.fn() }
    };
    const service = new RegistrationAllocationService();

    await expect(service.reserveMeshAddresses(tx, gatewayId, 1)).rejects.toThrow("mesh unicast address range exhausted");
    expect(tx.gateway.update).not.toHaveBeenCalled();
  });

  it("returns an opaque not-found error when the allocation owner does not exist", async () => {
    const tx: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      floor: { update: jest.fn() }
    };
    const service = new RegistrationAllocationService();

    await expect(service.reserveFixtureNumbers(tx, floorId, 1)).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.floor.update).not.toHaveBeenCalled();
  });
});
