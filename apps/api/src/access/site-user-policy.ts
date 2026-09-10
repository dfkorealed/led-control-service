import { ConflictException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../prisma/prisma.service";

export const SITE_USER_LIMIT = 100 as const;
const TRANSACTION_ATTEMPTS = 3;

/** Caller locks and authorizes Site before invoking assertSiteUserCapacity.
 * The advisory gate must precede that Site lock to match assignment triggers.
 * Both admin creation and invitation signup use Serializable isolation here.
 */
export async function runSiteUserTransaction<T>(
  prisma: PrismaService,
  operation: (tx: Prisma.TransactionClient) => Promise<T>,
  isolationLevel: Prisma.TransactionIsolationLevel = Prisma.TransactionIsolationLevel.Serializable
): Promise<T> {
  for (let attempt = 0; attempt < TRANSACTION_ATTEMPTS; attempt++) {
    try {
      return await prisma.$transaction(async (tx) => {
        await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${80520260827090000n})`);
        return operation(tx);
      }, { isolationLevel, maxWait: 5000, timeout: 10000 });
    } catch (error) {
      if (!isTransactionConflict(error)) throw error;
      // Waiting on a lock does not refresh a Serializable snapshot. Retry the
      // complete transaction so the last slot is recounted from current data.
      if (attempt + 1 === TRANSACTION_ATTEMPTS) {
        throw new ConflictException({ code: "SITE_USER_CHANGED", message: "site user changed; reload and retry" });
      }
    }
  }
  throw new Error("unreachable transaction attempt");
}

export async function assertSiteUserCapacity(tx: Prisma.TransactionClient, siteId: string, organizationId: string) {
  const count = await tx.user.count({
    where: { role: "viewer", organizationId, siteMemberships: { some: { siteId } } }
  });
  // No status filter: disabled users still occupy a slot. Admins do not.
  if (count >= SITE_USER_LIMIT) {
    throw new ConflictException({ code: "USER_LIMIT_REACHED", message: "site user limit reached" });
  }
}

function isTransactionConflict(error: unknown) {
  const code = typeof error === "object" && error !== null ? (error as { code?: string }).code : undefined;
  return ["P2034", "40001", "40P01"].includes(code ?? "")
    || (error instanceof Prisma.PrismaClientKnownRequestError && ["40001", "40P01"].includes(String(error.meta?.code)));
}
