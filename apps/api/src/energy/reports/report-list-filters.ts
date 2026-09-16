import type { EnergyReportListQuery } from "@led-control/shared";
import type { Prisma } from "@prisma/client";
import { addCalendarDays, parseCalendarDate, startOfLocalDate } from "../energy-periods";

export function normalizeReportFilters(query: EnergyReportListQuery) {
  return {
    query: query.query?.trim() ?? null, status: query.status ?? null,
    format: query.format ?? null, scope: query.scope ?? null,
    requestedFrom: query.requestedFrom ?? null, requestedTo: query.requestedTo ?? null
  };
}
export type NormalizedReportFilters = ReturnType<typeof normalizeReportFilters>;
export type ReportCursorPosition = { createdAt: Date; id: string };

export function buildReportListWhere(siteId: string, filters: NormalizedReportFilters, timeZone: string,
  now: Date, cursor?: ReportCursorPosition): Prisma.EnergyReportJobWhereInput {
  return { siteId, AND: [
    filters.query ? targetQueryPredicate(filters.query) : {},
    filters.status === "completed" ? { status: "completed", expiresAt: { gt: now }, objectDeletedAt: null }
      : filters.status === "expired" ? { OR: [
        { status: "expired" },
        { status: "completed", expiresAt: { lte: now } }
      ] }
        : filters.status ? { status: filters.status } : {},
    filters.format ? { format: filters.format } : {},
    filters.scope ? { requestSnapshot: { path: ["scope"], equals: filters.scope } } : {},
    filters.requestedFrom && filters.requestedTo ? { createdAt: {
      gte: startOfLocalDate(parseCalendarDate(filters.requestedFrom), timeZone),
      lt: startOfLocalDate(addCalendarDays(parseCalendarDate(filters.requestedTo), 1), timeZone)
    } } : {},
    ...(cursor ? [{ OR: [{ createdAt: { lt: cursor.createdAt } }, { createdAt: cursor.createdAt, id: { lt: cursor.id } }] }] : [])
  ] };
}

function escapeContains(value: string) {
  // Prisma delegates contains/starts_with to LIKE; user text must remain literal.
  return value.replace(/[\\%_]/g, character => `\\${character}`);
}

function targetQueryPredicate(query: string): Prisma.EnergyReportJobWhereInput {
  const legacy = Object.entries({ site: "현장", fixture: "조명", floor: "층", group: "그룹" }).map(([scope, label]) => {
    const prefix = `${label}: `;
    const identityMatches: Prisma.EnergyReportJobWhereInput[] = [
      { requestSnapshot: { path: ["identityId"], string_contains: escapeContains(query), mode: "insensitive" } }
    ];
    // Legacy labels are exactly `${scope label}: ${identityId}`. Besides matches
    // wholly inside either part, a query may span any suffix of the prefix and
    // the start of the UUID; do not invent current names for historical rows.
    for (let offset = 0; offset < prefix.length; offset++) {
      const suffix = prefix.slice(offset);
      if (query.startsWith(suffix) && query.length > suffix.length) identityMatches.push({
        requestSnapshot: { path: ["identityId"], string_starts_with: escapeContains(query.slice(suffix.length)), mode: "insensitive" }
      });
    }
    return { targetLabelSnapshot: null, AND: [
      { requestSnapshot: { path: ["scope"], equals: scope } },
      ...(prefix.includes(query) ? [] : [{ OR: identityMatches }])
    ] } satisfies Prisma.EnergyReportJobWhereInput;
  });
  return { OR: [{ targetLabelSnapshot: { contains: escapeContains(query), mode: "insensitive" } }, ...legacy] };
}
