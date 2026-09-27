import { BadRequestException } from "@nestjs/common";
import { encodeAutomationListCursor, parseAutomationListQuery } from "./automation-list.dto";

const siteId = "11111111-1111-4111-8111-111111111111";
const otherSiteId = "22222222-2222-4222-8222-222222222222";
const principalId = "33333333-3333-4333-8333-333333333333";
const otherPrincipalId = "44444444-4444-4444-8444-444444444444";
const anchor = { siteId, createdAt: new Date("2026-09-25T00:00:00.000Z"),
  id: "55555555-5555-4555-8555-555555555555" };

describe("automation list v2 query and cursor", () => {
  it("normalizes a literal search and binds the filtered cursor to principal, site, resource, and filters", () => {
    const first = parseAutomationListQuery({ query: "  한글%_  ", status: "enabled", syncStatus: "PENDING" },
      siteId, "schedule", principalId, "schedule");
    expect(first).toMatchObject({ query: "한글%_", status: "enabled", syncStatus: "PENDING", hasFilters: true });
    const cursor = encodeAutomationListCursor({ ...anchor, principalId, resource: "schedule",
      filterSignature: first.filterSignature });
    expect(parseAutomationListQuery({ query: "한글%_", status: "enabled", syncStatus: "PENDING", cursor },
      siteId, "schedule", principalId, "schedule").cursor).toEqual(anchor);
    for (const [scopeSite, scopePrincipal, resource, query] of [
      [otherSiteId, principalId, "schedule", "한글%_"],
      [siteId, otherPrincipalId, "schedule", "한글%_"],
      [siteId, principalId, "vehicle_event_rule", "한글%_"],
      [siteId, principalId, "schedule", "다른 이름"]
    ] as const) {
      expect(() => parseAutomationListQuery({ query, status: "enabled", syncStatus: "PENDING", cursor },
        scopeSite, "schedule", scopePrincipal, resource)).toThrow(BadRequestException);
    }
  });

  it("keeps no-filter v1 cursors while rejecting v1 for a filtered page", () => {
    const cursor = encodeAutomationListCursor(anchor);
    expect(parseAutomationListQuery({ cursor }, siteId, "schedule", principalId, "schedule").cursor).toEqual(anchor);
    expect(() => parseAutomationListQuery({ cursor, query: "lamp" }, siteId, "schedule", principalId, "schedule"))
      .toThrow(BadRequestException);
  });

  it.each([{ query: "x".repeat(101) }, { status: "archived" }, { syncStatus: "UNKNOWN" }, { query: 1 }])(
    "rejects an invalid filter %j", raw => {
      expect(() => parseAutomationListQuery(raw, siteId, "schedule", principalId, "schedule"))
        .toThrow(BadRequestException);
    }
  );
});
