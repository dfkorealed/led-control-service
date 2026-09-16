import { buildReportListWhere, normalizeReportFilters } from "./report-list-filters";

const now = new Date("2026-09-16T00:00:00.000Z");
const siteId = "20000000-0000-4000-8000-000000000001";
const where = (query: Parameters<typeof normalizeReportFilters>[0], timeZone = "Asia/Seoul") =>
  buildReportListWhere(siteId, normalizeReportFilters(query), timeZone, now);

describe("report list filters", () => {
  it("normalizes only the search filters with stable absent values", () => {
    expect(normalizeReportFilters({ limit: 20, cursor: "ignored", query: " 서울 " })).toEqual({
      query: "서울", status: null, format: null, scope: null, requestedFrom: null, requestedTo: null
    });
  });
  it("selects available completed artifacts and keeps elapsed and cleanup-tombstoned reports in the expired filter", () => {
    expect(where({ limit: 20, status: "completed" })).toMatchObject({ siteId, AND: expect.arrayContaining([
      { status: "completed", expiresAt: { gt: now }, objectDeletedAt: null }
    ]) });
    expect(where({ limit: 20, status: "expired" })).toMatchObject({ AND: expect.arrayContaining([
      { OR: [
        { status: "expired" },
        { status: "completed", expiresAt: { lte: now } }
      ] }
    ]) });
  });
  it("combines stored state, file format and JSON scope predicates", () => {
    expect(where({ limit: 20, status: "failed", format: "pdf", scope: "fixture" })).toMatchObject({ AND: expect.arrayContaining([
      { status: "failed" }, { format: "pdf" }, { requestSnapshot: { path: ["scope"], equals: "fixture" } }
    ]) });
  });
  it.each([
    ["Asia/Seoul", "2026-09-16", "2026-09-15T15:00:00.000Z", "2026-09-16T15:00:00.000Z"],
    ["America/New_York", "2026-03-08", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"],
    ["America/New_York", "2026-11-01", "2026-11-01T04:00:00.000Z", "2026-11-02T05:00:00.000Z"]
  ])("uses inclusive local start and exclusive next local day in %s on %s", (zone, day, start, end) => {
    expect(where({ limit: 20, requestedFrom: day, requestedTo: day }, zone)).toMatchObject({ AND: expect.arrayContaining([
      { createdAt: { gte: new Date(start), lt: new Date(end) } }
    ]) });
  });
  it("searches stored labels literally, escaping PostgreSQL LIKE metacharacters", () => {
    expect(where({ limit: 20, query: "50%_\\" })).toMatchObject({ AND: expect.arrayContaining([
      expect.objectContaining({ OR: expect.arrayContaining([{ targetLabelSnapshot: { contains: "50\\%\\_\\\\", mode: "insensitive" } }]) })
    ]) });
  });
  it("searches legacy public labels across their scope prefix and identity boundary", () => {
    expect(where({ limit: 20, query: "조명: 1000" })).toMatchObject({ AND: expect.arrayContaining([
      expect.objectContaining({ OR: expect.arrayContaining([expect.objectContaining({ targetLabelSnapshot: null,
        AND: expect.arrayContaining([
          { requestSnapshot: { path: ["scope"], equals: "fixture" } },
          { OR: expect.arrayContaining([{ requestSnapshot: { path: ["identityId"], string_starts_with: "1000", mode: "insensitive" } }]) }
        ])
      })]) })
    ]) });
  });
  it("applies descending keyset tie breaks without offsets", () => {
    expect(buildReportListWhere(siteId, normalizeReportFilters({ limit: 20 }), "UTC", now, { createdAt: now, id: siteId }))
      .toMatchObject({ AND: expect.arrayContaining([{ OR: [{ createdAt: { lt: now } }, { createdAt: now, id: { lt: siteId } }] }]) });
  });
});
