import { BadRequestException, Injectable, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";

const MAX_FIXTURE_SEQUENCE = 2_147_483_647;
const MIN_MESH_UNICAST_ADDRESS = 0x0001;
const MAX_MESH_UNICAST_ADDRESS = 0x7fff;

@Injectable()
export class RegistrationAllocationService {
  async reserveFixtureNumbers(
    tx: Prisma.TransactionClient,
    floorId: string,
    count: number,
    minimumStart = 1
  ): Promise<number[]> {
    this.assertPositiveInteger(count, "reservation count must be a positive integer");
    this.assertPositiveInteger(minimumStart, "minimum fixture number must be a positive integer");

    const rows = await tx.$queryRaw<Array<{ nextFixtureSequence: number }>>`
      SELECT "nextFixtureSequence"
      FROM "Floor"
      WHERE "id" = ${floorId}
      FOR UPDATE
    `;
    const floor = rows[0];
    if (!floor) {
      throw new NotFoundException("floor not found");
    }

    const start = Math.max(floor.nextFixtureSequence + 1, minimumStart);
    const end = start + count - 1;
    if (end > MAX_FIXTURE_SEQUENCE) {
      throw new BadRequestException("fixture sequence range exhausted");
    }

    await tx.floor.update({
      where: { id: floorId },
      data: { nextFixtureSequence: { increment: end - floor.nextFixtureSequence } },
      select: { nextFixtureSequence: true }
    });

    return this.range(start, count);
  }

  async reserveMeshAddresses(
    tx: Prisma.TransactionClient,
    gatewayId: string,
    count: number
  ): Promise<string[]> {
    this.assertPositiveInteger(count, "reservation count must be a positive integer");

    const rows = await tx.$queryRaw<Array<{ nextMeshUnicastAddress: number }>>`
      SELECT "nextMeshUnicastAddress"
      FROM "Gateway"
      WHERE "id" = ${gatewayId}
      FOR UPDATE
    `;
    const gateway = rows[0];
    if (!gateway) {
      throw new NotFoundException("gateway not found");
    }

    const start = Math.max(gateway.nextMeshUnicastAddress, MIN_MESH_UNICAST_ADDRESS);
    const end = start + count - 1;
    if (end > MAX_MESH_UNICAST_ADDRESS) {
      throw new BadRequestException("mesh unicast address range exhausted");
    }

    await tx.gateway.update({
      where: { id: gatewayId },
      data: { nextMeshUnicastAddress: { increment: end + 1 - gateway.nextMeshUnicastAddress } },
      select: { nextMeshUnicastAddress: true }
    });

    return this.range(start, count).map((address) => `0x${address.toString(16).padStart(4, "0")}`);
  }

  private assertPositiveInteger(value: number, message: string) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new BadRequestException(message);
    }
  }

  private range(start: number, count: number) {
    return Array.from({ length: count }, (_, index) => start + index);
  }
}
