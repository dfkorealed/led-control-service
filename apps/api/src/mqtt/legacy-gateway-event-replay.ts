import type { Prisma, ProcessedGatewayEvent } from "@prisma/client";

/** Caller must validate topic/DB ownership and hold the owning Fixture/Gateway row lock. */
export async function reconcileLegacyGatewayEventReplay(
  tx: Prisma.TransactionClient,
  existing: ProcessedGatewayEvent,
  payloadHash: string,
  matchesIdentity: (event: ProcessedGatewayEvent) => boolean
): Promise<ProcessedGatewayEvent | null> {
  if (!matchesIdentity(existing)) return null;
  if (existing.payloadHash !== null) return existing.payloadHash === payloadHash ? existing : null;

  // Old writers did not retain payload hashes. The first authenticated exact-identity
  // replay establishes one; null itself cannot prove the original payload was equal.
  // Change only the hash: never reapply state/energy or rewrite the historical result/time.
  const bound = await tx.processedGatewayEvent.updateMany({
    where: { eventId: existing.eventId, payloadHash: null },
    data: { payloadHash }
  });
  if (bound.count === 1) return { ...existing, payloadHash };

  // A competing writer may have bound another payload. Re-read the winner instead of
  // accepting a lost compare-and-set or overwriting its hash, even while holding the owner lock.
  const winner = await tx.processedGatewayEvent.findUnique({ where: { eventId: existing.eventId } });
  return winner && matchesIdentity(winner) && winner.payloadHash === payloadHash ? winner : null;
}
