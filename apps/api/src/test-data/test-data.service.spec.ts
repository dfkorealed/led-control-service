import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { EnergyDimensionHistoryService } from "../energy/energy-dimension-history.service";
import { createEnergyHistoryTestStore } from "../energy/test-support/energy-history-test-store";
import { TestDataService } from "./test-data.service";

const siteId = "site-1";
const user = {
  id: "admin-1",
  organizationId: "customer-org-1",
  organizationType: "customer",
  loginId: "site-admin",
  name: "Site Admin",
  role: "admin",
  mustChangePassword: false,
  status: "active"
} as const;

type StoredGateway = { id: string; siteId: string; serialNumber: string };
type StoredNode = { id: string; gatewayId: string; deviceUuid: string };
type StoredFixture = {
  id: string;
  floorId: string;
  siteId: string;
  gatewayId: string;
  meshNodeId: string;
  name: string;
  ratedWatt: Prisma.Decimal;
  energyTrackingStartedAt: Date;
};

function createHarness(options: {
  floors?: Array<{ id: string; siteId: string; name: string }>;
  accessError?: Error;
  directGatewayDependency?: "fixtureGroup" | "commandDispatch" | "gatewayCertificate";
} = {}) {
  const floors = options.floors ?? [{ id: "floor-1", siteId, name: "Floor 1" }];
  const gateways: StoredGateway[] = [];
  const nodes: StoredNode[] = [];
  const fixtures: StoredFixture[] = [];
  const history = createEnergyHistoryTestStore();
  const fixtureIdentities = history.identities;
  let sequence = 0;
  const nextId = (kind: string) => `${kind}-${++sequence}`;
  const tx: any = {
    $queryRaw: jest.fn(async () => fixtures.map(({ id }) => ({ id }))),
    floor: { findMany: jest.fn(async ({ where }: any) => floors.filter((floor) => floor.siteId === where.siteId)) },
    gateway: {
      findUnique: jest.fn(async ({ where }: any) => gateways.find((gateway) => gateway.serialNumber === where.serialNumber) ?? null),
      findMany: jest.fn(async ({ where }: any) => gateways.filter((gateway) => gateway.siteId === where.siteId
        && gateway.serialNumber.startsWith(where.serialNumber.startsWith))),
      create: jest.fn(async ({ data }: any) => {
        const gateway = { id: nextId("gateway"), siteId: data.siteId, serialNumber: data.serialNumber };
        gateways.push(gateway);
        return gateway;
      }),
      deleteMany: jest.fn(async ({ where }: any) => {
        const removed = gateways.filter((gateway) => gateway.siteId === where.siteId && gateway.serialNumber.startsWith(where.serialNumber.startsWith));
        const ids = new Set(removed.map((gateway) => gateway.id));
        for (const gateway of removed) gateways.splice(gateways.indexOf(gateway), 1);
        for (const node of nodes.filter((node) => ids.has(node.gatewayId))) nodes.splice(nodes.indexOf(node), 1);
        return { count: removed.length };
      }),
      updateMany: jest.fn(async () => ({ count: gateways.length }))
    },
    meshNode: {
      findUnique: jest.fn(async ({ where }: any) => nodes.find((node) => node.deviceUuid === where.deviceUuid) ?? null),
      findMany: jest.fn(async ({ where }: any) => nodes.filter((node) => where.deviceUuid.in.includes(node.deviceUuid))),
      findFirst: jest.fn(async ({ where }: any) => nodes.find((node) => where.gatewayId.in.includes(node.gatewayId)
        && (node.deviceUuid === null || !node.deviceUuid.startsWith(where.OR[1].NOT.deviceUuid.startsWith))) ?? null),
      create: jest.fn(async ({ data }: any) => {
        const node = { id: nextId("node"), gatewayId: data.gatewayId, deviceUuid: data.deviceUuid };
        nodes.push(node);
        return node;
      }),
      createMany: jest.fn(async ({ data }: any) => {
        for (const item of data) nodes.push({ id: item.id, gatewayId: item.gatewayId, deviceUuid: item.deviceUuid });
        return { count: data.length };
      })
    },
    fixture: {
      findUnique: jest.fn(async ({ where }: any) => fixtures.find((fixture) => fixture.meshNodeId === where.meshNodeId) ?? null),
      findMany: jest.fn(async ({ where }: any) => {
        const found = where.meshNodeId
          ? fixtures.filter((fixture) => where.meshNodeId.in.includes(fixture.meshNodeId))
          : !where.siteId
            ? fixtures.filter((fixture) => {
              const node = nodes.find((candidate) => candidate.id === fixture.meshNodeId);
              return node && where.meshNode.gatewayId.in.includes(node.gatewayId);
            })
            : fixtures.filter((fixture) => {
              const node = nodes.find((candidate) => candidate.id === fixture.meshNodeId);
              const gatewayMatches = where.meshNode.gatewayId
                ? where.meshNode.gatewayId.in.includes(node?.gatewayId)
                : gateways.some((gateway) => gateway.id === node?.gatewayId
                  && gateway.siteId === where.meshNode.gateway.siteId
                  && gateway.serialNumber.startsWith(where.meshNode.gateway.serialNumber.startsWith));
              return fixture.siteId === where.siteId
                && fixture.name.startsWith(where.name.startsWith)
                && node?.deviceUuid.startsWith(where.meshNode.deviceUuid.startsWith)
                && gatewayMatches;
            });
        return found.map((fixture) => ({ ...fixture, floor: floors.find((floor) => floor.id === fixture.floorId) }));
      }),
      findFirst: jest.fn(async ({ where }: any) => fixtures.find((fixture) => {
        const node = nodes.find((candidate) => candidate.id === fixture.meshNodeId);
        return node !== undefined
          && where.meshNode.gatewayId.in.includes(node.gatewayId)
          && node.deviceUuid.startsWith(where.meshNode.deviceUuid.startsWith)
          && !fixture.name.startsWith(where.NOT.name.startsWith);
      }) ?? null),
      create: jest.fn(async ({ data }: any) => {
        const fixture = {
          id: nextId("fixture"), floorId: data.floorId, siteId: data.siteId, gatewayId: data.gatewayId,
          meshNodeId: data.meshNodeId, name: data.name, ratedWatt: new Prisma.Decimal(data.ratedWatt),
          energyTrackingStartedAt: data.energyTrackingStartedAt ?? new Date()
        };
        fixtures.push(fixture);
        return fixture;
      }),
      createMany: jest.fn(async ({ data }: any) => {
        for (const item of data) fixtures.push({
          id: nextId("fixture"), floorId: item.floorId, siteId: item.siteId, gatewayId: item.gatewayId,
          meshNodeId: item.meshNodeId, name: item.name, ratedWatt: new Prisma.Decimal(item.ratedWatt),
          energyTrackingStartedAt: item.energyTrackingStartedAt ?? new Date()
        });
        return { count: data.length };
      }),
      updateMany: jest.fn(async () => ({ count: fixtures.length })),
      deleteMany: jest.fn(async ({ where }: any) => {
        if (where.id) {
          const removableIds = new Set(where.id.in);
          const removed = fixtures.filter((fixture) => removableIds.has(fixture.id));
          for (const fixture of removed) fixtures.splice(fixtures.indexOf(fixture), 1);
          return { count: removed.length };
        }
        const removableNodeIds = new Set(nodes.filter((node) => node.deviceUuid.startsWith(where.meshNode.deviceUuid.startsWith)).map((node) => node.id));
        const removed = fixtures.filter((fixture) => fixture.siteId === where.siteId
          && (!where.name || fixture.name.startsWith(where.name.startsWith))
          && removableNodeIds.has(fixture.meshNodeId));
        for (const fixture of removed) fixtures.splice(fixtures.indexOf(fixture), 1);
        return { count: removed.length };
      })
    },
    fixtureGroup: { findFirst: jest.fn(async () => options.directGatewayDependency === "fixtureGroup" ? { id: "real-group" } : null) },
    meshControlGroup: { findFirst: jest.fn(async () => null) },
    commandDispatch: { findFirst: jest.fn(async () => options.directGatewayDependency === "commandDispatch" ? { id: "real-dispatch" } : null) },
    processedGatewayEvent: { findFirst: jest.fn(async () => null) },
    provisioningSession: { findFirst: jest.fn(async () => null) },
    gatewayCertificate: { findFirst: jest.fn(async () => options.directGatewayDependency === "gatewayCertificate" ? { id: "real-certificate" } : null) },
    gatewayInventory: { findFirst: jest.fn(async () => null) },
    mqttOutbox: { findFirst: jest.fn(async () => null) },
    gatewayAutomationConfiguration: { findFirst: jest.fn(async () => null) },
    lightingSchedule: { findFirst: jest.fn(async () => null) },
    vehicleEventRule: { findFirst: jest.fn(async () => null) },
    manualOverride: { findFirst: jest.fn(async () => null) },
    automationExecution: { findFirst: jest.fn(async () => null) },
    groupFixture: { findFirst: jest.fn(async () => null) },
    energyUsage: { findFirst: jest.fn(async () => null) },
    fixtureEnergyDailyAggregate: { findFirst: jest.fn(async () => null) },
    energyGroupMembershipVersion: { findFirst: jest.fn(async () => null) },
    fixtureEnergyStateCursor: { findFirst: jest.fn(async () => null) },
    commandFixtureResult: { findFirst: jest.fn(async () => null) },
    lightingScheduleFixture: { findFirst: jest.fn(async () => null) },
    vehicleEventSource: { findFirst: jest.fn(async () => null) },
    vehicleEventTarget: { findFirst: jest.fn(async () => null) },
    manualOverrideFixture: { findFirst: jest.fn(async () => null) },
    automationExecutionFixtureResult: { findFirst: jest.fn(async () => null) }
  };
  Object.assign(tx, history.tx);
  tx.fixtureEnergyHourlyAggregate = { findFirst: jest.fn(async () => null) };
  const energyDimensions = new EnergyDimensionHistoryService();
  const prisma = { ...tx, $transaction: jest.fn(async (callback: (client: unknown) => Promise<unknown>) => callback(tx)) };
  const siteAccess = { assertManageInTransaction: jest.fn(async () => {
    if (options.accessError) throw options.accessError;
    return { id: siteId, organizationId: user.organizationId };
  }) };
  const service = new TestDataService(prisma, siteAccess as never, energyDimensions as never);
  return { service, prisma, tx, siteAccess, energyDimensions, gateways, nodes, fixtures, fixtureIdentities, history };
}

describe("TestDataService", () => {
  const previousFlag = process.env.VITE_TEST_DATA_TOOLS_ENABLED;

  beforeEach(() => { process.env.VITE_TEST_DATA_TOOLS_ENABLED = "true"; });
  afterAll(() => {
    if (previousFlag === undefined) delete process.env.VITE_TEST_DATA_TOOLS_ENABLED;
    else process.env.VITE_TEST_DATA_TOOLS_ENABLED = previousFlag;
  });

  it("returns 404 while the test-data flag is disabled", async () => {
    delete process.env.VITE_TEST_DATA_TOOLS_ENABLED;
    const { service, prisma } = createHarness();

    await expect(service.create(user, siteId)).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("delegates authorization to the transaction-safe manage capability", async () => {
    const accessError = new NotFoundException("site not found");
    const { service, siteAccess } = createHarness({ accessError });

    await expect(service.create(user, siteId)).rejects.toThrow("site not found");
    expect(siteAccess.assertManageInTransaction).toHaveBeenCalledWith(expect.anything(), user, siteId);
  });

  it("creates one marked gateway and exactly 200 online marked fixture-node pairs for every floor", async () => {
    const h = createHarness({ floors: [{ id: "floor-1", siteId, name: "Floor 1" }, { id: "floor-2", siteId, name: "Floor 2" }] });

    await expect(h.service.create(user, siteId)).resolves.toEqual({
      floors: { total: 2, created: 0, existing: 2, deleted: 0 },
      gateways: { created: 2, existing: 0, deleted: 0 },
      fixtures: { created: 400, existing: 0, deleted: 0 }
    });

    expect(h.gateways).toHaveLength(2);
    expect(h.nodes).toHaveLength(400);
    expect(h.fixtures).toHaveLength(400);
    expect(h.tx.gateway.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({
      serialNumber: expect.stringContaining("led-control-test-data/v1/gateway/") , lastHeartbeatAt: expect.any(Date)
    }) }));
    expect(h.tx.gateway.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ nextMeshUnicastAddress: 0x01c8 }) }));
    expect(h.tx.meshNode.createMany).toHaveBeenCalledTimes(2);
    expect(h.tx.meshNode.createMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.arrayContaining([
      expect.objectContaining({ deviceUuid: expect.stringContaining("led-control-test-data/v1/node/"), meshAddress: "0x0100" })
    ]) }));
    expect(h.tx.fixture.createMany).toHaveBeenCalledWith(expect.objectContaining({ data: expect.arrayContaining([
      expect.objectContaining({ status: "online", placementStatus: "placed", lastSeenAt: expect.any(Date), lastStateOccurredAt: expect.any(Date),
        meshNodeId: expect.any(String), gatewayId: expect.any(String), rssi: expect.any(Number), hopCount: expect.any(Number) })
    ]) }));
    expect(new Set(h.fixtures.map((fixture) => fixture.meshNodeId)).size).toBe(400);
    expect(h.fixtures.every((fixture) => h.nodes.some((node) => node.id === fixture.meshNodeId && node.gatewayId === fixture.gatewayId))).toBe(true);
  });

  it("is idempotent and reports previously generated rows without duplicate writes", async () => {
    const h = createHarness();
    await h.service.create(user, siteId);
    h.tx.gateway.create.mockClear();
    h.tx.meshNode.createMany.mockClear();
    h.tx.fixture.createMany.mockClear();

    await expect(h.service.create(user, siteId)).resolves.toEqual({
      floors: { total: 1, created: 0, existing: 1, deleted: 0 },
      gateways: { created: 0, existing: 1, deleted: 0 },
      fixtures: { created: 0, existing: 200, deleted: 0 }
    });
    expect(h.tx.gateway.create).not.toHaveBeenCalled();
    expect(h.tx.meshNode.createMany).not.toHaveBeenCalled();
    expect(h.tx.fixture.createMany).not.toHaveBeenCalled();
  });

  it("records an identity and current dimension for every marker fixture, including existing fixtures missing history", async () => {
    const h = createHarness();

    await h.service.create(user, siteId);
    const firstFixtureId = h.fixtures[0]!.id;

    expect(h.fixtureIdentities).toHaveLength(200);
    expect(h.fixtureIdentities.map((identity) => identity.fixtureId)).toContain(firstFixtureId);
    expect(h.history.versions).toContainEqual(expect.objectContaining({
      energyFixtureId: h.fixtureIdentities.find((identity) => identity.fixtureId === firstFixtureId)!.id,
      name: "[TEST DATA] Fixture 001",
      floorId: "floor-1",
      floorName: "Floor 1",
      ratedWatt: new Prisma.Decimal("40.00"),
      effectiveFrom: expect.any(Date),
      effectiveTo: null
    }));

    await h.tx.energyFixtureIdentity.deleteMany({ where: { id: { in: [h.fixtureIdentities[0]!.id] } } });
    await h.service.create(user, siteId);

    expect(h.fixtureIdentities).toHaveLength(200);
    expect(h.history.versions).toHaveLength(200);
  });

  it("keeps real energy history queries bounded for 1,000 new fixtures and an unchanged repeat", async () => {
    const h = createHarness({ floors: Array.from({ length: 5 }, (_, index) => ({
      id: `floor-${index}`, siteId, name: `Floor ${index}`
    })) });

    await h.service.create(user, siteId);
    const initialQueries = h.history.queryCount();
    expect(h.fixtureIdentities).toHaveLength(1000);
    expect(h.history.versions).toHaveLength(1000);

    await h.service.create(user, siteId);
    const repeatQueries = h.history.queryCount() - initialQueries;
    expect(h.fixtureIdentities).toHaveLength(1000);
    expect(h.history.versions).toHaveLength(1000);
    console.info("energy history query counts", { initialQueries, repeatQueries });
    expect(initialQueries).toBeLessThanOrEqual(6);
    expect(repeatQueries).toBeLessThanOrEqual(3);
  });

  it("repairs a missing current dimension and closes changed dimensions at one effective time without touching unchanged history", async () => {
    const h = createHarness();
    await h.service.create(user, siteId);
    const firstIdentity = h.fixtureIdentities.find((identity) => identity.fixtureId === h.fixtures[0]!.id)!;
    const old = h.history.versions.find((version) => version.energyFixtureId === firstIdentity.id)!;
    const unchanged = h.history.versions.find((version) => version.energyFixtureId === h.fixtureIdentities[2]!.id)!;
    h.fixtures[0]!.name = "[TEST DATA] Fixture renamed";
    h.fixtures[0]!.ratedWatt = new Prisma.Decimal(55);
    h.history.versions.find((version) => version.energyFixtureId === h.fixtureIdentities[1]!.id)!.effectiveTo = new Date("2026-01-01T00:00:00Z");

    await h.service.create(user, siteId);

    const replacement = h.history.versions.find((version) => version.energyFixtureId === firstIdentity.id && version.effectiveTo === null)!;
    expect(h.fixtureIdentities).toHaveLength(200);
    expect(h.history.versions).toHaveLength(202);
    expect(h.history.versions.filter((version) => version.effectiveTo === null)).toHaveLength(200);
    expect(replacement).toEqual(expect.objectContaining({ name: "[TEST DATA] Fixture renamed", ratedWatt: new Prisma.Decimal(55) }));
    expect(old.effectiveTo).toEqual(replacement.effectiveFrom);
    expect(unchanged.effectiveTo).toBeNull();
    expect(h.history.versions.filter((version) => version.energyFixtureId === unchanged.energyFixtureId)).toEqual([unchanged]);
  });

  it("waits for sorted verified fixture locks before checks and rejects analytics committed while waiting", async () => {
    const h = createHarness();
    await h.service.create(user, siteId);
    const verifiedIds = h.fixtures.map(({ id }) => id).sort();
    let releaseLock!: () => void;
    const barrier = new Promise<void>((resolve) => { releaseLock = resolve; });
    const events: string[] = [];
    h.tx.$queryRaw.mockImplementation(async (query: Prisma.Sql) => {
      expect(query.sql).toMatch(/ORDER BY .*"id"\s+FOR UPDATE/);
      expect(query.values).toEqual(verifiedIds);
      events.push("fixture-lock-requested");
      await barrier;
      events.push("fixture-lock-acquired");
      return verifiedIds.map((id) => ({ id }));
    });
    h.tx.fixtureEnergyHourlyAggregate.findFirst.mockImplementation(async () => {
      events.push("analytics-check");
      return events.includes("fixture-lock-acquired") ? { id: "committed-aggregate" } : null;
    });
    const cleanup = h.service.remove(user, siteId);
    const outcome = cleanup.then(() => "deleted", (error: unknown) => error);
    // Flush the finite service read sequence while the simulated ingestion owns the row lock.
    for (let step = 0; step < 30; step++) await Promise.resolve();
    const beforeRelease = [...events];
    const checksBeforeRelease = Object.values(h.tx).flatMap((delegate: any) =>
      delegate.findFirst?.mock?.calls ?? []);
    releaseLock();
    const result = await outcome;

    expect(beforeRelease).toEqual(["fixture-lock-requested"]);
    expect(checksBeforeRelease).toEqual([]);
    expect(result).toBeInstanceOf(ConflictException);
    expect(events).toEqual(["fixture-lock-requested", "fixture-lock-acquired", "analytics-check"]);
    expect(h.tx.energyFixtureIdentity.deleteMany).not.toHaveBeenCalled();
    expect(h.tx.fixture.deleteMany).not.toHaveBeenCalled();
    expect(h.tx.gateway.deleteMany).not.toHaveBeenCalled();
    expect(h.fixtures).toHaveLength(200);
  });

  it("bulk-refreshes the marked gateway heartbeat and fixture online timestamps on a repeat POST", async () => {
    const h = createHarness();
    await h.service.create(user, siteId);
    h.tx.gateway.updateMany.mockClear();
    h.tx.fixture.updateMany.mockClear();

    await h.service.create(user, siteId);

    expect(h.tx.gateway.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [h.gateways[0]!.id] } },
      data: { lastHeartbeatAt: expect.any(Date) }
    });
    expect(h.tx.fixture.updateMany).toHaveBeenCalledWith({
      where: {
        siteId,
        floorId: "floor-1",
        gatewayId: h.gateways[0]!.id,
        meshNodeId: { in: h.nodes.map((node) => node.id) },
        name: { startsWith: "[TEST DATA] Fixture " }
      },
      data: { status: "online", statusReason: null, reportedStatus: "online", reportedStatusReason: null,
        lastSeenAt: expect.any(Date), lastStateOccurredAt: expect.any(Date) }
    });
  });

  it("uses a bounded number of bulk queries per floor instead of one query per fixture", async () => {
    const h = createHarness({ floors: [{ id: "floor-1", siteId, name: "Floor 1" }, { id: "floor-2", siteId, name: "Floor 2" }] });

    await h.service.create(user, siteId);

    expect(h.tx.meshNode.findUnique).not.toHaveBeenCalled();
    expect(h.tx.fixture.findUnique).not.toHaveBeenCalled();
    expect(h.tx.meshNode.findMany).toHaveBeenCalledTimes(2);
    expect(h.tx.fixture.findMany).toHaveBeenCalledTimes(3);
    expect(h.tx.meshNode.createMany.mock.calls.every(([input]: any[]) => input.data.length === 200)).toBe(true);
    expect(h.tx.fixture.createMany.mock.calls.every(([input]: any[]) => input.data.length === 200)).toBe(true);
  });

  it("refuses generation when a site has no floors", async () => {
    const { service } = createHarness({ floors: [] });
    await expect(service.create(user, siteId)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("deletes only marker-selected test rows and preserves real rows", async () => {
    const h = createHarness();
    await h.service.create(user, siteId);
    const verifiedFixtureIds = h.fixtures.map((fixture) => fixture.id);
    h.gateways.push({ id: "real-gateway", siteId, serialNumber: "REAL-GATEWAY-1" });
    h.nodes.push({ id: "real-node", gatewayId: "real-gateway", deviceUuid: "real-device-1" });
    h.fixtures.push({
      id: "real-fixture", siteId, floorId: "floor-1", gatewayId: "real-gateway", meshNodeId: "real-node",
      name: "Actual fixture", ratedWatt: new Prisma.Decimal("40.00"), energyTrackingStartedAt: new Date()
    });

    await expect(h.service.remove(user, siteId)).resolves.toEqual({
      floors: { total: 1, created: 0, existing: 0, deleted: 0 },
      gateways: { created: 0, existing: 0, deleted: 1 },
      fixtures: { created: 0, existing: 0, deleted: 200 }
    });
    expect(h.gateways).toEqual([{ id: "real-gateway", siteId, serialNumber: "REAL-GATEWAY-1" }]);
    expect(h.fixtures).toEqual([
      expect.objectContaining({
        id: "real-fixture", siteId, floorId: "floor-1", gatewayId: "real-gateway", meshNodeId: "real-node", name: "Actual fixture"
      })
    ]);
    expect(h.tx.fixture.deleteMany).toHaveBeenCalledWith({ where: { id: { in: verifiedFixtureIds } } });
    expect(h.tx.gateway.deleteMany).toHaveBeenCalledWith({ where: { siteId, serialNumber: { startsWith: "led-control-test-data/v1/gateway/" } } });
  });

  it("removes only marker fixture identities after confirming that no analytics history exists", async () => {
    const h = createHarness();
    await h.service.create(user, siteId);
    const identityIds = h.fixtureIdentities.map((identity) => identity.id);

    await h.service.remove(user, siteId);

    expect(h.fixtureIdentities).toHaveLength(0);
    expect(h.tx.energyFixtureIdentity.deleteMany).toHaveBeenCalledWith({ where: { id: { in: identityIds } } });
    expect(h.tx.fixtureEnergyHourlyAggregate.findFirst).toHaveBeenCalledWith({
      where: { energyFixtureId: { in: identityIds } }, select: { id: true }
    });
  });

  it("rejects all cleanup with 409 when a marker identity has analytics history", async () => {
    const h = createHarness();
    await h.service.create(user, siteId);
    h.tx.fixtureEnergyHourlyAggregate.findFirst.mockResolvedValueOnce({ id: "aggregate-1" });

    await expect(h.service.remove(user, siteId)).rejects.toBeInstanceOf(ConflictException);

    expect(h.tx.energyFixtureIdentity.deleteMany).not.toHaveBeenCalled();
    expect(h.tx.fixture.deleteMany).not.toHaveBeenCalled();
    expect(h.tx.gateway.deleteMany).not.toHaveBeenCalled();
  });

  it("fails closed before deletion when a marked gateway owns an unmarked MeshNode", async () => {
    const h = createHarness();
    await h.service.create(user, siteId);
    h.nodes.push({ id: "real-node", gatewayId: h.gateways[0]!.id, deviceUuid: "real-device-1" });

    await expect(h.service.remove(user, siteId)).rejects.toBeInstanceOf(ConflictException);
    expect(h.tx.meshNode.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ gatewayId: { in: [h.gateways[0]!.id] } }) }));
    expect(h.tx.fixture.deleteMany).not.toHaveBeenCalled();
    expect(h.tx.gateway.deleteMany).not.toHaveBeenCalled();
  });

  it("fails closed when a marked node is attached to an unmarked fixture", async () => {
    const h = createHarness();
    await h.service.create(user, siteId);
    h.fixtures[0]!.name = "Actual fixture";

    await expect(h.service.remove(user, siteId)).rejects.toBeInstanceOf(ConflictException);
    expect(h.tx.fixture.deleteMany).not.toHaveBeenCalled();
    expect(h.tx.gateway.deleteMany).not.toHaveBeenCalled();
  });

  it.each(["fixtureGroup", "commandDispatch", "gatewayCertificate"] as const)(
    "fails closed when a marked gateway has a non-test %s relation that deletion would cascade or mutate",
    async (directGatewayDependency) => {
      const h = createHarness({ directGatewayDependency });
      await h.service.create(user, siteId);

      await expect(h.service.remove(user, siteId)).rejects.toBeInstanceOf(ConflictException);
      expect(h.tx[directGatewayDependency].findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: { gatewayId: { in: [h.gateways[0]!.id] } }
      }));
      expect(h.tx.fixture.deleteMany).not.toHaveBeenCalled();
      expect(h.tx.gateway.deleteMany).not.toHaveBeenCalled();
    }
  );

  it("fails closed when a marked fixture belongs to a non-test fixture group that fixture deletion would cascade", async () => {
    const h = createHarness();
    await h.service.create(user, siteId);
    h.tx.groupFixture.findFirst.mockResolvedValueOnce({ groupId: "real-group", fixtureId: h.fixtures[0]!.id });

    await expect(h.service.remove(user, siteId)).rejects.toBeInstanceOf(ConflictException);
    expect(h.tx.groupFixture.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { fixtureId: { in: h.fixtures.map((fixture) => fixture.id) } }
    }));
    expect(h.tx.fixture.deleteMany).not.toHaveBeenCalled();
    expect(h.tx.gateway.deleteMany).not.toHaveBeenCalled();
  });

  it("deletes only the verified marker fixture IDs and preserves marker-like data attached to a real gateway", async () => {
    const h = createHarness();
    await h.service.create(user, siteId);
    const verifiedFixtureIds = h.fixtures.map((fixture) => fixture.id);
    h.gateways.push({ id: "real-gateway", siteId, serialNumber: "REAL-GATEWAY-1" });
    h.nodes.push({ id: "diverted-node", gatewayId: "real-gateway", deviceUuid: "led-control-test-data/v1/node/diverted/1" });
    h.fixtures.push({
      id: "diverted-fixture",
      siteId,
      floorId: "floor-1",
      gatewayId: "real-gateway",
      meshNodeId: "diverted-node",
      name: "[TEST DATA] Fixture diverted",
      ratedWatt: new Prisma.Decimal("40.00"),
      energyTrackingStartedAt: new Date()
    });

    await expect(h.service.remove(user, siteId)).resolves.toEqual(expect.objectContaining({
      fixtures: { created: 0, existing: 0, deleted: 200 }
    }));
    expect(h.fixtures).toContainEqual(expect.objectContaining({ id: "diverted-fixture", gatewayId: "real-gateway" }));
    expect(h.tx.fixture.deleteMany).toHaveBeenCalledWith({ where: { id: { in: verifiedFixtureIds } } });
  });

  it("fails closed instead of reusing a marker gateway assigned to another site", async () => {
    const h = createHarness();
    h.gateways.push({ id: "foreign-gateway", siteId: "other-site", serialNumber: "led-control-test-data/v1/gateway/floor-1" });

    await expect(h.service.create(user, siteId)).rejects.toBeInstanceOf(ConflictException);
    expect(h.tx.meshNode.createMany).not.toHaveBeenCalled();
    expect(h.tx.fixture.createMany).not.toHaveBeenCalled();
  });

  it("fails closed instead of refreshing marker nodes moved to a real gateway", async () => {
    const h = createHarness();
    await h.service.create(user, siteId);
    h.nodes[0]!.gatewayId = "real-gateway";
    h.tx.gateway.updateMany.mockClear();
    h.tx.fixture.updateMany.mockClear();

    await expect(h.service.create(user, siteId)).rejects.toBeInstanceOf(ConflictException);
    expect(h.tx.gateway.updateMany).not.toHaveBeenCalled();
    expect(h.tx.fixture.updateMany).not.toHaveBeenCalled();
  });

  it("fails closed instead of refreshing marker fixtures moved to another site", async () => {
    const h = createHarness();
    await h.service.create(user, siteId);
    h.fixtures[0]!.siteId = "other-site";
    h.tx.gateway.updateMany.mockClear();
    h.tx.fixture.updateMany.mockClear();

    await expect(h.service.create(user, siteId)).rejects.toBeInstanceOf(ConflictException);
    expect(h.tx.gateway.updateMany).not.toHaveBeenCalled();
    expect(h.tx.fixture.updateMany).not.toHaveBeenCalled();
  });

  it("fails closed before delete when a marker-name fixture on a marker gateway was moved to another site", async () => {
    const h = createHarness();
    await h.service.create(user, siteId);
    h.fixtures[0]!.siteId = "other-site";

    await expect(h.service.remove(user, siteId)).rejects.toBeInstanceOf(ConflictException);
    expect(h.tx.fixture.deleteMany).not.toHaveBeenCalled();
    expect(h.tx.gateway.deleteMany).not.toHaveBeenCalled();
  });
});
