import { BadRequestException, Injectable } from "@nestjs/common";
import {
  type VehicleSensorCapabilityReportV1,
  vehicleSensorCapabilityReportV1Schema
} from "@led-control/shared";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";
import { AutomationSnapshotService, compareAutomationIds } from "./automation-snapshot.service";

interface LockedCapabilityNode {
  id: string;
  vehicleSensorCapabilityStatus: "unknown" | "supported" | "unsupported";
  vehicleSensorCapabilityVerifiedAt: Date | null;
  fixtureId: string | null;
}

@Injectable()
export class VehicleSensorCapabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly automationSnapshot: AutomationSnapshotService
  ) {}

  async applyReport(rawReport: unknown) {
    const parsed = vehicleSensorCapabilityReportV1Schema.safeParse(rawReport);
    if (!parsed.success) {
      throw new BadRequestException("invalid vehicle sensor capability report");
    }
    const report = parsed.data;

    return this.prisma.$transaction(async (tx) => {
      await this.automationSnapshot.lockMutation(tx);
      const node = await this.lockOwnedNode(tx, report);
      if (!node) {
        throw new BadRequestException("vehicle sensor capability report scope rejected");
      }

      const verifiedAt = new Date(report.verifiedAt);
      const metadataChanged = node.vehicleSensorCapabilityStatus !== report.status
        || node.vehicleSensorCapabilityVerifiedAt?.getTime() !== verifiedAt.getTime();

      if (report.status === "supported") {
        if (metadataChanged) await this.updateMetadata(tx, node.id, report.status, verifiedAt);
        return { changed: metadataChanged, disabledRuleCount: 0, desiredRevision: null };
      }

      const enabledRules = node.fixtureId
        ? await tx.vehicleEventRule.findMany({
          where: {
            gatewayId: report.gatewayId,
            status: "enabled",
            sources: { some: { fixtureId: node.fixtureId } }
          },
          select: { id: true },
          orderBy: { id: "asc" }
        })
        : [];
      const ruleIds = enabledRules.map(({ id }) => id).sort(compareAutomationIds);
      const disabledRuleCount = ruleIds.length === 0
        ? 0
        : (await tx.vehicleEventRule.updateMany({
          where: { id: { in: ruleIds }, status: "enabled" },
          data: { status: "disabled" }
        })).count;
      const configuration = disabledRuleCount > 0
        ? await this.automationSnapshot.incrementDesiredRevision(tx, report.gatewayId)
        : null;

      if (metadataChanged) await this.updateMetadata(tx, node.id, report.status, verifiedAt);
      return {
        changed: metadataChanged || disabledRuleCount > 0,
        disabledRuleCount,
        desiredRevision: configuration?.desiredRevision ?? null
      };
    }, { timeout: 10_000 });
  }

  private async lockOwnedNode(
    tx: Prisma.TransactionClient,
    report: VehicleSensorCapabilityReportV1
  ) {
    const [node] = await tx.$queryRaw<LockedCapabilityNode[]>(Prisma.sql`
      SELECT
        node."id",
        node."vehicleSensorCapabilityStatus",
        node."vehicleSensorCapabilityVerifiedAt",
        fixture."id" AS "fixtureId"
      FROM "MeshNode" AS node
      INNER JOIN "Gateway" AS gateway ON gateway."id" = node."gatewayId"
      LEFT JOIN "Fixture" AS fixture ON fixture."meshNodeId" = node."id"
      WHERE node."id" = ${report.meshNodeId}
        AND node."gatewayId" = ${report.gatewayId}
        AND gateway."siteId" = ${report.siteId}
      FOR UPDATE OF node, gateway
    `);
    return node;
  }

  private updateMetadata(
    tx: Prisma.TransactionClient,
    meshNodeId: string,
    status: "supported" | "unsupported",
    verifiedAt: Date
  ) {
    return tx.meshNode.update({
      where: { id: meshNodeId },
      data: {
        vehicleSensorCapabilityStatus: status,
        vehicleSensorCapabilityVerifiedAt: verifiedAt
      }
    });
  }
}
