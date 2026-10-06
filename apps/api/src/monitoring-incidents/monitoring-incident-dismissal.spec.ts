import { parseIncidentQuery, encodeIncidentCursor, parseDismissAllIncidents, parseDismissIncidentBody } from "./monitoring-incidents.dto";

const site = "11111111-1111-4111-8111-111111111111";
describe("personal dismissal query contract", () => {
  it("accepts only a server-owned actor and timestamp", () => {
    expect(parseDismissIncidentBody({})).toEqual({});
    expect(parseDismissAllIncidents(site, { clientRequestId: site })).toEqual({ clientRequestId: site });
    for (const input of [{ userId: site }, { actorId: site }, { siteId: site }, { dismissedAt: "2026-09-01T00:00:00Z" },
      { expectedUpdatedAt: "2026-09-01T00:00:00Z" }, null, []]) {
      expect(() => parseDismissIncidentBody(input)).toThrow(expect.objectContaining({ status: 400 }));
      expect(() => parseDismissAllIncidents(site, input === null || Array.isArray(input) ? input : { clientRequestId: site, ...input })).toThrow();
    }
    for (const input of [{}, { clientRequestId: "bad" }, { clientRequestId: site, snapshotAt: "2026-09-01T00:00:00Z" }])
      expect(() => parseDismissAllIncidents(site, input)).toThrow();
    expect(() => parseDismissAllIncidents("bad", { clientRequestId: site })).toThrow();
    for (const view of ["invalid", ["all"], null]) expect(() => parseIncidentQuery({ view }, site)).toThrow();
  });
  it("defaults to all and accepts personal view", () => {
    expect(parseIncidentQuery({}, site)).toMatchObject({ view: "all" });
    expect(parseIncidentQuery({ view: "personal" }, site)).toMatchObject({ view: "personal" });
  });
  it("binds v2 cursors to actor/view and accepts legacy cursors only in all", () => {
    const row = { siteId: site, status: "all" as const, active: true, openedAt: new Date("2026-09-01T00:00:00Z"), id: site };
    const encode = encodeIncidentCursor as (input: typeof row & { userId?: string; view?: string }) => string;
    const parse = parseIncidentQuery as (input: unknown, siteId: string, userId?: string) => any;
    const cursor = encode({ ...row, userId: site, view: "personal" });
    expect(JSON.parse(Buffer.from(cursor, "base64url").toString()).v).toBe(2);
    expect(parse({ view: "personal", cursor }, site, site).cursor.id).toBe(site);
    for (const [input, actor] of [[{ cursor }, site], [{ view: "personal", cursor }, "22222222-2222-4222-8222-222222222222"],
      [{ view: "personal", cursor, status: "open" }, site], [{ view: "personal", cursor, type: "fixture_fault" }, site]] as const)
      expect(() => parse(input, site, actor)).toThrow();
    const legacy = encode(row);
    expect(parse({ cursor: legacy }, site, site).cursor.id).toBe(site);
    expect(() => parse({ view: "personal", cursor: legacy }, site, site)).toThrow();
  });
});
