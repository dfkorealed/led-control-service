import { Prisma } from "@prisma/client";
import { lockRegistrationDeviceUuids } from "../registration/registration-domain-locks";

export const fixtureRegistrationRemovalBlockingStatuses = ["pending", "gateway_confirmed", "reconcile_required"] as const;

export function supportsFixtureRegistrationRemoval(version: unknown): boolean {
  return version === 1;
}

export function isFixtureRegistrationRemovalBlocking(status: string | null | undefined): boolean {
  // A future/unknown state is not evidence that Gateway mutation was excluded.
  return status != null && status !== "completed" && status !== "rejected";
}

export const activeFixtureRegistrationWhere = Prisma.validator<Prisma.FixtureWhereInput>()({
  retiredAt: null,
  OR: [{ meshNodeId: null }, { meshNode: { retiredAt: null } }],
  registrationRemovals: { none: { status: { in: [...fixtureRegistrationRemovalBlockingStatuses] } } }
});

export type FixtureRegistrationRemovalLockScope = {
  siteId: string; floorId: string; gatewayId: string; fixtureId: string; meshNodeId: string; deviceUuid: string;
};
export type FixtureRegistrationRemovalCleanupSnapshot = {
  catalog: { assignmentVersion: number; revision: number; payloadHash: string } | null;
  groups: Array<{ id: string; configurationVersion: number; desiredHash: string }>;
};

/** Acquire before any caller-owned row locks. Reauthorize/reload the exact
 * binding after this helper: acquiring locks alone never grants admission.
 * The membership serializer precedes Site -> Floor -> Gateway -> UUID -> Node
 * -> Fixture, matching catalog/registration's shared outer lock order. Claim
 * an outbox lease in a separate short transaction, never before these rows.
 */
export async function lockFixtureRegistrationRemovalDomain(
  tx: Prisma.TransactionClient, scope: FixtureRegistrationRemovalLockScope
): Promise<void> {
  await tx.$executeRaw`SELECT "lock_automation_membership_mutation"()`;
  await tx.$queryRaw`SELECT id FROM "Site" WHERE id=${scope.siteId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Floor" WHERE id=${scope.floorId} AND "siteId"=${scope.siteId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Gateway" WHERE id=${scope.gatewayId} AND "siteId"=${scope.siteId} FOR UPDATE`;
  await lockRegistrationDeviceUuids(tx, [scope.deviceUuid]);
  await tx.$queryRaw`SELECT id FROM "MeshNode" WHERE id=${scope.meshNodeId} AND "gatewayId"=${scope.gatewayId} FOR UPDATE`;
  await tx.$queryRaw`SELECT id FROM "Fixture" WHERE id=${scope.fixtureId} AND "siteId"=${scope.siteId} FOR UPDATE`;
}

/** DB-only producers use the same function in triggers. Call before inserting
 * new work, not while ingesting preserved historical ACKs/results. */
export async function assertFixtureRegistrationsActive(
  tx: Prisma.TransactionClient, fixtureIds: readonly string[]
): Promise<void> {
  await tx.$executeRaw`SELECT "lock_automation_membership_mutation"()`;
  for (const fixtureId of [...new Set(fixtureIds)].sort()) {
    await tx.$executeRaw`SELECT assert_fixture_registration_active(${fixtureId})`;
  }
}
