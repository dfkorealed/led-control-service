import { Injectable } from "@nestjs/common";
import { Prisma, type FixtureRegistrationRemovalOperation } from "@prisma/client";
import { EnergyDimensionHistoryService } from "../energy/energy-dimension-history.service";
import { FixtureEnergyCheckpointService } from "../energy/fixture-state-ingestion.service";

@Injectable()
export class FixtureRegistrationRetirementService {
  constructor(private readonly energy: FixtureEnergyCheckpointService, private readonly dimensions: EnergyDimensionHistoryService) {}

  async retire(tx: Prisma.TransactionClient, row: FixtureRegistrationRemovalOperation, now: Date) {
    await this.energy.closeRetirementInterval(tx, row.fixtureId, now);
    await this.dimensions.retireFixture(tx, row.fixtureId, now);
    await tx.floorLightSlot.updateMany({ where: { floorId: row.floorId, assignedFixtureId: row.fixtureId }, data: { assignedFixtureId: null } });
    await tx.fixture.update({ where: { id: row.fixtureId }, data: { retiredAt: now, placementStatus: "unplaced", positionVerifiedAt: null } });
    await tx.meshNode.update({ where: { id: row.meshNodeId }, data: { retiredAt: now, deviceUuid: null } });
    // Preserve map generations, all revision snapshots and unrelated geometry.
    // Their fixture overlays are projected from current registration eligibility.
    await tx.meshControlGroupMember.deleteMany({ where: { gatewayId: row.gatewayId, meshNodeId: row.meshNodeId, desired: false } });
  }
}
