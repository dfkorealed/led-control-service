import { ConflictException } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

export type BioSourceTargetOperation = "manual" | "schedule" | "event" | "identify" | "group";

/** Resolve membership first and hold the automation mutation lock in this transaction.
 * An enabled but degraded source still needs to retain its local sensor mode.
 */
export async function assertNoActiveBioSourceTarget(
  tx: Prisma.TransactionClient, siteId: string, expandedFixtureIds: readonly string[], operation: BioSourceTargetOperation
): Promise<void> {
  if (expandedFixtureIds.length === 0) return;
  const source = await tx.vehicleEventSource.findFirst({
    where: { siteId, fixtureId: { in: [...new Set(expandedFixtureIds)] },
      rule: { status: "enabled", sensorProtocol: "bio_usb_pulse" } },
    select: { fixtureId: true }
  });
  if (source) throw new ConflictException({ code: "bio_source_target_forbidden", operation });
}
