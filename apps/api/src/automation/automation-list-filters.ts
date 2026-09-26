import { Prisma } from "@prisma/client";

type SyncStatus = "PENDING" | "APPLIED" | "REJECTED";

/** Prisma contains uses SQL LIKE; escape wildcard syntax to keep user text literal. */
export function literalAutomationName(query: string): Prisma.StringFilter {
  return { contains: query.replace(/[\\%_]/g, "\\$&"), mode: "insensitive" };
}

export function automationSyncWhere(syncStatus: SyncStatus) {
  const configured = { gateway: { automationConfiguration: { is: { syncStatus } } } };
  return syncStatus === "PENDING"
    ? { OR: [configured, { gateway: { automationConfiguration: { is: null } } }] }
    : configured;
}
