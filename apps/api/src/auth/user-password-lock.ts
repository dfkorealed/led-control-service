import { Prisma } from "@prisma/client";

const ADMIN_ASSIGNMENT_WRITE_LOCK_KEY = 80520260827090000n;

export async function lockUserForPasswordMutation(
  tx: Pick<Prisma.TransactionClient, "$executeRaw" | "$queryRaw">,
  userId: string
) {
  // User UPDATE triggers take this gate before their target row. Password writers
  // must use the same order so a concurrent assignment/status write cannot deadlock.
  await tx.$executeRaw(Prisma.sql`SELECT pg_advisory_xact_lock(${ADMIN_ASSIGNMENT_WRITE_LOCK_KEY})`);
  const locked = await tx.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT "id" FROM "User" WHERE "id" = ${userId} FOR UPDATE
  `);
  return locked.length > 0;
}
