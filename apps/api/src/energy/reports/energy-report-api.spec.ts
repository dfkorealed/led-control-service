import { INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { PrismaClient } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { EnergyModule } from "../energy.module";
import { EnergyRetentionService } from "../energy-retention.service";
import { PrismaService } from "../../prisma/prisma.service";
import { OBJECT_STORAGE_CLIENT, OBJECT_STORAGE_OPTIONS } from "../../storage/object-storage.service";
import { energyReportJobSchema, energyReportListResponseSchema } from "@led-control/shared";
import { EnergyReportTargetsService } from "./energy-report-targets.service";
import { EnergyReportSnapshotService } from "./energy-report-snapshot.service";
import { ExcelEnergyReportRenderer } from "./excel-energy-report.renderer";
import { PdfEnergyReportRenderer } from "./pdf-energy-report.renderer";
import { disposablePostgres } from "../../../test/support/disposable-postgres";
import { RedisProvider } from "../../redis/redis.provider";

const databaseUrl = process.env.ENERGY_REPORT_TEST_DATABASE_URL;
const selfOwned = process.env.ENERGY_REPORT_API_TEST === "1";
(selfOwned || databaseUrl ? describe : describe.skip)("report HTTP API with real module/auth/access and PostgreSQL", () => {
  let cluster: Awaited<ReturnType<typeof disposablePostgres>> | undefined;
  const organizationId = randomUUID(); const actorId = randomUUID(); const siteId = randomUUID(); const otherSiteId = randomUUID();
  const floorId = randomUUID(); const operationalFixtureId = randomUUID(); const analyticsFixtureId = randomUUID();
  const operationalGroupId = randomUUID(); const analyticsGroupId = randomUUID();
  const foreignFixtureId = randomUUID(); const foreignGroupId = randomUUID();
  const request = { from: "2026-09-01", to: "2026-09-02", scope: "site", identityId: siteId, format: "xlsx" };
  let prisma: PrismaClient; let app: INestApplication; let baseUrl: string; let cookie: string;
  beforeAll(async () => {
    let testUrl = databaseUrl;
    if (selfOwned) {
      cluster = await disposablePostgres();
      testUrl = cluster.database();
      expect(cluster.deploy(testUrl).status).toBe(0);
    }
    prisma = new PrismaClient({ datasourceUrl: testUrl });
    await prisma.organization.create({ data: { id: organizationId, name: "HTTP report test", type: "customer" } });
    await prisma.user.create({ data: { id: actorId, organizationId, loginId: `report-${actorId}`, name: "보고서 사용자", passwordHash: "unused", role: "admin" } });
    await prisma.site.create({ data: { id: siteId, organizationId, adminUserId: actorId, name: "CSV 현장", timeZone: "UTC" } });
    await prisma.site.create({ data: { id: otherSiteId, organizationId, name: "접근 불가", timeZone: "UTC" } });
    await prisma.energyFixtureIdentity.create({ data: { id: foreignFixtureId, siteId: otherSiteId, trackingStartedAt: new Date("2026-01-01") } });
    await prisma.energyGroupIdentity.create({ data: { id: foreignGroupId, siteId: otherSiteId, trackingStartedAt: new Date("2026-01-01") } });
    await prisma.floor.create({ data: { id: floorId, siteId, name: "역사 층", level: 1 } });
    await prisma.fixture.create({ data: { id: operationalFixtureId, floorId, name: "조명 💡", ratedWatt: 40, x: 0, y: 0 } });
    await prisma.fixtureGroup.create({ data: { id: operationalGroupId, siteId, name: "역사 그룹", lifecycleStatus: "retired" } });
    await prisma.energyFixtureIdentity.create({ data: { id: analyticsFixtureId, siteId, fixtureId: operationalFixtureId,
      trackingStartedAt: new Date("2026-01-01T00:00:00Z"), dimensionVersions: { create: {
        name: "조명 💡", floorId, floorName: "역사 층", ratedWatt: 40, effectiveFrom: new Date("2026-01-01T00:00:00Z")
      } } } });
    await prisma.energyGroupIdentity.create({ data: { id: analyticsGroupId, siteId, groupId: operationalGroupId,
      trackingStartedAt: new Date("2026-01-01T00:00:00Z"), dimensionVersions: { create: { name: "역사 그룹", effectiveFrom: new Date("2026-01-01T00:00:00Z") } } } });
    const module = await Test.createTestingModule({ imports: [EnergyModule] })
      .overrideProvider(PrismaService).useValue(prisma)
      .overrideProvider(EnergyRetentionService).useValue({})
      // Session lookup uses PostgreSQL; login challenge/rate-limit Redis is not
      // exercised by these report routes and must not connect to an ambient DB.
      .overrideProvider(RedisProvider).useValue({ getClient: () => { throw new Error("report HTTP tests must not access Redis"); } })
      .overrideProvider(OBJECT_STORAGE_OPTIONS).useValue({ bucket: "public-floors", reportBucket: "private-reports", publicBaseUrl: "https://public.example/public-floors" })
      .overrideProvider(OBJECT_STORAGE_CLIENT).useValue({ send: () => { throw new Error("HTTP tests must not upload"); } }).compile();
    app = module.createNestApplication();
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
    const token = randomUUID();
    const { createHash } = await import("node:crypto");
    await prisma.session.create({ data: { userId: actorId, tokenHash: createHash("sha256").update(token).digest("hex"), expiresAt: new Date(Date.now() + 60_000) } });
    cookie = `led_session=${token}`;
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await prisma.site.deleteMany({ where: { id: { in: [siteId, otherSiteId] } } });
    await prisma.energyReportObjectCleanup.deleteMany({ where: { siteId: { in: [siteId, otherSiteId] } } });
    await prisma.session.deleteMany({ where: { userId: actorId } });
    await prisma.user.delete({ where: { id: actorId } });
    await prisma.organization.delete({ where: { id: organizationId } });
    await prisma.$disconnect();
    cluster?.stop();
  });
  const call = (path: string, options: RequestInit = {}) => fetch(`${baseUrl}/energy/sites/${siteId}/${path}`, {
    ...options, headers: { cookie, "content-type": "application/json", ...options.headers }
  });
  it("searches all retained rows and paginates equal timestamps without gaps or duplicates", async () => {
    const createdAt = new Date("2025-01-01T00:00:00Z");
    const ids = Array.from({ length: 63 }, () => randomUUID()).sort().reverse();
    await prisma.energyReportJob.createMany({ data: ids.map(id => ({ id, siteId, requestedByActorId: actorId,
      requestedByLoginIdSnapshot: "history", requestHash: id.replaceAll("-", "").repeat(2), format: "pdf",
      requestSnapshot: { ...request, format: "pdf" }, targetLabelSnapshot: "보존 이력 Archive", createdAt })) });
    try {
      const found: string[] = [];
      let cursor: string | null = null;
      do {
        const params = new URLSearchParams({ query: "Archive", format: "pdf", scope: "site", limit: "10", ...(cursor ? { cursor } : {}) });
        const response = await call(`reports?${params}`);
        expect(response.status).toBe(200);
        const page = energyReportListResponseSchema.parse(await response.json());
        expect(page.totalCount).toBe(63);
        expect(page.reports.length).toBeLessThanOrEqual(10);
        found.push(...page.reports.map(row => row.reportId));
        if (page.nextCursor) {
          const changed = await call(`reports?${new URLSearchParams({ query: "other", cursor: page.nextCursor })}`);
          expect(changed.status).toBe(400);
          expect(await changed.json()).toMatchObject({ message: "invalid energy report list query" });
        }
        cursor = page.nextCursor;
      } while (cursor);
      expect(found).toEqual(ids);
      const defaults = energyReportListResponseSchema.parse(await (await call("reports")).json());
      expect(defaults.reports).toHaveLength(20);
      const last = await call(`reports?${new URLSearchParams({ query: "Archive", limit: "100" })}`);
      expect(energyReportListResponseSchema.parse(await last.json())).toMatchObject({ totalCount: 63, nextCursor: null });
    } finally { await prisma.energyReportJob.deleteMany({ where: { id: { in: ids } } }); }
  });
  it("matches legacy fallback prefixes, UUID substrings and literal wildcard characters", async () => {
    const legacyId = randomUUID(); const literalId = randomUUID();
    await prisma.energyReportJob.createMany({ data: [
      { id: legacyId, targetLabelSnapshot: null, requestSnapshot: { ...request, scope: "fixture", identityId: analyticsFixtureId } },
      { id: literalId, targetLabelSnapshot: "50%_\\Lamp", requestSnapshot: request }
    ].map(row => ({ ...row, siteId, requestedByActorId: actorId, requestedByLoginIdSnapshot: "history",
      requestHash: row.id.replaceAll("-", "").repeat(2), format: "xlsx" })) });
    try {
      for (const query of ["조명", `조명: ${analyticsFixtureId}`, analyticsFixtureId.slice(8), `명: ${analyticsFixtureId.slice(0, 8)}`]) {
        const page = energyReportListResponseSchema.parse(await (await call(`reports?${new URLSearchParams({ query })}`)).json());
        expect(page.reports.map(row => row.reportId)).toEqual([legacyId]);
        expect(page.reports[0].target.label).toBe(`조명: ${analyticsFixtureId}`);
      }
      const page = energyReportListResponseSchema.parse(await (await call(`reports?${new URLSearchParams({ query: "%_\\" })}`)).json());
      expect(page.reports.map(row => row.reportId)).toEqual([literalId]);
    } finally { await prisma.energyReportJob.deleteMany({ where: { id: { in: [legacyId, literalId] } } }); }
  });
  it.each(["limit=30", "limit=10&limit=20", "unexpected=private-token", "cursor=private-token", "requestedFrom=2026-09-01"])(
    "returns a sanitized 400 for invalid list query %s", async query => {
      const response = await call(`reports?${query}`);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ statusCode: 400, error: "Bad Request", message: "invalid energy report list query" });
    });
  it.each([
    ["Asia/Seoul", "2026-09-16", "2026-09-15T15:00:00.000Z", "2026-09-16T15:00:00.000Z"],
    ["America/New_York", "2026-03-08", "2026-03-08T05:00:00.000Z", "2026-03-09T04:00:00.000Z"]
  ])("filters request timestamps using %s local date %s", async (timeZone, day, start, end) => {
    await prisma.site.update({ where: { id: siteId }, data: { timeZone } });
    const ids = Array.from({ length: 4 }, () => randomUUID());
    const timestamps = [Date.parse(start) - 1, Date.parse(start), Date.parse(end) - 1, Date.parse(end)];
    await prisma.energyReportJob.createMany({ data: ids.map((id, index) => ({ id, siteId, requestedByActorId: actorId,
      requestedByLoginIdSnapshot: "boundary", requestHash: id.replaceAll("-", "").repeat(2), format: "xlsx",
      requestSnapshot: request, targetLabelSnapshot: "date boundary", createdAt: new Date(timestamps[index]) })) });
    try {
      const response = await call(`reports?${new URLSearchParams({ query: "date boundary", requestedFrom: day, requestedTo: day })}`);
      expect(response.status).toBe(200);
      const page = energyReportListResponseSchema.parse(await response.json());
      expect(page.totalCount).toBe(2);
      expect(page.reports.map(row => row.reportId)).toEqual([ids[2], ids[1]]);
    } finally {
      await prisma.energyReportJob.deleteMany({ where: { id: { in: ids } } });
      await prisma.site.update({ where: { id: siteId }, data: { timeZone: "UTC" } });
    }
  });
  it("selects tenant analytics targets from the real API instead of operational IDs", async () => {
    const response = await call("report-targets");
    expect(response.status).toBe(200);
    const payload = await response.json() as { targets: Array<{ scope: string; identityId: string; label: string }> };
    expect(payload.targets).toEqual(expect.arrayContaining([
      { scope: "fixture", identityId: analyticsFixtureId, label: "조명 💡" },
      { scope: "group", identityId: analyticsGroupId, label: "역사 그룹" }
    ]));
    expect(payload.targets.some(target => target.identityId === foreignFixtureId || target.identityId === foreignGroupId)).toBe(false);
    for (const target of payload.targets) {
      const selected = { ...request, scope: target.scope, identityId: target.identityId };
      expect((await call("reports", { method: "POST", body: JSON.stringify(selected) })).status).toBe(202);
      const params = new URLSearchParams({ from: request.from, to: request.to, scope: target.scope, identityId: target.identityId });
      expect((await call(`exports/csv?${params}`)).status).toBe(200);
    }
    for (const [scope, identityId] of [["fixture", operationalFixtureId], ["group", operationalGroupId], ["fixture", foreignFixtureId], ["group", foreignGroupId], ["site", otherSiteId]]) {
      expect((await call("reports", { method: "POST", body: JSON.stringify({ ...request, scope, identityId }) })).status).toBe(404);
    }
    expect((await fetch(`${baseUrl}/energy/sites/${otherSiteId}/report-targets`, { headers: { cookie } })).status).toBe(404);
    await prisma.fixture.delete({ where: { id: operationalFixtureId } });
    await prisma.fixtureGroup.delete({ where: { id: operationalGroupId } });
    expect((await (await call("report-targets")).json()).targets).toEqual(payload.targets);
    for (const [scope, identityId] of [["fixture", analyticsFixtureId], ["group", analyticsGroupId]]) {
      expect((await call("reports", { method: "POST", body: JSON.stringify({ ...request, scope, identityId, format: "pdf" }) })).status).toBe(202);
      const params = new URLSearchParams({ from: request.from, to: request.to, scope, identityId });
      expect((await call(`exports/csv?${params}`)).status).toBe(200);
    }
  });
  it("rejects the current site-local day before queueing while accepting the last completed date", async () => {
    await prisma.site.update({ where: { id: siteId }, data: { timeZone: "Asia/Seoul" } });
    const localToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    expect((await call("reports", { method: "POST", body: JSON.stringify({ ...request, from: localToday, to: localToday }) })).status).toBe(400);
    const targets = await (await call("report-targets")).json();
    expect(targets.timeZone).toBe("Asia/Seoul");
    expect(targets.lastCompletedDate).toBe(new Date(Date.parse(`${localToday}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10));
    expect((await call("reports", { method: "POST", body: JSON.stringify({ ...request, from: targets.lastCompletedDate, to: targets.lastCompletedDate }) })).status).toBe(202);
  });
  it.each(["\u{10FFFF}", "\u00A0", "\uFE0F", "\u200D"])("rejects unsupported report name characters before accepting either format or CSV (%j)", async text => {
    await prisma.site.update({ where: { id: siteId }, data: { name: `현장 ${text}` } });
    try {
      for (const format of ["xlsx", "pdf"]) {
        expect((await call("reports", { method: "POST", body: JSON.stringify({ ...request, format }) })).status).toBe(400);
      }
      const params = new URLSearchParams({ from: request.from, to: request.to, scope: request.scope, identityId: siteId });
      expect((await call(`exports/csv?${params}`)).status).toBe(400);
    } finally {
      await prisma.site.update({ where: { id: siteId }, data: { name: "CSV 현장" } });
    }
  });
  it.each([
    ["한글", 202], ["café e\u0301 a\u0301", 202], ["한글 💡 e\u0301 😀", 202], ["prefix " + "한글".normalize("NFD"), 202], ["한글".normalize("NFD"), 400],
    ["A".repeat(40) + " " + "한글".normalize("NFD").repeat(3), 400]
  ] as const)("validates complete text runs before queueing and CSV (%s)", async (text, status) => {
    await prisma.site.update({ where: { id: siteId }, data: { name: text } });
    const before = await prisma.energyReportJob.count({ where: { siteId } });
    try {
      for (const format of ["xlsx", "pdf"]) {
        expect((await call("reports", { method: "POST", body: JSON.stringify({ ...request, format }) })).status).toBe(status);
      }
      const params = new URLSearchParams({ from: request.from, to: request.to, scope: request.scope, identityId: siteId });
      expect((await call(`exports/csv?${params}`)).status).toBe(status === 202 ? 200 : 400);
      if (status === 400) expect(await prisma.energyReportJob.count({ where: { siteId } })).toBe(before);
    } finally { await prisma.site.update({ where: { id: siteId }, data: { name: "CSV 현장" } }); }
  });
  it("does not let unrelated retired unsupported names poison current targets or a selected fixture report", async () => {
    const oldId = randomUUID();
    await prisma.energyFixtureIdentity.create({ data: { id: oldId, siteId, trackingStartedAt: new Date("2025-01-01"), retiredAt: new Date("2025-12-31"),
      dimensionVersions: { create: { name: "Old\u00a0fixture", floorId, floorName: "역사 층", ratedWatt: 40,
        effectiveFrom: new Date("2025-01-01"), effectiveTo: new Date("2025-12-31") } },
      dailyAggregates: { create: { localDate: new Date("2025-09-01"), estimatedKwh: 2, estimatedCost: 300, knownSeconds: 3600 } }
    } });
    await prisma.fixtureEnergyDailyAggregate.create({ data: { energyFixtureId: analyticsFixtureId, localDate: new Date("2026-09-01"), estimatedKwh: 1, estimatedCost: 150, knownSeconds: 3600 } });
    try {
      const targets = await call("report-targets");
      expect(targets.status).toBe(200);
      const payload = await targets.json();
      expect(payload.targets.some((target: { identityId: string }) => target.identityId === analyticsFixtureId)).toBe(true);
      expect(payload.targets.some((target: { identityId: string }) => target.identityId === oldId)).toBe(false);
      const selected = { ...request, from: "2026-09-01", to: "2026-09-01", scope: "fixture", identityId: analyticsFixtureId };
      for (const format of ["xlsx", "pdf"]) expect((await call("reports", { method: "POST", body: JSON.stringify({ ...selected, format }) })).status).toBe(202);
      const csv = await call(`exports/csv?${new URLSearchParams({ from: selected.from, to: selected.to, scope: selected.scope, identityId: selected.identityId })}`);
      expect(csv.status).toBe(200); expect(await csv.text()).toContain("150.00 원");
      const { documentSnapshot } = await app.get(EnergyReportSnapshotService).capture(randomUUID(), siteId, selected);
      expect(documentSnapshot.sections[0]).toMatchObject({ rows: [{ value: 1 }, { value: 150 }] });
      const xlsx = await new ExcelEnergyReportRenderer().render(documentSnapshot);
      const pdf = await new PdfEnergyReportRenderer().render(documentSnapshot);
      expect(xlsx.manifest).toEqual(pdf.manifest);
      const bad = { ...selected, identityId: oldId, from: "2025-09-01", to: "2025-09-01" };
      const before = await prisma.energyReportJob.count({ where: { siteId } });
      for (const format of ["xlsx", "pdf"]) expect((await call("reports", { method: "POST", body: JSON.stringify({ ...bad, format }) })).status).toBe(400);
      expect((await call(`exports/csv?${new URLSearchParams({ from: bad.from, to: bad.to, scope: bad.scope, identityId: bad.identityId })}`)).status).toBe(400);
      expect(await prisma.energyReportJob.count({ where: { siteId } })).toBe(before);
    } finally {
      await prisma.fixtureEnergyDailyAggregate.deleteMany({ where: { energyFixtureId: analyticsFixtureId } });
      await prisma.energyFixtureIdentity.delete({ where: { id: oldId } });
    }
  });
  it.each([
    ["Asia/Seoul", "2026-09-08T14:59:59Z", "2026-09-07"],
    ["Asia/Seoul", "2026-09-08T15:00:00Z", "2026-09-08"],
    ["America/New_York", "2026-11-02T04:59:59Z", "2026-10-31"],
    ["America/New_York", "2026-11-02T05:00:00Z", "2026-11-01"],
    ["America/New_York", "2026-03-09T03:59:59Z", "2026-03-07"],
    ["America/New_York", "2026-03-09T04:00:00Z", "2026-03-08"]
  ])("returns the last completed date for %s at %s", async (timeZone, instant, expected) => {
    await prisma.site.update({ where: { id: siteId }, data: { timeZone } });
    const result = await app.get(EnergyReportTargetsService).list({ id: actorId, organizationId, organizationType: "customer", role: "admin", status: "active" } as never,
      siteId, new Date(instant));
    expect(result.lastCompletedDate).toBe(expected);
  });
  it("registers POST 202, list/detail/download, strict validation and no-store response headers", async () => {
    // Use a fresh canonical request; earlier Unicode/target cases leave valid queued
    // jobs deliberately, whose original createdAt must not be mistaken for a new row.
    const request = { from: "2026-09-01", to: "2026-09-03", scope: "site", identityId: siteId, format: "xlsx" };
    const created = await call("reports", { method: "POST", body: JSON.stringify(request) });
    expect(created.status).toBe(202);
    expect(created.headers.get("cache-control")).toBe("no-store");
    const report = energyReportJobSchema.parse(await created.json());
    expect(report.status).toBe("queued");
    expect(Math.abs(Date.parse(report.createdAt) - Date.now())).toBeLessThan(1000);
    const list = await call("reports");
    expect(list.status).toBe(200);
    expect(energyReportListResponseSchema.parse(await list.json()).reports.some(row => row.reportId === report.reportId)).toBe(true);
    const detail = await call(`reports/${report.reportId}`);
    expect(energyReportJobSchema.parse(await detail.json())).toEqual(report);
    expect((await call(`reports/${report.reportId}/download`)).status).toBe(404);
    expect((await call("reports", { method: "POST", body: JSON.stringify({ ...request, sections: ["summary"] }) })).status).toBe(400);
    const duplicate = await call("reports", { method: "POST", body: JSON.stringify(request) });
    expect(duplicate.status).toBe(202);
    expect((await duplicate.json()).reportId).toBe(report.reportId);
  });
  it("streams BOM CSV through the stable exports/csv route with safe attachment and no-store", async () => {
    const params = new URLSearchParams({ from: request.from, to: request.to, scope: request.scope, identityId: siteId });
    const result = await call(`exports/csv?${params}`);
    expect(result.status).toBe(200);
    expect(result.headers.get("content-type")).toContain("text/csv; charset=utf-8");
    expect(result.headers.get("cache-control")).toBe("no-store");
    expect(result.headers.get("content-disposition")).toBe('attachment; filename="energy-export.csv"');
    expect(result.headers.get("content-length")).toBeNull();
    const bytes = Buffer.from(await result.arrayBuffer());
    expect(bytes.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(bytes.toString()).toContain("CSV 현장");
  });
  it("requires a session and hides inaccessible sites and report IDs with 404", async () => {
    expect((await fetch(`${baseUrl}/energy/sites/${siteId}/reports`)).status).toBe(401);
    expect((await fetch(`${baseUrl}/energy/sites/${otherSiteId}/reports`, { headers: { cookie } })).status).toBe(404);
    const foreign = await prisma.energyReportJob.create({ data: { siteId: otherSiteId, requestedByActorId: actorId,
      requestedByLoginIdSnapshot: "foreign", requestHash: "b".repeat(64), format: "xlsx", requestSnapshot: { ...request, identityId: otherSiteId } } });
    expect((await call(`reports/${foreign.id}`)).status).toBe(404);
    expect((await call(`reports/${foreign.id}/download`)).status).toBe(404);
  });
});
