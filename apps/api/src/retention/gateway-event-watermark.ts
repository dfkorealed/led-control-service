import { Prisma } from "@prisma/client";

interface GatewayEventIdentity {
  gatewayId: string;
  eventType: string;
  scopeKey: string;
  sequence: bigint;
  eventId: string;
  payloadHash: string;
  occurredAt: Date;
}

/** Caller must validate ownership and retained raw identities inside the same transaction. */
export async function compareAndAdvanceGatewayEvent(
  tx: Prisma.TransactionClient,
  event: GatewayEventIdentity
): Promise<"advanced" | "duplicate" | "stale" | "conflict"> {
  // A gateway/type lock also covers first insert and cross-fixture equal sequence
  // races. Node-local capability revisions remain independent within this lock.
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`gateway-event:${event.gatewayId}:${event.eventType}`}, 0))`);
  const key = { gatewayId: event.gatewayId, eventType: event.eventType, scopeKey: event.scopeKey };
  const collision = await tx.gatewayEventWatermark.findFirst({
    where: { OR: [
      { lastEventId: event.eventId, NOT: key },
      ...(event.eventType === "fixture_state" ? [{
        gatewayId: event.gatewayId, eventType: event.eventType, lastSequence: event.sequence,
        scopeKey: { not: event.scopeKey }
      }] : [])
    ] }
  });
  if (collision) return "conflict";
  const current = await tx.gatewayEventWatermark.findUnique({ where: { gatewayId_eventType_scopeKey: key } });
  if (current) {
    if (event.sequence < current.lastSequence) return "stale";
    if (event.sequence === current.lastSequence) {
      // NULL is an unverifiable legacy payload, never a wildcard. Legacy exact
      // replay is handled only by its retained ledger in the owning consumer.
      return current.lastEventId === event.eventId && current.lastPayloadHash === event.payloadHash &&
        current.lastOccurredAt.getTime() === event.occurredAt.getTime() ? "duplicate" : "conflict";
    }
    if (current.lastEventId === event.eventId) return "conflict";
  }
  const data = { lastSequence: event.sequence, lastEventId: event.eventId,
    lastPayloadHash: event.payloadHash, lastOccurredAt: event.occurredAt };
  await tx.gatewayEventWatermark.upsert({ where: { gatewayId_eventType_scopeKey: key }, create: { ...key, ...data }, update: data });
  return "advanced";
}
