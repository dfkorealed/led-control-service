import { Prisma, type GatewayCertificate, type GatewayInventory } from "@prisma/client";

// All sign-and-persist transactions must use this bound. The independently
// committed orphan ledger waits 180s, so a live <=140s transaction can cancel it.
export const CERTIFICATE_TRANSACTION_TIMEOUT_MS = 140_000;

export async function lockGatewayInventory(tx: Prisma.TransactionClient, inventoryId: string) {
  await tx.$executeRaw(Prisma.sql`SELECT set_config('lock_timeout', '10000ms', true)`);
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${inventoryId}::text, 0))`);
  const rows = await tx.$queryRaw<GatewayInventory[]>(Prisma.sql`
    SELECT * FROM "GatewayInventory" WHERE "id" = ${inventoryId} FOR UPDATE
  `);
  return rows[0] ?? null;
}

// The caller acquires the inventory lock first. Multiple inventories must be
// visited by ascending ID, then certificates by ascending ID, then Gateway rows.
export function lockGatewayCertificates(tx: Prisma.TransactionClient, inventoryId: string) {
  return tx.$queryRaw<GatewayCertificate[]>(Prisma.sql`
    SELECT * FROM "GatewayCertificate" WHERE "inventoryId" = ${inventoryId} ORDER BY "id" FOR UPDATE
  `);
}
