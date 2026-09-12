import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import type { FixtureIdentifyCommand, FixtureStateV2 } from "@led-control/shared";
import { PrismaService } from "../prisma/prisma.service";
import { SiteAccessService } from "../access/site-access.service";
import { AuditService } from "../audit/audit.service";
import type { AuthenticatedUser } from "../auth/auth.types";
import { FixtureFreshnessService } from "../fixtures/fixture-freshness.service";
import { FixturesService } from "../fixtures/fixtures.service";
import { SitesService } from "../sites/sites.service";
import { CommandsService } from "../commands/commands.service";
import { CommandDispatchService } from "../commands/command-dispatch.service";
import { AutomationClock } from "../automation/automation-clock";
import { AutomationSnapshotService } from "../automation/automation-snapshot.service";
import { FixtureIdentifyService } from "../fixture-identify/fixture-identify.service";
import { hashEditorLeaseToken } from "../floor-editor/editor-lease-token";
import { FixtureStateIngestionService } from "../energy/fixture-state-ingestion.service";
import { MonitoringIncidentReconcilerService } from "./monitoring-incident-reconciler.service";

const databaseUrl = process.env.MONITORING_INCIDENTS_TEST_DATABASE_URL;
(databaseUrl ? describe : describe.skip)("monitoring policy and fixed control PostgreSQL boundary", () => {
  let prisma: PrismaService;
  let worker: FixtureFreshnessService;
  let ingestion: FixtureStateIngestionService;
  let siteId: string, floorId: string, gatewayId: string, fixtureId: string;
  let admin: AuthenticatedUser;
  let now: Date;
  beforeAll(() => {
    prisma = new PrismaService({ datasources: { db: { url: databaseUrl! } } });
    worker = new FixtureFreshnessService(prisma, new MonitoringIncidentReconcilerService());
    ingestion = new FixtureStateIngestionService(prisma);
  });
  beforeEach(async () => {
    now = new Date();
    const org = await prisma.organization.create({ data: { name: "boundary disposable", type: "customer" } });
    const user = await prisma.user.create({ data: { organizationId: org.id, role: "admin", name: "admin",
      loginId: "p1_" + randomUUID(), passwordHash: "unused" } });
    admin = { ...user, organizationType: "customer" };
    const site = await prisma.site.create({ data: { organizationId: org.id, adminUserId: admin.id,
      name: "boundary", tariffKwhRate: 100, gatewayOfflineAfterSeconds: 30, fixtureStaleAfterSeconds: 60 } });
    siteId = site.id;
    floorId = (await prisma.floor.create({ data: { siteId, name: "floor", level: 1 } })).id;
    gatewayId = (await prisma.gateway.create({ data: { siteId, name: "gateway", serialNumber: randomUUID(),
      firmwareVersion: "test", lastHeartbeatAt: now, claimedAt: now } })).id;
    const node = await prisma.meshNode.create({ data: { gatewayId, meshAddress: "0100", firmwareVersion: "test" } });
    fixtureId = (await prisma.fixture.create({ data: { siteId, floorId, gatewayId, meshNodeId: node.id, name: "light",
      ratedWatt: 20, x: 0, y: 0, energyTrackingStartedAt: new Date(now.getTime() - 600_000) } })).id;
    await prisma.energyFixtureIdentity.create({ data: { fixtureId, siteId, trackingStartedAt: new Date(now.getTime() - 600_000) } });
    await report(1, now);
  });
  afterEach(async () => {
    jest.useRealTimers(); jest.restoreAllMocks();
    await prisma.site.deleteMany({ where: { id: siteId } });
  });
  afterAll(() => prisma?.$disconnect());
  async function report(sequence: number, receivedAt: Date, statusReason: FixtureStateV2["statusReason"] = "reported") {
    return ingestion.ingest(gatewayId, { eventId: randomUUID(), siteId, gatewayId, fixtureId, sequence,
      occurredAt: receivedAt.toISOString(), brightness: 50, powerOn: true, status: "online", statusReason, rssi: -50, hopCount: 1 }, receivedAt);
  }
  const active = () => prisma.monitoringIncident.findMany({ where: { siteId, activeKey: { not: null } }, orderBy: { type: "asc" } });
  const display = () => new FixturesService(prisma, new SiteAccessService(prisma)).getFloorFixtures(admin, siteId, floorId, {});

  it("keeps Commands and Identify allowed through fixed 90 seconds despite a 30-second monitoring outage", async () => {
    // Freeze application and Identify database clocks, leaving database/network
    // timers real. PostgreSQL state/authorization/commands/audit remain real.
    jest.useFakeTimers({ now, doNotFake: ["nextTick", "setImmediate", "clearImmediate", "setTimeout", "clearTimeout",
      "setInterval", "clearInterval", "hrtime", "performance", "queueMicrotask"] });
    const transaction = prisma.$transaction.bind(prisma);
    jest.spyOn(prisma, "$transaction").mockImplementation((operation: any, options?: any) => transaction(async (tx) => operation(new Proxy(tx, {
      get(target, key) {
        if (key === "$queryRaw") return (sql: Prisma.Sql) => sql.sql.includes("clock_timestamp()")
          ? Promise.resolve([{ dbNow: now }]) : target.$queryRaw(sql);
        return Reflect.get(target, key);
      }
    })), options));
    const leaseToken = randomUUID();
    await prisma.floor.update({ where: { id: floorId }, data: { editorLeaseHolderId: admin.id,
      editorLeaseTokenHash: hashEditorLeaseToken(leaseToken), editorLeaseFence: 1,
      editorLeaseAcquiredAt: now, editorLeaseExpiresAt: new Date(now.getTime() + 600_000) } });
    const inventory = await prisma.gatewayInventory.create({ data: { serialNumber: randomUUID(), claimedGatewayId: gatewayId, claimedAt: now } });
    await prisma.gatewayCertificate.create({ data: { inventoryId: inventory.id, gatewayId, purpose: "mqtt", certificateSerial: randomUUID(),
      fingerprint: randomUUID(), issuer: "disposable metadata", status: "active", notBefore: new Date(now.getTime() - 1000),
      notAfter: new Date(now.getTime() + 600_000) } });
    const cache = new Map<string, string>();
    const redis = { get: async (key: string) => cache.get(key) ?? null,
      set: async (key: string, value: string, ...args: unknown[]) => {
        if (args.includes("NX") && cache.has(key)) return null;
        cache.set(key, value); return "OK";
      }, eval: async (_script: string, _keys: number, key: string, value: string) => {
        if (cache.get(key) !== value) return 0; cache.delete(key); return 1;
      } };
    let identify: FixtureIdentifyService;
    const mqtt = { publishTopic: async (_topic: string, command: FixtureIdentifyCommand) => identify.receiveResult({
      ...command, reportedAt: now.toISOString(), status: command.action === "start" ? "attention_confirmed" : "stopped",
      attentionSeconds: command.action === "start" ? 9 : 0
    }) };
    const access = new SiteAccessService(prisma);
    identify = new FixtureIdentifyService(prisma, access, new AuditService(prisma), { getClient: () => redis } as never, mqtt as never);
    const clock = new AutomationClock();
    const commands = new CommandsService(prisma, new CommandDispatchService(), access, {} as never, new AutomationSnapshotService(clock), clock);
    for (const age of [30_001, 90_000]) {
      await prisma.gateway.update({ where: { id: gatewayId }, data: { lastHeartbeatAt: new Date(now.getTime() - age) } });
      await worker.markStaleFixtures(now);
      const actions = await Promise.allSettled([
        commands.createDimmingCommand(admin, { siteId, target: { type: "fixture", fixtureId }, brightness: 40, clientRequestId: randomUUID() }),
        identify.identify(floorId, fixtureId, admin, { action: "start", leaseToken, leaseFence: 1 })
      ]);
      expect(actions.map((action) => action.status)).toEqual(["fulfilled", "fulfilled"]);
      if (actions[0].status !== "fulfilled" || actions[1].status !== "fulfilled") throw new Error("expected permitted actions");
      expect(actions[0].value).toMatchObject({ status: "pending" });
      const started = actions[1].value;
      expect((await display()).items[0]).toMatchObject({ status: "offline", statusReason: "gateway_offline", controllable: true });
      expect(await active()).toMatchObject([{ type: "gateway_offline" }]);
      expect(started.status).toBe("attention_confirmed");
      await identify.identify(floorId, fixtureId, admin, { action: "stop", sessionId: started.sessionId, leaseToken, leaseFence: 1 });
    }
    await prisma.gateway.update({ where: { id: gatewayId }, data: { lastHeartbeatAt: new Date(now.getTime() - 90_001) } });
    await worker.markStaleFixtures(now);
    await expect(commands.createDimmingCommand(admin, { siteId, target: { type: "fixture", fixtureId },
      brightness: 40, clientRequestId: randomUUID() })).rejects.toThrow("gateway is offline");
    await expect(identify.identify(floorId, fixtureId, admin, { action: "start", leaseToken, leaseFence: 1 })).rejects.toThrow("gateway_offline");
  });

  it("displays reported online through a lenient 300-second policy after fixed operational freshness is offline", async () => {
    await prisma.site.update({ where: { id: siteId }, data: { gatewayOfflineAfterSeconds: 300, fixtureStaleAfterSeconds: 300 } });
    const future = new Date(now.getTime() + 200_000);
    jest.useFakeTimers({ now: future, doNotFake: ["nextTick", "setImmediate", "clearImmediate", "setTimeout", "clearTimeout",
      "setInterval", "clearInterval", "hrtime", "performance", "queueMicrotask"] });
    await worker.markStaleFixtures(future);
    expect(await prisma.fixture.findUnique({ where: { id: fixtureId } })).toMatchObject({ status: "offline", reportedStatus: "online" });
    expect((await display()).items[0]).toMatchObject({ status: "online", statusReason: "reported", controllable: false });
    const dashboard = await new SitesService(prisma, new SiteAccessService(prisma)).getDashboard(admin, siteId, false);
    expect(dashboard.summary).toMatchObject({ onlineFixtures: 1 });
    expect(await active()).toHaveLength(0);
    jest.setSystemTime(new Date(now.getTime() + 300_000));
    expect((await display()).items[0].status).toBe("online");
    jest.setSystemTime(new Date(now.getTime() + 300_001));
    expect((await display()).items[0]).toMatchObject({ status: "offline", statusReason: "gateway_offline" });
  });

  it("keeps command_failed through gateway and fixture timeouts, then resolves only after an actual report clears it", async () => {
    await report(2, new Date(now.getTime() + 1), "command_failed");
    await worker.markStaleFixtures(new Date(now.getTime() + 200_000));
    expect(await active()).toMatchObject([{ type: "gateway_offline" }, { type: "command_failed" }]);
    const command = (await active()).find((incident) => incident.type === "command_failed")!;
    const recoveredHeartbeat = new Date(now.getTime() + 200_001);
    await prisma.gateway.update({ where: { id: gatewayId }, data: { lastHeartbeatAt: recoveredHeartbeat } });
    await worker.markStaleFixtures(recoveredHeartbeat);
    expect(await active()).toMatchObject([{ type: "fixture_stale" }, { id: command.id, type: "command_failed" }]);
    await report(3, new Date(now.getTime() + 200_002));
    await worker.markStaleFixtures(new Date(now.getTime() + 200_002));
    expect(await active()).toHaveLength(0);
    expect(await prisma.monitoringIncident.findUnique({ where: { id: command.id } }))
      .toMatchObject({ status: "resolved", resolutionKind: "automatic_recovery" });
  });
});
