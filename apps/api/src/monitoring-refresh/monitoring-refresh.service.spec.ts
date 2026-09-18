import { randomUUID } from "node:crypto";
import { MonitoringRefreshService } from "./monitoring-refresh.service";

const siteId = "11111111-1111-4111-8111-111111111111";
const floorId = "22222222-2222-4222-8222-222222222222";
const otherFloorId = "33333333-3333-4333-8333-333333333333";
const gatewayId = "44444444-4444-4444-8444-444444444444";
const clientRequestId = "55555555-5555-4555-8555-555555555555";
const now = new Date("2026-09-15T08:00:00.000Z");

const viewer = {
  id: "66666666-6666-4666-8666-666666666666",
  organizationId: "77777777-7777-4777-8777-777777777777",
  organizationType: "customer" as const,
  loginId: "viewer@example.com",
  name: "Viewer",
  role: "viewer" as const,
  status: "active" as const,
  mustChangePassword: false
};
const secondViewer = {
  ...viewer,
  id: "99999999-9999-4999-8999-999999999999",
  loginId: "second@example.com",
  name: "Second Viewer"
};

function refresh(overrides: Record<string, unknown> = {}) {
  return {
    id: "88888888-8888-4888-8888-888888888888",
    siteId,
    floorId,
    requestedById: viewer.id,
    clientRequestId,
    status: "pending",
    totalFixtures: 1,
    onlineFixtures: 0,
    offlineFixtures: 0,
    unverifiedFixtures: 0,
    deadlineAt: new Date("2026-09-15T08:00:30.000Z"),
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

function fixtures(count: number, assignedGatewayId = gatewayId) {
  return Array.from({ length: count }, (_, index) => ({
    id: `${String(index + 1).padStart(8, "0")}-0000-4000-8000-000000000000`,
    meshNode: { gatewayId: assignedGatewayId }
  }));
}

function harness() {
  let createdRefresh = refresh();
  const tx: any = {
    $queryRaw: jest.fn().mockResolvedValue([{ id: floorId }]),
    floor: { findFirst: jest.fn().mockResolvedValue({ id: floorId, siteId, status: "active" }) },
    fixture: { findMany: jest.fn().mockResolvedValue(fixtures(1)) },
    monitoringRefresh: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }) => {
        createdRefresh = refresh({ ...data, id: data.id });
        return Promise.resolve(createdRefresh);
      })
    },
    monitoringRefreshRequest: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve(data))
    },
    monitoringRefreshBatch: {
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...data }))
    },
    monitoringRefreshFixture: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    mqttOutbox: { create: jest.fn().mockResolvedValue({ id: randomUUID() }) },
    gateway: {
      update: jest.fn().mockResolvedValue({ id: gatewayId, siteId, nextCommandSequence: 1n })
    }
  };
  const prisma: any = {
    ...tx,
    $transaction: jest.fn((callback) => callback(tx))
  };
  const access: any = {
    assert: jest.fn().mockResolvedValue({ id: siteId }),
    assertReadInTransaction: jest.fn().mockResolvedValue({ id: siteId })
  };
  const generatedIds = [refresh().id, randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const service = new MonitoringRefreshService(prisma, access, {
    clock: () => now,
    uuid: () => generatedIds.shift() ?? randomUUID()
  });
  return { service, prisma, tx, access, getCreatedRefresh: () => createdRefresh };
}

describe("MonitoringRefreshService", () => {
  it("snapshots only server-selected active-floor fixtures and chunks each gateway at 64", async () => {
    const { service, tx } = harness();
    tx.fixture.findMany.mockResolvedValue(fixtures(65));
    tx.gateway.update
      .mockResolvedValueOnce({ id: gatewayId, siteId, nextCommandSequence: 1n })
      .mockResolvedValueOnce({ id: gatewayId, siteId, nextCommandSequence: 2n });

    const result = await service.create(viewer, siteId, floorId, { clientRequestId });

    expect(result).toMatchObject({ status: "pending", totalFixtures: 65 });
    expect(tx.fixture.findMany).toHaveBeenCalledWith({
      where: { floorId, siteId, meshNode: { isNot: null } },
      select: { id: true, meshNode: { select: { gatewayId: true } } },
      orderBy: { id: "asc" },
      take: 1001
    });
    expect(tx.monitoringRefreshBatch.create).toHaveBeenCalledTimes(2);
    expect(tx.monitoringRefreshBatch.create.mock.calls[0][0].data.targetFixtureIds).toHaveLength(64);
    expect(tx.monitoringRefreshBatch.create.mock.calls[1][0].data.targetFixtureIds).toHaveLength(1);
    expect(tx.monitoringRefreshRequest.create).toHaveBeenCalledWith({ data: {
      siteId, floorId, requestedById: viewer.id, clientRequestId, refreshId: refresh().id
    } });
  });

  it("returns the same request for an identical client id and rejects a different floor", async () => {
    const { service, tx } = harness();
    tx.monitoringRefresh.findUnique.mockResolvedValue(refresh());

    await expect(service.create(viewer, siteId, floorId, { clientRequestId }))
      .resolves.toMatchObject({ id: refresh().id });
    await expect(service.create(viewer, siteId, otherFloorId, { clientRequestId }))
      .rejects.toMatchObject({ response: { code: "monitoring_refresh_payload_conflict" } });
    expect(tx.monitoringRefresh.create).not.toHaveBeenCalled();
  });

  it("checks read capability before and again inside the transaction", async () => {
    const { service, access, tx } = harness();
    await service.create(viewer, siteId, floorId, { clientRequestId });
    expect(access.assert).toHaveBeenCalledWith(viewer, siteId, "read");
    expect(access.assertReadInTransaction).toHaveBeenCalledWith(tx, viewer, siteId);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it("recovers the winning idempotent request after a concurrent unique-key race", async () => {
    const { service, prisma } = harness();
    prisma.$transaction.mockRejectedValue(Object.assign(new Error("unique collision"), {
      code: "P2002",
      meta: { target: "MonitoringRefreshRequest_pkey" }
    }));
    prisma.monitoringRefreshRequest.findUnique.mockResolvedValue({ floorId, refresh: refresh() });

    await expect(service.create(viewer, siteId, floorId, { clientRequestId }))
      .resolves.toMatchObject({ id: refresh().id });
  });

  it("rejects a missing or inactive floor without selecting fixtures", async () => {
    const { service, tx } = harness();
    tx.floor.findFirst.mockResolvedValue(null);
    await expect(service.create(viewer, siteId, floorId, { clientRequestId }))
      .rejects.toMatchObject({ status: 404 });
    expect(tx.fixture.findMany).not.toHaveBeenCalled();
  });

  it("finishes an empty floor without creating batches, children, or outbox rows", async () => {
    const { service, tx } = harness();
    tx.fixture.findMany.mockResolvedValue([]);
    const result = await service.create(viewer, siteId, floorId, { clientRequestId });
    expect(result).toEqual({
      id: refresh().id,
      status: "completed",
      totalFixtures: 0,
      terminalStatusUrl: `/sites/${siteId}/monitoring-refreshes/${refresh().id}`
    });
    expect(tx.monitoringRefresh.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      status: "completed", totalFixtures: 0, completedAt: now
    }) });
    expect(tx.monitoringRefreshBatch.create).not.toHaveBeenCalled();
    expect(tx.monitoringRefreshFixture.createMany).not.toHaveBeenCalled();
    expect(tx.mqttOutbox.create).not.toHaveBeenCalled();
  });

  it("rejects 1,001 fixtures without creating a refresh", async () => {
    const { service, tx } = harness();
    tx.fixture.findMany.mockResolvedValue(fixtures(1001));
    await expect(service.create(viewer, siteId, floorId, { clientRequestId }))
      .rejects.toMatchObject({ response: { code: "monitoring_refresh_fixture_limit_exceeded" } });
    expect(tx.monitoringRefresh.create).not.toHaveBeenCalled();
  });

  it("reuses the active request for the selected site and floor", async () => {
    const { service, tx } = harness();
    tx.monitoringRefresh.findFirst.mockResolvedValue(refresh({ clientRequestId: randomUUID() }));
    await expect(service.create(viewer, siteId, floorId, { clientRequestId }))
      .resolves.toMatchObject({ id: refresh().id, status: "pending" });
    expect(tx.monitoringRefreshRequest.create).toHaveBeenCalledWith({ data: {
      siteId, floorId, requestedById: viewer.id, clientRequestId, refreshId: refresh().id
    } });
    expect(tx.fixture.findMany).not.toHaveBeenCalled();
  });

  it("durably aliases another requester to an active refresh and preserves retry/conflict after it terminates", async () => {
    const { service, tx } = harness();
    const reused = refresh({ requestedById: viewer.id, clientRequestId: randomUUID() });
    tx.monitoringRefresh.findFirst.mockResolvedValue(reused);

    await expect(service.create(secondViewer, siteId, floorId, { clientRequestId }))
      .resolves.toMatchObject({ id: reused.id, status: "pending" });
    expect(tx.monitoringRefreshRequest.create).toHaveBeenCalledWith({ data: {
      siteId, floorId, requestedById: secondViewer.id, clientRequestId, refreshId: reused.id
    } });

    const terminal = refresh({
      requestedById: viewer.id,
      clientRequestId: reused.clientRequestId,
      status: "completed",
      completedAt: new Date("2026-09-15T08:00:10.000Z")
    });
    tx.monitoringRefreshRequest.findUnique.mockResolvedValue({ floorId, refresh: terminal });
    tx.monitoringRefresh.findFirst.mockClear();

    await expect(service.create(secondViewer, siteId, floorId, { clientRequestId }))
      .resolves.toMatchObject({ id: reused.id, status: "completed" });
    await expect(service.create(secondViewer, siteId, otherFloorId, { clientRequestId }))
      .rejects.toMatchObject({ response: { code: "monitoring_refresh_payload_conflict" } });
    expect(tx.monitoringRefresh.findFirst).not.toHaveBeenCalled();
  });

  it("enforces a 30-second terminal cooldown for the same requester and floor", async () => {
    const { service, tx } = harness();
    tx.monitoringRefresh.findFirst.mockResolvedValue(null);
    tx.monitoringRefreshRequest.findFirst.mockResolvedValue({
      refresh: refresh({ status: "completed", completedAt: new Date("2026-09-15T07:59:45.000Z") })
    });
    await expect(service.create(viewer, siteId, floorId, { clientRequestId }))
      .rejects.toMatchObject({ response: {
        code: "monitoring_refresh_cooldown",
        retryAt: "2026-09-15T08:00:15.000Z"
      } });
    expect(tx.fixture.findMany).not.toHaveBeenCalled();
  });

  it("rejects a gateway sequence outside the JavaScript safe integer range atomically", async () => {
    const { service, tx } = harness();
    tx.gateway.update.mockResolvedValue({
      id: gatewayId,
      siteId,
      nextCommandSequence: BigInt(Number.MAX_SAFE_INTEGER) + 1n
    });
    await expect(service.create(viewer, siteId, floorId, { clientRequestId }))
      .rejects.toThrow("gateway command sequence exceeded safe integer range");
    expect(tx.monitoringRefreshBatch.create).not.toHaveBeenCalled();
  });

  it("returns sanitized create and read projections", async () => {
    const { service, tx } = harness();
    const created = await service.create(viewer, siteId, floorId, { clientRequestId });
    expect(created).toEqual({
      id: refresh().id,
      status: "pending",
      totalFixtures: 1,
      terminalStatusUrl: `/sites/${siteId}/monitoring-refreshes/${refresh().id}`
    });

    tx.monitoringRefresh.findFirst.mockResolvedValue(refresh({
      status: "partial",
      onlineFixtures: 1,
      unverifiedFixtures: 1,
      totalFixtures: 2,
      completedAt: new Date("2026-09-15T08:00:20.000Z"),
      internalSecret: "must-not-leak"
    }));
    await expect(service.get(viewer, siteId, refresh().id)).resolves.toEqual({
      id: refresh().id,
      status: "partial",
      totalFixtures: 2,
      onlineFixtures: 1,
      offlineFixtures: 0,
      unverifiedFixtures: 1,
      completedAt: "2026-09-15T08:00:20.000Z"
    });
  });

  it("requires read capability and site-scopes GET", async () => {
    const { service, access, tx } = harness();
    tx.monitoringRefresh.findFirst.mockResolvedValue(null);
    await expect(service.get(viewer, siteId, refresh().id)).rejects.toMatchObject({ status: 404 });
    expect(access.assert).toHaveBeenCalledWith(viewer, siteId, "read");
    expect(tx.monitoringRefresh.findFirst).toHaveBeenCalledWith({ where: { id: refresh().id, siteId } });
  });
});
