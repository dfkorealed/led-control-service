import { decodeReportCursor, encodeReportCursor } from "./report-list-cursor";
import { normalizeReportFilters } from "./report-list-filters";

const position = { createdAt: new Date("2026-09-16T00:00:00.000Z"), id: "10000000-0000-4000-8000-000000000001" };
const filters = normalizeReportFilters({ limit: 20, query: "서울", status: "completed" });
const encode = (payload: unknown) => Buffer.from(JSON.stringify(payload)).toString("base64url");

describe("report list cursor", () => {
  it("round trips a position bound to normalized filters independent of page size and cursor", () => {
    const cursor = encodeReportCursor(position, filters);
    expect(decodeReportCursor(cursor, normalizeReportFilters({ limit: 100, query: " 서울 ", status: "completed", cursor }))).toEqual(position);
  });
  it.each([
    { query: "부산", status: "completed" }, { query: "서울", status: "expired" },
    { query: "서울", status: "completed", format: "pdf" }, { query: "서울", status: "completed", scope: "floor" },
    { query: "서울", status: "completed", requestedFrom: "2026-09-01", requestedTo: "2026-09-02" }
  ] as const)("rejects a changed filter %j", changed => {
    expect(() => decodeReportCursor(encodeReportCursor(position, filters), normalizeReportFilters({ limit: 20, ...changed }))).toThrow();
  });
  it("rejects malformed, padded, oversized and noncanonical base64url", () => {
    const cursor = encodeReportCursor(position, filters);
    for (const value of ["not-base64", "", "x".repeat(1025), `${cursor}=`, ` ${cursor}`, "+/==", "e31"])
      expect(() => decodeReportCursor(value, filters)).toThrow();
  });
  it("rejects unexpected keys, wrong version, noncanonical dates, UUIDs and fingerprints", () => {
    const valid = JSON.parse(Buffer.from(encodeReportCursor(position, filters), "base64url").toString());
    for (const payload of [null, [], { ...valid, extra: true }, { ...valid, version: 2 },
      { ...valid, createdAt: "2026-09-16" }, { ...valid, createdAt: "2026-02-30T00:00:00.000Z" },
      { ...valid, id: "invalid" }, { ...valid, filterFingerprint: "a".repeat(63) }, { ...valid, filterFingerprint: "F".repeat(64) }])
      expect(() => decodeReportCursor(encode(payload), filters)).toThrow();
  });
});
