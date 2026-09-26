import { Injectable } from "@nestjs/common";
import type { Prisma } from "@prisma/client";

@Injectable()
export class CommandPublishEpochService {
  /** Caller must keep its shared publish permit through the actual Set handoff. */
  async currentForSet(tx: Prisma.TransactionClient): Promise<number> {
    const rows = await tx.$queryRaw<Array<{ generation: number }>>`
      SELECT "generation" FROM "CommandPublishEpoch" WHERE "status" = 'active' FOR SHARE`;
    if (rows.length !== 1) throw new Error("command publish active generation unavailable");
    return rows[0].generation;
  }

  /**
   * A terminal ACK does not prove a QoS1 packet has left every broker queue.
   * Include all recorded attempts, even acknowledged/failed ones. Legacy Set
   * attempts anywhere block the barrier: mutable payload expiry is not evidence.
   * The protected worker must hold its exclusive permit throughout this query
   * and barrier validation; this method alone never authorizes purge.
   */
  async maxUnsettledExpiry(tx: Prisma.TransactionClient, generation: number): Promise<Date | null> {
    if (!Number.isInteger(generation) || generation <= 0 || generation > 2147483647) {
      throw new Error("invalid command publish generation");
    }
    const epochs = await tx.$queryRaw<Array<{ generation: number }>>`
      SELECT "generation" FROM "CommandPublishEpoch" WHERE "generation" = ${generation} FOR SHARE`;
    if (epochs.length !== 1) throw new Error("command publish generation unavailable");
    const missing = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT d."id" FROM "CommandDispatch" d
      LEFT JOIN "MqttOutbox" o ON o."dispatchId" = d."id"
      WHERE d."kind" = 'dimming'
        AND (d."publishedAt" IS NOT NULL OR d."acceptedAt" IS NOT NULL
          OR d."completedAt" IS NOT NULL OR d."status" <> 'pending'
          OR o."deliveryAttemptedAt" IS NOT NULL OR o."publishedAt" IS NOT NULL OR o."attempts" > 0)
        AND NOT EXISTS (SELECT 1 FROM "CommandPublishAttempt" a WHERE a."dispatchId" = d."id")
      LIMIT 1`;
    if (missing.length) throw new Error("command publish envelope missing or legacy expiry unknown");
    const rows = await tx.$queryRaw<Array<{ expiresAt: Date | null }>>`
      SELECT MAX("expiresAt") AS "expiresAt" FROM "CommandPublishAttempt" WHERE "generation" = ${generation}`;
    return rows[0].expiresAt;
  }
}
