import { Prisma } from "@prisma/client";

// Prisma raw Date parameters are timestamptz, while persisted DateTime columns
// are UTC timestamp without time zone. Normalize the parameter, not the indexed
// column, so comparisons and GREATEST never depend on the connection TimeZone.
export const utcTimestampSql = (value: Date): Prisma.Sql =>
  Prisma.sql`(${value}::timestamptz AT TIME ZONE 'UTC')`;
