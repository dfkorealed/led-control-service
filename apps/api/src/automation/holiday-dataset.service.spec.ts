import { PrismaClient } from "@prisma/client";
import { disposablePostgres } from "../../test/support/disposable-postgres";
import { AutomationClock } from "./automation-clock";
import { AutomationSnapshotService } from "./automation-snapshot.service";
import { randomUUID } from "node:crypto";

const instant = "2026-10-14T00:00:00.000Z";
const controller = () => new AbortController();
const page = (year: number, month: number, pageNo = 1) => ({ year, month, page: pageNo,
  numOfRows: 2, totalCount: 0, items: [] as Array<{ date: string; name: string; isHoliday: boolean }> });
const sourceRow = (date: number | string = 20260101, name = "신정", holiday: unknown = "Y") => ({
  locdate: date, dateName: name, isHoliday: holiday, seq: 1, dateKind: "01"
});
const envelope = (items: unknown, totalCount = 1, pageNo = 1, numOfRows = 2) => ({
  response: { header: { resultCode: "00", resultMsg: "NORMAL SERVICE." },
    body: { items, totalCount, pageNo, numOfRows } }
});

describe("complete Korean holiday provider and immutable cache", () => {
  jest.setTimeout(60_000);
  let cluster: Awaited<ReturnType<typeof disposablePostgres>>;
  let db: PrismaClient;
  const services: any[] = [];
  let liveCalls = 0;
  let network: jest.SpyInstance;

  beforeAll(async () => {
    cluster = await disposablePostgres();
    const url = cluster.database();
    const deployed = cluster.deploy(url);
    if (deployed.status !== 0) throw new Error(deployed.stderr + deployed.stdout);
    db = new PrismaClient({ datasourceUrl: url });
    // Every network access in this suite is intercepted, including accidental production DI.
    network = jest.spyOn(globalThis, "fetch").mockImplementation(async () => {
      liveCalls++;
      throw new Error("unexpected network call");
    });
  });
  afterEach(async () => {
    for (const service of services.splice(0)) await service.onModuleDestroy();
    jest.useRealTimers();
  });
  afterAll(async () => {
    try { expect(liveCalls).toBe(0); }
    finally { network?.mockRestore(); try { await db?.$disconnect(); } finally { cluster?.stop(); } }
  });

  function harness(provider?: { fetchMonth: (input: any, signal: AbortSignal) => Promise<any> }, hook?: any) {
    const { HolidayDatasetService } = require("./holiday-dataset.service");
    const calls: Array<{ year: number; month: number; page: number }> = [];
    const state = { fail: false, changed: false, promotions: [] as any[] };
    const mockProvider = provider ?? { fetchMonth: async (input: any) => {
      calls.push(input);
      if (state.fail && input.month === 10 && input.page === 2) throw new Error("secret raw provider error");
      const result = page(input.year, input.month, input.page);
      if (input.month === 1) {
        result.totalCount = 3;
        result.items = input.page === 1 ? [
          { date: `${input.year}-01-01`, name: "신정", isHoliday: true },
          { date: `${input.year}-01-01`, name: "동일 날짜 다른 휴일", isHoliday: true }
        ] : [{ date: `${input.year}-01-02`, name: "기념일", isHoliday: false }];
      }
      if (input.month === 10) {
        result.totalCount = 3;
        result.items = input.page === 1 ? [
          { date: `${input.year}-10-03`, name: "개천절", isHoliday: true },
          { date: `${input.year}-10-09`, name: "한글날", isHoliday: true }
        ] : [{ date: `${input.year}-10-10`, name: "대체공휴일", isHoliday: true }];
      }
      if (state.changed && input.month === 12) {
        result.totalCount = 1;
        result.items = [{ date: `${input.year}-12-01`, name: "임시공휴일", isHoliday: true }];
      }
      return result;
    } };
    const clock = { now: () => new Date(Date.now()) };
    const promotion = hook ?? { onPromoted: async (_tx: unknown, dataset: any) => { state.promotions.push(dataset); } };
    const service = new HolidayDatasetService(db, clock, new AutomationSnapshotService(clock as AutomationClock), mockProvider, promotion);
    services.push(service);
    return { service, state, calls, provider: mockProvider };
  }
  const cached = (year: number) => db.holidayYearCoverage.findUnique({ where: { country_year: { country: "KR", year } }, include: { dataset: true } });

  // Break caught: UTC year overlap omits a Jan1-only Seoul schedule; promotion
  // must publish its new dataset and roll all writes back if the same hook fails.
  it("Seoul January 1 dataset promotion advances revision/outbox atomically and rolls back on hook failure", async () => {
    const snapshots = new AutomationSnapshotService({ now: () => new Date(instant) });
    let rollback = false;
    const h = harness(undefined, { onPromoted: async (tx: any, dataset: any) => {
      await snapshots.onPromoted(tx, dataset); if (rollback) throw new Error("local rollback fixture");
    } });
    expect((await h.service.refreshYear(2027)).status).toBe("promoted");
    const organization = await db.organization.create({ data: { name: "Jan1 promotion", type: "customer" } });
    const actor = await db.user.create({ data: { organizationId: organization.id, loginId: randomUUID(), name: "local", passwordHash: "unused", role: "admin" } });
    const site = await db.site.create({ data: { organizationId: organization.id, adminUserId: actor.id, name: "Seoul", timeZone: "Asia/Seoul" } });
    const floor = await db.floor.create({ data: { siteId: site.id, name: "local", level: 1 } });
    const gateway = await db.gateway.create({ data: { siteId: site.id, name: "local", serialNumber: randomUUID(), firmwareVersion: "fixture", assignmentVersion: 1 } });
    const node = await db.meshNode.create({ data: { gatewayId: gateway.id, deviceUuid: "bio:001122334466", meshAddress: "0x0002", firmwareVersion: "fixture", vehicleSensorProtocol: "bio_usb_pulse" } });
    const fixture = await db.fixture.create({ data: { floorId: floor.id, siteId: site.id, gatewayId: gateway.id, meshNodeId: node.id,
      name: "local", ratedWatt: 20, x: 0, y: 0 } });
    const inventory = await db.gatewayInventory.create({ data: { serialNumber: gateway.serialNumber, claimedGatewayId: gateway.id, claimedAt: new Date(instant) } });
    await db.gatewayCertificate.create({ data: { inventoryId: inventory.id, gatewayId: gateway.id, purpose: "mqtt", status: "active",
      certificateSerial: randomUUID(), fingerprint: randomUUID(), issuer: "fixture", notBefore: new Date("2026-01-01Z"), notAfter: new Date("2028-01-01Z") } });
    await db.gatewayAutomationProtocolSupport.create({ data: { siteId: site.id, gatewayId: gateway.id, assignmentVersion: 1, declarationRevision: 1n,
      declarationId: randomUUID(), maxSnapshotVersion: 3, temporaryControlVersion: 1, bioConfigurationReadback: true, durableFixtureLease: true,
      payloadHash: `sha256:${"a".repeat(64)}`, declaredAt: new Date(instant) } });
    await db.lightingSchedule.create({ data: { siteId: site.id, gatewayId: gateway.id, createdById: actor.id, updatedById: actor.id, name: "Jan1 only", status: "enabled",
      activeFrom: new Date("2026-12-31T15:00:00Z"), activeUntil: new Date("2026-12-31T15:00:00Z"), localStartTime: "09:00", localEndTime: "10:00",
      recurrenceKind: "once", weeklyDays: [], dimmingEnabled: true, brightnessPercent: 50, excludeHolidays: true,
      fixtures: { create: { fixtureId: fixture.id } } } });
    await db.$transaction(async tx => { await snapshots.lockMutation(tx); await snapshots.incrementDesiredRevision(tx, gateway.id); });
    const before = await db.gatewayAutomationConfiguration.findUniqueOrThrow({ where: { gatewayId: gateway.id } });
    const outboxBefore = await db.mqttOutbox.count({ where: { gatewayId: gateway.id } });
    h.state.changed = true;
    const promoted = await h.service.refreshYear(2027);
    expect(promoted.status).toBe("promoted");
    const updated = await db.gatewayAutomationConfiguration.findUniqueOrThrow({ where: { gatewayId: gateway.id } });
    expect(updated.desiredRevision).toBe(before.desiredRevision + 1);
    expect(await db.mqttOutbox.count({ where: { gatewayId: gateway.id } })).toBe(outboxBefore + 1);
    const published = await db.mqttOutbox.findFirstOrThrow({ where: { gatewayId: gateway.id, revision: updated.desiredRevision } });
    expect(published.payload).toMatchObject({ holidayDatasets: [{ year: 2027, revision: promoted.revision }] });
    const pointer = await cached(2027), datasetCount = await db.holidayDataset.count({ where: { year: 2027 } });
    rollback = true; h.state.changed = false;
    expect((await h.service.refreshYear(2027)).status).toBe("failed");
    expect(await cached(2027)).toEqual(pointer);
    expect(await db.holidayDataset.count({ where: { year: 2027 } })).toBe(datasetCount);
    expect(await db.gatewayAutomationConfiguration.findUniqueOrThrow({ where: { gatewayId: gateway.id } })).toEqual(updated);
    expect(await db.mqttOutbox.count({ where: { gatewayId: gateway.id } })).toBe(outboxBefore + 1);
  });

  it("invalid year does not fetch or create a coverage pointer", async () => {
    const h = harness();
    expect(await h.service.refreshYear(0)).toEqual({ status: "failed", revision: null, reason: "holiday_year_invalid" });
    expect(h.calls).toHaveLength(0);
  });

  it("empty_month_complete_and_failed_refresh_keep_revision", async () => {
    const h = harness();
    expect((await h.service.refreshYear(2026)).status).toBe("promoted");
    const old = await cached(2026);
    expect(h.calls).toHaveLength(14);
    expect(h.calls.map(call => [call.month, call.page])).toEqual([
      [1, 1], [1, 2], [2, 1], [3, 1], [4, 1], [5, 1], [6, 1], [7, 1], [8, 1], [9, 1], [10, 1], [10, 2], [11, 1], [12, 1]
    ]);
    expect(old?.dataset.completenessProof).toEqual(expect.arrayContaining([{ month: 2, totalCount: 0, pageCount: 1,
      numOfRows: 2, pages: [{ page: 1, itemCount: 0 }] }]));
    expect(old?.dataset.dates).toEqual([
      { date: "2026-01-01", names: ["동일 날짜 다른 휴일", "신정"] },
      { date: "2026-10-03", names: ["개천절"] }, { date: "2026-10-09", names: ["한글날"] },
      { date: "2026-10-10", names: ["대체공휴일"] }
    ]);
    expect(old?.dataset.payloadHash).toBe("sha256:1f648f3cd67eff2573d0397b79710adf03d78c608a52276e60133fa13941c0f3");
    h.state.fail = true;
    expect(await h.service.refreshYear(2026)).toMatchObject({ status: "failed", revision: old?.dataset.revision });
    expect(await cached(2026)).toEqual(old);
    expect(h.state.promotions).toHaveLength(1);
    expect((await h.service.loadCoverage("2026-01-01", "2026-12-31"))[0].revision).toBe(old?.dataset.revision);
  });

  it("unchanged normalized data preserves revision; late temporary holiday promotes exactly once", async () => {
    const h = harness();
    const old = await cached(2026);
    expect(await h.service.refreshYear(2026)).toMatchObject({ status: "unchanged", revision: old?.dataset.revision });
    expect(h.state.promotions).toHaveLength(0);
    h.state.changed = true;
    const result = await h.service.refreshYear(2026);
    expect(result.status).toBe("promoted");
    expect(result.revision).not.toBe(old?.dataset.revision);
    const dataset = (await cached(2026))!.dataset;
    expect(dataset.dates).toEqual(expect.arrayContaining([{ date: "2026-12-01", names: ["임시공휴일"] }]));
    expect(await db.holidayDataset.findUnique({ where: { id: old?.datasetId } })).toEqual(old?.dataset);
    expect(await h.service.refreshYear(2026)).toMatchObject({ status: "unchanged", revision: result.revision });
    expect(h.state.promotions).toHaveLength(1);
    h.state.changed = false;
    const reverted = await h.service.refreshYear(2026);
    expect(reverted.status).toBe("promoted");
    expect(reverted.revision).not.toBe(old?.dataset.revision);
    expect(reverted.revision).not.toBe(result.revision);
    expect((await cached(2026))?.dataset.payloadHash).toBe(old?.dataset.payloadHash);
    expect(h.state.promotions).toHaveLength(2);
    const reordered = harness({ fetchMonth: async (input, signal) => {
      const result = await h.provider.fetchMonth(input, signal);
      return { ...result, items: result.items.reverse() };
    } });
    expect(await reordered.service.refreshYear(2026)).toMatchObject({ status: "unchanged", revision: reverted.revision });
    expect(reordered.state.promotions).toHaveLength(0);
  });

  it.each([
    ["repeated page", (p: any) => ({ ...p, page: 1 })],
    ["changing total", (p: any) => ({ ...p, totalCount: 4 })],
    ["changing page size", (p: any) => ({ ...p, numOfRows: 3 })],
    ["duplicate row", (p: any) => ({ ...p, items: [{ date: "2028-01-01", name: "신정", isHoliday: true }] })],
    ["missing row", (p: any) => ({ ...p, items: [] })],
    ["invalid date", (p: any) => ({ ...p, items: [{ date: "2028-01-32", name: "잘못된 날짜", isHoliday: true }] })],
    ["wrong year", (p: any) => ({ ...p, year: 2029 })],
    ["wrong month date", (p: any) => ({ ...p, items: [{ date: "2028-02-01", name: "다른 월", isHoliday: true }] })],
    ["invalid holiday flag", (p: any) => ({ ...p, items: [{ date: "2028-01-03", name: "신정", isHoliday: "Y" }] })],
    ["unsafe total", (p: any) => ({ ...p, totalCount: Number.MAX_SAFE_INTEGER })]
  ])("rejects %s without a partial coverage pointer", async (_name, mutate) => {
    const baseline = harness();
    const provider = { fetchMonth: async (input: any, signal: AbortSignal) => {
      const result = await baseline.provider.fetchMonth(input, signal);
      return input.month === 1 && input.page === 2 ? mutate(result) : result;
    } };
    const h = harness(provider);
    expect(await h.service.refreshYear(2028)).toMatchObject({ status: "failed", revision: null });
    expect(await cached(2028)).toBeNull();
    expect(await db.holidayDataset.count({ where: { year: 2028 } })).toBe(0);
    expect(h.state.promotions).toHaveLength(0);
  });

  it("rolls back new dataset and pointer if the snapshot promotion hook fails", async () => {
    const old = await cached(2026);
    const h = harness(undefined, { onPromoted: async () => { throw new Error("private snapshot URL/credential fixture"); } });
    h.state.changed = true;
    const beforeCount = await db.holidayDataset.count();
    expect(await h.service.refreshYear(2026)).toEqual({ status: "failed", revision: old?.dataset.revision,
      reason: "holiday_refresh_failed" });
    expect(await cached(2026)).toEqual(old);
    expect(await db.holidayDataset.count()).toBe(beforeCount);
  });

  it("hash mismatch and missing coverage never become an empty holiday list", async () => {
    const { holidayDatasetPayloadHash } = require("./holiday-dataset.service");
    const h = harness();
    // The Jan1 promotion regression intentionally populates 2027. Use explicitly
    // absent fixture years so this missing-coverage assertion is order independent.
    expect(await cached(2040)).toBeNull();
    expect(await cached(2041)).toBeNull();
    await expect(h.service.loadCoverage("2040-12-31", "2041-01-01")).rejects.toMatchObject({ status: 409 });
    const semantic = { country: "KR", source: "kasi", year: 2030, coverageFrom: "2030-01-01", coverageUntil: "2030-12-31",
      dates: [{ date: "2030-01-01", names: ["신정"] }] };
    const payloadHash = holidayDatasetPayloadHash(semantic);
    const data = { ...semantic, revision: "corrupt-test", fetchedAt: new Date(instant),
      coverageFrom: new Date("2030-01-01T00:00:00Z"), coverageUntil: new Date("2030-12-31T00:00:00Z"),
      payloadHash, complete: true,
      completenessProof: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, totalCount: i === 0 ? 1 : 0, pageCount: 1,
        numOfRows: 2, pages: [{ page: 1, itemCount: i === 0 ? 1 : 0 }] })) };
    const dataset = await db.holidayDataset.create({ data });
    await db.holidayYearCoverage.create({ data: { country: "KR", year: 2030, datasetId: dataset.id } });
    // Positive control: the nonempty dataset/proof is consumable, so the
    // empty-year guard cannot mask this regression. Complete rows are immutable;
    // the corrupt copy needs its own valid revision, then only the pointer moves.
    expect(await h.service.loadCoverage("2030-01-01", "2030-12-31")).toEqual([
      { ...semantic, revision: "corrupt-test", fetchedAt: instant, payloadHash }
    ]);
    const wrongHash = `sha256:${"a".repeat(64)}`;
    expect(payloadHash).not.toBe(wrongHash);
    const invalid = await db.holidayDataset.create({ data: { ...data, revision: "corrupt-test-invalid", payloadHash: wrongHash } });
    await db.holidayYearCoverage.update({ where: { country_year: { country: "KR", year: 2030 } }, data: { datasetId: invalid.id } });
    await expect(h.service.loadCoverage("2030-01-01", "2030-12-31")).rejects.toMatchObject({ status: 409 });
    await expect(h.service.loadCoverage("2026-02-30", "2026-03-01")).rejects.toMatchObject({ status: 400 });
  });

  it("without injected provider exposes unavailable and consumes only verified cache without network", async () => {
    const { HolidayDatasetService } = require("./holiday-dataset.service");
    const service = new HolidayDatasetService(db, new AutomationClock(), new AutomationSnapshotService(new AutomationClock()));
    services.push(service);
    const old = await cached(2026);
    expect(await service.refreshYear(2026)).toEqual({ status: "failed", revision: old?.dataset.revision, reason: "holiday_provider_unavailable" });
    expect((await service.loadCoverage("2026-01-01", "2026-12-31"))[0].revision).toBe(old?.dataset.revision);
    await service.onModuleInit();
    expect(liveCalls).toBe(0);
  });

  it.each([false, true])("zero-holiday whole year never replaces a verified cache (nonholiday rows=%s)", async nonholiday => {
    const baseline = harness();
    await baseline.service.refreshYear(2034);
    const old = await cached(2034);
    const count = await db.holidayDataset.count({ where: { year: 2034 } });
    const empty = harness({ fetchMonth: async input => ({ ...page(input.year, input.month, input.page),
      ...(nonholiday && input.month === 1 ? { totalCount: 1,
        items: [{ date: "2034-01-01", name: "기념일", isHoliday: false }] } : {}) }) });
    expect(await empty.service.refreshYear(2034)).toEqual({ status: "failed", revision: old?.dataset.revision,
      reason: "holiday_provider_unavailable" });
    expect(await cached(2034)).toEqual(old);
    expect(await db.holidayDataset.count({ where: { year: 2034 } })).toBe(count);
    expect(empty.state.promotions).toHaveLength(0);
    expect((await empty.service.loadCoverage("2034-01-01", "2034-12-31"))[0].revision).toBe(old?.dataset.revision);
  });

  it("zero-holiday whole year creates no coverage", async () => {
    const h = harness({ fetchMonth: async input => page(input.year, input.month, input.page) });
    expect(await h.service.refreshYear(2035)).toEqual({ status: "failed", revision: null, reason: "holiday_provider_unavailable" });
    expect(await cached(2035)).toBeNull();
    expect(await db.holidayDataset.count({ where: { year: 2035 } })).toBe(0);
  });

  it("a coherent zero-holiday cached whole year is unavailable", async () => {
    const { holidayDatasetPayloadHash } = require("./holiday-dataset.service");
    const h = harness();
    const semantic = { country: "KR", source: "kasi", year: 2035, coverageFrom: "2035-01-01", coverageUntil: "2035-12-31", dates: [] };
    const empty = await db.holidayDataset.create({ data: { ...semantic, revision: randomUUID(), fetchedAt: new Date(instant),
      coverageFrom: new Date("2035-01-01Z"), coverageUntil: new Date("2035-12-31Z"),
      payloadHash: holidayDatasetPayloadHash(semantic), complete: true,
      completenessProof: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, totalCount: 0, pageCount: 1,
        numOfRows: 2, pages: [{ page: 1, itemCount: 0 }] })) } });
    await db.holidayYearCoverage.create({ data: { country: "KR", year: 2035, datasetId: empty.id, complete: true } });
    await expect(h.service.loadCoverage("2035-01-01", "2035-12-31")).rejects.toMatchObject({ status: 409 });
  });

  it("periodic_refresh_and_shutdown", async () => {
    jest.useFakeTimers({ doNotFake: ["nextTick", "setImmediate"] });
    jest.setSystemTime(new Date(instant));
    const h = harness();
    const original = h.service.refreshYear.bind(h.service);
    const refreshed: number[] = [];
    let completed!: () => void;
    const secondCycle = new Promise<void>(resolve => { completed = resolve; });
    jest.spyOn(h.service, "refreshYear").mockImplementation(async (year) => {
      const result = await original(year);
      expect(["promoted", "unchanged"]).toContain(result.status);
      refreshed.push(year as number);
      if (refreshed.length === 4) completed();
      return result;
    });
    await h.service.onModuleInit();
    await jest.advanceTimersByTimeAsync(86_400_000);
    await secondCycle;
    expect(refreshed).toEqual([2026, 2027, 2026, 2027]);
    await h.service.onModuleDestroy();
    const atStop = h.calls.length;
    await jest.advanceTimersByTimeAsync(86_400_000);
    expect(h.calls.length - atStop).toBe(0);
  });

  it("shutdown aborts an in-flight provider and never starts its next month", async () => {
    let captured: AbortSignal | undefined;
    let calls = 0;
    const h = harness({ fetchMonth: async (_input, signal) => {
      calls++;
      captured = signal;
      return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    } });
    const started = h.service.refreshYear(2031);
    await Promise.resolve();
    await h.service.onModuleDestroy();
    expect(captured?.aborted).toBe(true);
    expect((await started).status).toBe("failed");
    expect(calls).toBe(1);
    expect((await h.service.refreshYear(2031)).status).toBe("failed");
    expect(calls).toBe(1);
  });

  it("snapshot consumers read complete cross-year coverage in their existing transaction", async () => {
    const { loadHolidayCoverage } = require("./holiday-dataset.service");
    const datasets = await db.$transaction(tx => loadHolidayCoverage(tx, "2026-12-31", "2027-01-01")) as any[];
    expect(datasets.map(dataset => dataset.year)).toEqual([2026, 2027]);
    expect(datasets.map(dataset => dataset.revision)).toEqual([(await cached(2026))?.dataset.revision, (await cached(2027))?.dataset.revision]);
  });

  it("coalesces concurrent refreshes into one complete promotion", async () => {
    const h = harness();
    const results = await Promise.all([h.service.refreshYear(2033), h.service.refreshYear(2033)]);
    expect(results[0]).toEqual(results[1]);
    expect(results[0].status).toBe("promoted");
    expect(h.calls).toHaveLength(14);
    expect(h.state.promotions).toHaveLength(1);
    expect(await db.holidayDataset.count({ where: { year: 2033 } })).toBe(1);
  });

  it("pins official JSON adapter, query, singleton/array and normal empty month", async () => {
    const { KasiHolidayProvider } = require("./holiday-provider");
    const urls: URL[] = [];
    const responses = [envelope({ item: sourceRow() }), envelope({ item: [sourceRow()] }), envelope("", 0)];
    const mockFetch = async (url: any, options: any) => {
      urls.push(new URL(url));
      expect(options.signal).toBeInstanceOf(AbortSignal);
      return { ok: true, json: async () => responses.shift() };
    };
    const provider = new KasiHolidayProvider("test-key+value", mockFetch);
    for (let i = 0; i < 2; i++) expect(await provider.fetchMonth({ year: 2026, month: 1, page: 1 }, controller().signal)).toEqual({
      year: 2026, month: 1, page: 1, numOfRows: 2, totalCount: 1, items: [{ date: "2026-01-01", name: "신정", isHoliday: true }]
    });
    expect((await provider.fetchMonth({ year: 2026, month: 2, page: 1 }, controller().signal)).items).toEqual([]);
    expect(urls[0].origin).toBe("https://apis.data.go.kr");
    expect(urls[0].pathname).toBe("/B090041/openapi/service/SpcdeInfoService/getRestDeInfo");
    expect(Object.fromEntries(urls[0].searchParams)).toEqual({ ServiceKey: "test-key+value", solYear: "2026", solMonth: "01", pageNo: "1", numOfRows: "100", _type: "json" });
  });

  it.each([
    ["result error", { response: { header: { resultCode: "22" } } }],
    ["missing body", { response: { header: { resultCode: "00" } } }],
    ["missing items", envelope(undefined, 0)],
    ["empty nonempty month", envelope("", 1)],
    ["bad date", envelope({ item: sourceRow(20260230) })],
    ["wrong month", envelope({ item: sourceRow(20260201) })],
    ["holiday flag", envelope({ item: sourceRow(20260101, "신정", "maybe") })],
    ["array holiday flag", envelope({ item: sourceRow(20260101, "신정", ["Y"]) })],
    ["array source date", envelope({ item: { ...sourceRow(), locdate: [20260101] } })],
    ["bad total", envelope({ item: sourceRow() }, -1)],
    ["bad page", envelope({ item: sourceRow() }, 1, 2)],
    ["zero rows", envelope({ item: sourceRow() }, 1, 1, 0)]
  ])("official adapter rejects %s with a sanitized failure", async (_name, body) => {
    const { KasiHolidayProvider } = require("./holiday-provider");
    const provider = new KasiHolidayProvider("test-secret", async () => ({ ok: true, json: async () => body }));
    await expect(provider.fetchMonth({ year: 2026, month: 1, page: 1 }, controller().signal)).rejects.toThrow("holiday_provider_invalid_response");
  });

  it("sanitizes transport/JSON errors and enforces provider timeout", async () => {
    const { KasiHolidayProvider } = require("./holiday-provider");
    const secret = "test-secret-ServiceKey";
    const provider = new KasiHolidayProvider(secret, async () => { throw new Error(secret); });
    await expect(provider.fetchMonth({ year: 2026, month: 1, page: 1 }, controller().signal)).rejects.toThrow("holiday_provider_unavailable");
    jest.useFakeTimers();
    const hanging = new KasiHolidayProvider(secret, async (_url: any, options: any) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => reject(new Error(secret)), { once: true });
    }));
    const outcome = hanging.fetchMonth({ year: 2026, month: 1, page: 1 }, controller().signal).catch((error: Error) => error.message);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(await outcome).toBe("holiday_provider_unavailable");
  });

  it.each(["fetch", "json"])("deadline bounds an uncooperative %s transport", async phase => {
    const { KasiHolidayProvider } = require("./holiday-provider");
    jest.useFakeTimers();
    const forever = () => new Promise<never>(() => {});
    const provider = new KasiHolidayProvider("test-secret", async () => phase === "fetch" ? forever() : { ok: true, json: forever });
    let outcome = "pending";
    void provider.fetchMonth({ year: 2026, month: 1, page: 1 }, controller().signal).then(
      () => { outcome = "success"; }, (error: Error) => { outcome = error.message; });
    await jest.advanceTimersByTimeAsync(10_000);
    expect(outcome).toBe("holiday_provider_unavailable");
  });

  it("already aborted provider input performs zero transport calls", async () => {
    const { KasiHolidayProvider } = require("./holiday-provider");
    const fetcher = jest.fn(async () => ({ ok: true, json: async () => envelope("", 0) }));
    const provider = new KasiHolidayProvider("test-secret", fetcher);
    const abort = controller(); abort.abort();
    await expect(provider.fetchMonth({ year: 2026, month: 1, page: 1 }, abort.signal)).rejects.toThrow("holiday_provider_unavailable");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("coherent hash cannot certify dates beyond the stored month evidence", async () => {
    const h = harness();
    const invalid = await db.holidayDataset.create({ data: { country: "KR", source: "kasi", year: 2032, revision: "inconsistent-proof-test",
      fetchedAt: new Date(instant), coverageFrom: new Date("2032-01-01T00:00:00Z"), coverageUntil: new Date("2032-12-31T00:00:00Z"),
      payloadHash: "sha256:dadccccaccdbb34a5b528d42c53795658ee15621a3c7ef6fd64173a0882d129e", dates: [{ date: "2032-01-01", names: ["신정"] }], complete: true,
      completenessProof: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, totalCount: 0, pageCount: 1,
        numOfRows: 2, pages: [{ page: 1, itemCount: 0 }] })) } });
    await db.holidayYearCoverage.create({ data: { country: "KR", year: 2032, datasetId: invalid.id } });
    await expect(h.service.loadCoverage("2032-01-01", "2032-12-31")).rejects.toMatchObject({ status: 409 });
  });

  it("coverage database outage is a sanitized service-unavailable response", async () => {
    const h = harness();
    const outage = jest.spyOn(db, "$transaction").mockRejectedValue(new Error("private database connection URL"));
    try {
      await expect(h.service.loadCoverage("2026-01-01", "2026-12-31")).rejects.toMatchObject({ status: 503 });
    } finally { outage.mockRestore(); }
    const { loadHolidayCoverage } = require("./holiday-dataset.service");
    await expect(loadHolidayCoverage({ holidayYearCoverage: { findMany: async () => { throw new Error("private database connection URL"); } } },
      "2026-01-01", "2026-12-31")).rejects.toMatchObject({ status: 503 });
  });
});
