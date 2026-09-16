import { describe, expect, it } from "vitest";
import { parseReportHistorySearchParams, serializeReportHistorySearchParams } from "./report-history-filters";

describe("report history URL filters", () => {
  it("trims search text, coerces the page size and omits absent filters", () => {
    expect(parseReportHistorySearchParams(new URLSearchParams(
      "query=%20%EC%84%9C%EC%9A%B8%20&status=completed&limit=50"
    ))).toEqual({ query: "서울", status: "completed", limit: 50 });
  });

  it("round-trips every filter without converting site-local calendar dates to instants", () => {
    const state = {
      limit: 100 as const,
      cursor: "next+/=cursor",
      query: "서울 & B2/입구",
      status: "processing" as const,
      format: "pdf" as const,
      scope: "floor" as const,
      requestedFrom: "2026-09-01",
      requestedTo: "2026-09-15"
    };

    const serialized = serializeReportHistorySearchParams(state);
    expect(serialized.get("requestedFrom")).toBe("2026-09-01");
    expect(serialized.get("requestedTo")).toBe("2026-09-15");
    expect(serialized.toString()).toContain("query=%EC%84%9C%EC%9A%B8+%26+B2%2F%EC%9E%85%EA%B5%AC");
    expect(parseReportHistorySearchParams(serialized)).toEqual(state);
  });

  it("provides Web's default page size when the URL has no report filters", () => {
    expect(parseReportHistorySearchParams(new URLSearchParams())).toEqual({ limit: 20 });
  });
});
