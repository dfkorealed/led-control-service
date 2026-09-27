import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { AuthenticatedUser } from "../auth/auth.types";
import { CommandDispatchService } from "./command-dispatch.service";
import { CommandsService } from "./commands.service";
import { CommandTimeoutService } from "./command-timeout.service";
import { AutomationSnapshotService } from "../automation/automation-snapshot.service";
import { AutomationClock } from "../automation/automation-clock";

const ids = {
  command: "11111111-1111-4111-8111-111111111111",
  site: "22222222-2222-4222-8222-222222222222",
  fixture1: "33333333-3333-4333-8333-333333333331",
  fixture2: "33333333-3333-4333-8333-333333333332",
  fixture3: "33333333-3333-4333-8333-333333333333",
  floor: "44444444-4444-4444-8444-444444444444",
  group: "55555555-5555-4555-8555-555555555555",
  user: "66666666-6666-4666-8666-666666666666",
  gateway1: "77777777-7777-4777-8777-777777777771",
  gateway2: "77777777-7777-4777-8777-777777777772",
  dispatch: "88888888-8888-4888-8888-888888888888"
};

const operator: AuthenticatedUser = {
  id: ids.user, organizationId: "org-1", organizationType: "service_provider",
  loginId: "operator_01", name: "Operator", role: "operator", mustChangePassword: false, status: "active"
};
const admin: AuthenticatedUser = {
  ...operator,
  id: "admin-1",
  organizationId: "customer-org",
  organizationType: "customer",
  role: "admin"
};
const readUser: AuthenticatedUser = { ...admin, id: "read-user", role: "viewer" };
const controlUser: AuthenticatedUser = {
  ...admin,
  id: "99999999-9999-4999-8999-999999999997",
  role: "viewer"
};

function fixture(id: string, gatewayId = ids.gateway1, floorId = ids.floor) {
  return {
    id, floorId, name: `L-${id.at(-1)}`, status: "online",
    meshNode: { gatewayId, gateway: { lastHeartbeatAt: new Date() } }
  };
}

function createHarness(options: {
  fixtures?: ReturnType<typeof fixture>[];
  floor?: { id: string; fixtures: ReturnType<typeof fixture>[] } | null;
  group?: { id: string; groupFixtures: Array<{ fixtureId: string; fixture: ReturnType<typeof fixture> }> } | null;
  exactFloors?: Array<{ id: string; fixtures: Array<{ id: string }> }>;
  exactGroups?: Array<{ id: string; groupFixtures: Array<{ fixtureId: string }> }>;
  readyAddress?: string;
  readyError?: Error;
  concurrentCommand?: Record<string, unknown>;
  existingCommand?: Record<string, unknown>;
  now?: Date;
} = {}) {
  let now = options.now ?? new Date("2026-08-29T00:00:00.000Z");
  const command = {
    id: ids.command, siteId: ids.site, targetType: "fixture", targetId: ids.fixture1,
    targetFixtureIds: [ids.fixture1], brightness: 75, requestedBy: ids.user,
    createdAt: new Date("2026-07-01T00:00:00.000Z")
  };
  let storedCommand: Record<string, unknown> | null = options.existingCommand ?? null;
  const tx: any = {
    fixture: { findMany: jest.fn().mockResolvedValue(options.fixtures ?? []) },
    floor: {
      findFirst: jest.fn().mockResolvedValue(options.floor ?? null),
      findMany: jest.fn().mockResolvedValue(options.exactFloors ?? [])
    },
    fixtureGroup: {
      findFirst: jest.fn().mockResolvedValue(options.group ?? null),
      findMany: jest.fn().mockResolvedValue(options.exactGroups ?? [])
    },
    command: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockImplementation(() => Promise.resolve(storedCommand)),
      create: jest.fn().mockImplementation(({ data }) => {
        if (options.concurrentCommand) {
          storedCommand = options.concurrentCommand;
          return Promise.reject({
            code: "P2002",
            meta: { target: ["siteId", "requestedBy", "clientRequestId"] }
          });
        }
        storedCommand = { ...command, ...data, dispatches: [{ deliveryMode: "unicast" }] };
        return Promise.resolve(storedCommand);
      })
    },
    gateway: { update: jest.fn().mockImplementation(({ where }) => Promise.resolve({
      id: where.id, siteId: ids.site, nextCommandSequence: 1n
    })) },
    manualOverride: { create: jest.fn().mockImplementation(({ data }) => {
      const manualOverride = { id: "99999999-9999-4999-8999-999999999998", overrideUntil: data.overrideUntil };
      storedCommand = { ...storedCommand, manualOverride };
      return Promise.resolve(manualOverride);
    }) },
    commandDispatch: { create: jest.fn().mockResolvedValue({ id: ids.dispatch }) },
    commandFixtureResult: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    mqttOutbox: { create: jest.fn().mockResolvedValue({ id: "outbox-1" }) }
  };
  const prisma: any = { ...tx };
  prisma.$transaction = jest.fn(async (callback: (client: any) => Promise<unknown>) => callback(tx));
  const siteAccess = {
    assert: jest.fn().mockResolvedValue({ id: ids.site }),
    assertControlInTransaction: jest.fn().mockResolvedValue({ id: ids.site, organizationId: "org-1" }),
    assertManageInTransaction: jest.fn().mockResolvedValue({ id: ids.site, organizationId: "org-1" })
  };
  const meshControlGroups = {
    getReadyDestination: options.readyError
      ? jest.fn().mockRejectedValue(options.readyError)
      : jest.fn().mockResolvedValue({
        groupId: "99999999-9999-4999-8999-999999999999",
        groupAddress: options.readyAddress ?? "0xc000",
        configurationVersion: 3
      })
  };
  const automationSnapshot = { lockMutation: jest.fn().mockResolvedValue(undefined) };
  const service = new (CommandsService as any)(
    prisma, new CommandDispatchService(), siteAccess, meshControlGroups, automationSnapshot, { now: () => now }
  );
  return {
    automationSnapshot,
    meshControlGroups,
    now,
    prisma,
    service,
    setNow: (nextNow: Date) => { now = nextNow; },
    siteAccess,
    tx
  };
}

describe("CommandsService", () => {
  it("keeps a timeout outcome transition outside the protected overlap-check/create transaction", async () => {
    const { service, tx, prisma, automationSnapshot } = createHarness({ fixtures: [fixture(ids.fixture1)] });
    const realSnapshot = new AutomationSnapshotService(new AutomationClock());
    const overlapRead = deferred<void>();
    const allowCreate = deferred<void>();
    const controlCommitted = deferred<void>();
    const timeoutWaiting = deferred<"waiting">();
    const timeoutMutated = deferred<"mutated">();
    const events: string[] = [];
    let outcome = "pending";
    let controlOwnsLock = false;
    automationSnapshot.lockMutation.mockImplementation((client: any) => realSnapshot.lockMutation(client));
    tx.$executeRaw = jest.fn(async () => { controlOwnsLock = true; return 1; });
    tx.command.findMany.mockImplementation(async () => {
      const snapshot = outcome === "unknown" ? [{ id: "older", targetFixtureIds: [ids.fixture1] }] : [];
      overlapRead.resolve();
      await allowCreate.promise;
      return snapshot;
    });
    const create = tx.command.create.getMockImplementation()!;
    tx.command.create.mockImplementation(async (args: any) => {
      events.push(`dimming-created:${outcome}`);
      return create(args);
    });
    prisma.$transaction.mockImplementation(async (callback: (client: any) => Promise<unknown>) => {
      try { return await callback(tx); }
      finally { controlOwnsLock = false; controlCommitted.resolve(); }
    });
    const timeoutTx: any = {
      $executeRaw: jest.fn(async () => {
        if (controlOwnsLock) {
          timeoutWaiting.resolve("waiting");
          await controlCommitted.promise;
        }
        return 1;
      }),
      commandDispatch: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      commandFixtureResult: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
      command: { findUnique: jest.fn().mockResolvedValue({ siteId: ids.site, targetFixtureIds: [ids.fixture1] }),
        updateMany: jest.fn(async ({ data }: any) => {
        outcome = data.outcome;
        events.push(`timeout:${outcome}`);
        timeoutMutated.resolve("mutated");
        return { count: 1 };
      }) },
      fixture: { findMany: jest.fn().mockResolvedValue([{ floorId: ids.floor }]) },
      floor: { findMany: jest.fn().mockResolvedValue([{ id: ids.floor }]) },
      monitoringActivity: { createMany: jest.fn().mockResolvedValue({ count: 1 }) }
    };
    const timeoutPrisma: any = {
      commandDispatch: { findMany: jest.fn().mockResolvedValue([
        { id: "older-dispatch", commandId: "older", status: "published", kind: "dimming", command: { outcome: "pending" } }
      ]) },
      $transaction: jest.fn(async (callback) => callback(timeoutTx))
    };
    const timeoutService = new CommandTimeoutService(timeoutPrisma, realSnapshot);
    const creating = service.createDimmingCommand(operator, {
      siteId: ids.site, clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      target: { type: "fixture", fixtureId: ids.fixture1 }, brightness: 75
    });
    await overlapRead.promise;
    const timingOut = timeoutService.closeExpired();
    try {
      // With no shared lock the timeout mutates the original outcome while the overlap
      // query has already read its snapshot but the overlapping Set has not been written.
      await expect(Promise.race([timeoutWaiting.promise, timeoutMutated.promise])).resolves.toBe("waiting");
      expect(timeoutTx.commandDispatch.updateMany).not.toHaveBeenCalled();
      expect(outcome).toBe("pending");
    } finally {
      allowCreate.resolve();
      await Promise.allSettled([creating, timingOut]);
    }
    await expect(creating).resolves.toMatchObject({ id: ids.command });
    await expect(timingOut).resolves.toEqual({ timedOut: 1 });
    expect(events).toEqual(["dimming-created:pending", "timeout:unknown"]);
    expect(timeoutTx.monitoringActivity.createMany).toHaveBeenCalledTimes(1);
  });
  it("recovers the same dimming request before checking unknown overlaps and counts only dimming dispatches", async () => {
    const { service, tx } = createHarness({ fixtures: [fixture(ids.fixture1)] });
    const request = { siteId: ids.site, clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      target: { type: "fixture", fixtureId: ids.fixture1 }, brightness: 75 };
    await service.createDimmingCommand(operator, request);
    tx.command.findMany.mockClear();
    tx.command.findMany.mockResolvedValue([{ id: ids.command, targetFixtureIds: [ids.fixture1] }]);
    await expect(service.createDimmingCommand(operator, request)).resolves.toMatchObject({ id: ids.command, dispatchCount: 1 });
    expect(tx.command.findMany).not.toHaveBeenCalled();
    expect(tx.command.create).toHaveBeenCalledTimes(1);
    expect(tx.command.findUnique).toHaveBeenLastCalledWith(expect.objectContaining({
      include: expect.objectContaining({ dispatches: expect.objectContaining({ where: { kind: "dimming" } }) })
    }));
  });
  it("initializes newly created commands with a pending physical outcome", async () => {
    const { service, tx } = createHarness({ fixtures: [fixture(ids.fixture1)] });
    await service.createDimmingCommand(operator, {
      siteId: ids.site, clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      target: { type: "fixture", fixtureId: ids.fixture1 }, brightness: 75
    });
    expect(tx.command.create).toHaveBeenCalledWith({ data: expect.objectContaining({ outcome: "pending" }) });
  });

  it("blocks a new dimming command when any resolved target overlaps an unknown command", async () => {
    const { service, tx, automationSnapshot, siteAccess } = createHarness({ fixtures: [fixture(ids.fixture1), fixture(ids.fixture2)] });
    tx.command.findMany.mockResolvedValue([{ id: "uncertain", targetFixtureIds: [ids.fixture2, ids.fixture3] }]);
    await expect(service.createDimmingCommand(operator, {
      siteId: ids.site, clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      target: { type: "fixtures", fixtureIds: [ids.fixture1, ids.fixture2] }, brightness: 75
    })).rejects.toMatchObject({ status: 409, response: { code: "uncertain_command_requires_status_check" } });
    expect(tx.command.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { siteId: ids.site, outcome: "unknown" } }));
    expect(automationSnapshot.lockMutation.mock.invocationCallOrder[0]).toBeLessThan(tx.command.findMany.mock.invocationCallOrder[0]);
    expect(siteAccess.assertControlInTransaction.mock.invocationCallOrder[0]).toBeLessThan(tx.command.findMany.mock.invocationCallOrder[0]);
    expect(tx.command.create).not.toHaveBeenCalled();
    expect(tx.mqttOutbox.create).not.toHaveBeenCalled();
  });

  it("checks later bounded pages of unknown commands instead of overlooking older overlaps", async () => {
    const { service, tx } = createHarness({ fixtures: [fixture(ids.fixture1)] });
    tx.command.findMany
      .mockResolvedValueOnce(Array.from({ length: 100 }, (_, index) => ({ id: `unknown-${index}`, targetFixtureIds: [ids.fixture3] })))
      .mockResolvedValueOnce([{ id: "older", targetFixtureIds: [ids.fixture1] }]);
    await expect(service.createDimmingCommand(operator, {
      siteId: ids.site, clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      target: { type: "fixture", fixtureId: ids.fixture1 }, brightness: 75
    })).rejects.toMatchObject({ response: { code: "uncertain_command_requires_status_check" } });
    expect(tx.command.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({ take: 100, cursor: { id: "unknown-99" }, skip: 1 }));
  });

  it.each(["applied", "not_applied", null, "unknown"])("allows nonoverlapping unknown and existing %s outcomes", async (outcome) => {
    const { service, tx } = createHarness({ fixtures: [fixture(ids.fixture1)] });
    tx.command.findMany.mockImplementation(async ({ where }: any) => {
      const existing = { id: "prior", outcome, targetFixtureIds: outcome === "unknown" ? [ids.fixture2] : [ids.fixture1] };
      return existing.outcome === where.outcome ? [existing] : [];
    });
    await expect(service.createDimmingCommand(operator, {
      siteId: ids.site, clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      target: { type: "fixture", fixtureId: ids.fixture1 }, brightness: 75
    })).resolves.toMatchObject({ id: ids.command });
    expect(tx.command.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { siteId: ids.site, outcome: "unknown" } }));
  });

  it("persists a non-expiring manual audit row and omits legacy expiry from the gateway payload", async () => {
    const { automationSnapshot, now, service, tx } = createHarness({
      fixtures: [fixture(ids.fixture1), fixture(ids.fixture2)]
    });

    await expect(service.createDimmingCommand(operator, {
      siteId: ids.site,
      clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      target: { type: "fixtures", fixtureIds: [ids.fixture2, ids.fixture1] },
      brightness: 75
    })).resolves.not.toHaveProperty("overrideUntil");

    expect(automationSnapshot.lockMutation).toHaveBeenCalledWith(tx);
    expect(tx.manualOverride.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      siteId: ids.site,
      gatewayId: ids.gateway1,
      requestedById: ids.user,
      brightnessPercent: 75,
      startedAt: now,
      overrideUntil: null,
      fixtures: { createMany: { data: [
        { fixtureId: ids.fixture1 },
        { fixtureId: ids.fixture2 }
      ] } }
    }) });
    expect(tx.mqttOutbox.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      payload: expect.not.objectContaining({ overrideUntil: expect.anything() })
    }) });
    expect(tx.mqttOutbox.create.mock.calls[0][0].data.payload).not.toHaveProperty("requestedBy");
  });

  it("reuses an omitted overrideUntil request after the server clock advances", async () => {
    const { service, setNow, tx } = createHarness({ fixtures: [fixture(ids.fixture1)] });
    const input = {
      siteId: ids.site,
      clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      target: { type: "fixture" as const, fixtureId: ids.fixture1 },
      brightness: 75
    };

    const created = await service.createDimmingCommand(operator, input);
    setNow(new Date("2026-08-29T00:00:01.000Z"));

    await expect(service.createDimmingCommand(operator, input)).resolves.toEqual(created);
    expect(tx.command.create).toHaveBeenCalledTimes(1);
  });

  it("returns a legacy command without a ManualOverride for an exact idempotent retry", async () => {
    const clientRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const { service, tx } = createHarness({
      existingCommand: {
        id: ids.command,
        siteId: ids.site,
        requestedBy: ids.user,
        clientRequestId,
        requestFingerprint: fingerprint({ type: "fixture", fixtureId: ids.fixture1 }, 75),
        targetType: "fixture",
        targetId: ids.fixture1,
        targetFixtureIds: [ids.fixture1],
        brightness: 75,
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        dispatches: [{ deliveryMode: "unicast" }]
      }
    });

    await expect(service.createDimmingCommand(operator, {
      siteId: ids.site,
      clientRequestId,
      target: { type: "fixture", fixtureId: ids.fixture1 },
      brightness: 75
    })).resolves.toMatchObject({ id: ids.command, deliveryMode: "unicast" });
    await expect(service.createDimmingCommand(operator, {
      siteId: ids.site,
      clientRequestId,
      target: { type: "fixture", fixtureId: ids.fixture1 },
      brightness: 75
    })).resolves.not.toHaveProperty("overrideUntil");
    expect(tx.command.create).not.toHaveBeenCalled();
    expect(tx.manualOverride.create).not.toHaveBeenCalled();
  });

  it("recovers a timed legacy command from its stored expiry fingerprint", async () => {
    const clientRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const { service, tx } = createHarness({
      existingCommand: {
        id: ids.command,
        siteId: ids.site,
        requestedBy: ids.user,
        clientRequestId,
        requestFingerprint: "47716c542c31d9bb698a96658b1989e773b6419041585fdb22fe8b28291ff77f",
        targetType: "fixture",
        targetId: ids.fixture1,
        targetFixtureIds: [ids.fixture1],
        brightness: 75,
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        manualOverride: { overrideUntil: new Date("2026-08-29T01:00:00.000Z") },
        dispatches: [{ deliveryMode: "unicast" }]
      }
    });

    await expect(service.createDimmingCommand(operator, {
      siteId: ids.site,
      clientRequestId,
      target: { type: "fixture", fixtureId: ids.fixture1 },
      brightness: 75
    })).resolves.toMatchObject({ id: ids.command, deliveryMode: "unicast" });
    await expect(service.createDimmingCommand(operator, {
      siteId: ids.site,
      clientRequestId,
      target: { type: "fixture", fixtureId: ids.fixture1 },
      brightness: 75
    })).resolves.not.toHaveProperty("overrideUntil");
    expect(tx.command.create).not.toHaveBeenCalled();
  });

  it.each([
    {
      history: "omitted-expiry default",
      requestFingerprint: "ebb97ca49953e447f57bf56e48c9f3db04c18e351d9cd0b01e7d5192fffa3fc0",
      storedOverrideUntil: "2026-08-29T01:00:00.000Z"
    },
    {
      history: "noncanonical fractional precision",
      requestFingerprint: "2c3da047f757e65ab82b29951ea2ec8aec10647c74a9b97f0e52ab58ce275288",
      storedOverrideUntil: "2026-08-29T01:00:00.100Z"
    }
  ])("recovers a historical $history command from stored command semantics", async ({
    requestFingerprint,
    storedOverrideUntil
  }) => {
    const clientRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const { service, tx } = createHarness({
      existingCommand: {
        id: ids.command,
        siteId: ids.site,
        requestedBy: ids.user,
        clientRequestId,
        requestFingerprint,
        targetType: "fixture",
        targetId: ids.fixture1,
        targetFixtureIds: [ids.fixture1],
        brightness: 75,
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        manualOverride: { overrideUntil: new Date(storedOverrideUntil) },
        dispatches: [{ deliveryMode: "unicast" }]
      }
    });

    await expect(service.createDimmingCommand(operator, {
      siteId: ids.site,
      clientRequestId,
      target: { type: "fixture", fixtureId: ids.fixture1 },
      brightness: 75
    })).resolves.toMatchObject({ id: ids.command, deliveryMode: "unicast" });
    expect(tx.command.create).not.toHaveBeenCalled();
  });

  it.each([
    ["brightness", { target: { type: "fixture" as const, fixtureId: ids.fixture1 }, brightness: 74 }],
    ["target", { target: { type: "fixture" as const, fixtureId: ids.fixture2 }, brightness: 75 }]
  ])("rejects a historical request ID reused with different %s semantics", async (_difference, changed) => {
    const clientRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const { service } = createHarness({
      existingCommand: {
        id: ids.command,
        siteId: ids.site,
        requestedBy: ids.user,
        clientRequestId,
        requestFingerprint: "ebb97ca49953e447f57bf56e48c9f3db04c18e351d9cd0b01e7d5192fffa3fc0",
        targetType: "fixture",
        targetId: ids.fixture1,
        targetFixtureIds: [ids.fixture1],
        brightness: 75,
        createdAt: new Date("2026-07-01T00:00:00.000Z"),
        manualOverride: { overrideUntil: new Date("2026-08-29T01:00:00.000Z") },
        dispatches: [{ deliveryMode: "unicast" }]
      }
    });

    await expect(service.createDimmingCommand(operator, {
      siteId: ids.site,
      clientRequestId,
      ...changed
    })).rejects.toMatchObject({ response: { code: "client_request_id_payload_conflict" } });
  });

  it("normalizes different legacy overrideUntil values to the same idempotent command", async () => {
    const { service, tx } = createHarness({ fixtures: [fixture(ids.fixture1)] });
    const canonicalInput = {
      siteId: ids.site,
      clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      target: { type: "fixture" as const, fixtureId: ids.fixture1 },
      brightness: 75
    };

    const created = await service.createDimmingCommand(operator, {
      ...canonicalInput,
      overrideUntil: "2026-08-29T00:30:00.000Z"
    } as typeof canonicalInput);

    await expect(service.createDimmingCommand(operator, {
      ...canonicalInput,
      overrideUntil: "2026-08-29T00:45:00.000Z"
    } as typeof canonicalInput)).resolves.toEqual(created);
    expect(tx.command.create).toHaveBeenCalledTimes(1);
    expect(tx.manualOverride.create).toHaveBeenCalledTimes(1);
  });

  it("reauthorizes control access as the first step of the dimming write transaction", async () => {
    const { service, siteAccess, tx } = createHarness({ fixtures: [fixture(ids.fixture1)] });

    await service.createDimmingCommand(operator, {
      siteId: ids.site,
      clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      target: { type: "fixture", fixtureId: ids.fixture1 },
      brightness: 75
    });

    expect(siteAccess.assertControlInTransaction).toHaveBeenCalledWith(tx, operator, ids.site);
    expect(siteAccess.assertControlInTransaction.mock.invocationCallOrder[0])
      .toBeLessThan(tx.command.findUnique.mock.invocationCallOrder[0]);
  });

  it("returns the existing command for the same client request and canonical payload", async () => {
    const { service, tx } = createHarness({ fixtures: [fixture(ids.fixture1)] });
    const input = {
      siteId: ids.site,
      clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      target: { type: "fixture" as const, fixtureId: ids.fixture1 },
      brightness: 75
    };

    const first = await service.createDimmingCommand(operator, input);
    const second = await service.createDimmingCommand(operator, input);

    expect(second).toEqual(first);
    expect(first).not.toHaveProperty("dispatches");
    expect(tx.command.create).toHaveBeenCalledTimes(1);
    expect(tx.gateway.update).toHaveBeenCalledTimes(1);
    expect(tx.mqttOutbox.create).toHaveBeenCalledTimes(1);
  });

  it("returns 409 when a client request ID is reused with a different payload", async () => {
    const { service, tx } = createHarness({ fixtures: [fixture(ids.fixture1)] });
    const clientRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

    await service.createDimmingCommand(operator, {
      siteId: ids.site,
      clientRequestId,
      target: { type: "fixture", fixtureId: ids.fixture1 },
      brightness: 75
    });

    const rejection = service.createDimmingCommand(operator, {
      siteId: ids.site,
      clientRequestId,
      target: { type: "fixture", fixtureId: ids.fixture1 },
      brightness: 40
    });
    await expect(rejection).rejects.toBeInstanceOf(ConflictException);
    await expect(rejection).rejects.toMatchObject({
      response: { code: "client_request_id_payload_conflict" }
    });
    expect(tx.command.create).toHaveBeenCalledTimes(1);
    expect(tx.mqttOutbox.create).toHaveBeenCalledTimes(1);
  });

  it("recovers a concurrent command unique conflict in a fresh transaction", async () => {
    const clientRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const concurrentCommand = {
      id: ids.command,
      siteId: ids.site,
      requestedBy: ids.user,
      clientRequestId,
      requestFingerprint: fingerprint({ type: "fixtures", fixtureIds: [ids.fixture1, ids.fixture2] }, 30),
      targetType: "fixtures",
      targetId: null,
      targetFixtureIds: [ids.fixture1, ids.fixture2],
      brightness: 30,
      manualOverride: { overrideUntil: new Date("2026-08-29T01:00:00.000Z") },
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      dispatches: [{ deliveryMode: "parallel_unicast" }]
    };
    const { prisma, service, tx } = createHarness({
      fixtures: [fixture(ids.fixture2), fixture(ids.fixture1)],
      concurrentCommand
    });

    await expect(service.createDimmingCommand(operator, {
      siteId: ids.site,
      clientRequestId,
      target: { type: "fixtures", fixtureIds: [ids.fixture2, ids.fixture1] },
      brightness: 30
    })).resolves.toMatchObject({
      id: ids.command,
      selectedTargetCount: 2,
      transmissionCount: 2,
      deliveryMode: "parallel_unicast"
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(tx.gateway.update).not.toHaveBeenCalled();
    expect(tx.mqttOutbox.create).not.toHaveBeenCalled();
  });

  it("rejects an idempotent recovery when control access is downgraded to read", async () => {
    const clientRequestId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const concurrentCommand = {
      id: ids.command,
      siteId: ids.site,
      requestedBy: controlUser.id,
      clientRequestId,
      requestFingerprint: fingerprint({ type: "fixture", fixtureId: ids.fixture1 }, 30),
      targetType: "fixture",
      targetId: ids.fixture1,
      targetFixtureIds: [ids.fixture1],
      brightness: 30,
      manualOverride: { overrideUntil: new Date("2026-08-29T01:00:00.000Z") },
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      dispatches: [{ deliveryMode: "unicast" }]
    };
    const { prisma, service, siteAccess, tx } = createHarness({
      fixtures: [fixture(ids.fixture1)],
      concurrentCommand
    });
    siteAccess.assertControlInTransaction
      .mockResolvedValueOnce({ id: ids.site, organizationId: controlUser.organizationId })
      .mockRejectedValueOnce(new ForbiddenException("site capability denied"));

    await expect(service.createDimmingCommand(controlUser, {
      siteId: ids.site,
      clientRequestId,
      target: { type: "fixture", fixtureId: ids.fixture1 },
      brightness: 30
    })).rejects.toThrow("site capability denied");

    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    expect(siteAccess.assertControlInTransaction).toHaveBeenCalledTimes(2);
    expect(siteAccess.assertControlInTransaction).toHaveBeenLastCalledWith(tx, controlUser, ids.site);
    expect(tx.command.findUnique).toHaveBeenCalledTimes(1);
  });

  it("does not recover an unrelated unique constraint failure", async () => {
    const { service, tx } = createHarness({ fixtures: [fixture(ids.fixture1)] });
    tx.command.create.mockRejectedValueOnce({
      code: "P2002",
      meta: { target: ["gatewayId", "sequence"] }
    });

    await expect(service.createDimmingCommand(operator, {
      siteId: ids.site,
      clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      target: { type: "fixture", fixtureId: ids.fixture1 },
      brightness: 75
    })).rejects.toMatchObject({ code: "P2002" });
  });

  it("stores unicast delivery metadata and the authoritative fixture snapshot atomically", async () => {
    const { service, siteAccess, tx } = createHarness({ fixtures: [fixture(ids.fixture1)] });

    await expect(service.createDimmingCommand(operator, {
      siteId: ids.site, target: { type: "fixture", fixtureId: ids.fixture1 }, brightness: 75
    })).resolves.toMatchObject({
      id: ids.command, selectedTargetCount: 1, transmissionCount: 1,
      deliveryMode: "unicast", terminalStatusUrl: `/commands/${ids.command}`
    });

    expect(siteAccess.assert).toHaveBeenCalledWith(operator, ids.site, "control");
    expect(tx.command.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      targetType: "fixture", targetId: ids.fixture1, targetFixtureIds: [ids.fixture1]
    }) });
    expect(tx.commandDispatch.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      deliveryMode: "unicast", destinationAddress: null
    }) });
    expect(tx.mqttOutbox.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      payload: expect.objectContaining({ targetFixtureIds: [ids.fixture1], deliveryMode: "unicast" })
    }) });
  });

  it("uses parallel unicast for an arbitrary multi-fixture target", async () => {
    const { service, tx } = createHarness({ fixtures: [fixture(ids.fixture2), fixture(ids.fixture1)] });

    await expect(service.createDimmingCommand(operator, {
      siteId: ids.site, target: { type: "fixtures", fixtureIds: [ids.fixture2, ids.fixture1] }, brightness: 50
    })).resolves.toMatchObject({ selectedTargetCount: 2, transmissionCount: 2, deliveryMode: "parallel_unicast" });
    expect(tx.command.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      targetId: null, targetFixtureIds: [ids.fixture1, ids.fixture2]
    }) });
  });

  it("uses one ready mesh group transmission for an authoritative floor target", async () => {
    const targets = [fixture(ids.fixture1), fixture(ids.fixture2)];
    const { meshControlGroups, service, tx } = createHarness({
      floor: { id: ids.floor, fixtures: targets }, readyAddress: "0xc010"
    });

    await expect(service.createDimmingCommand(operator, {
      siteId: ids.site, target: { type: "floor", floorId: ids.floor }, brightness: 60
    })).resolves.toMatchObject({ selectedTargetCount: 2, transmissionCount: 1, deliveryMode: "mesh_group" });
    expect(meshControlGroups.getReadyDestination).toHaveBeenCalledWith(tx, {
      type: "floor", floorId: ids.floor, gatewayId: ids.gateway1
    });
    expect(tx.commandDispatch.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      deliveryMode: "mesh_group",
      destinationAddress: "0xc010",
      meshControlGroupId: "99999999-9999-4999-8999-999999999999",
      meshControlGroupVersion: 3
    }) });
    expect(tx.mqttOutbox.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      payload: expect.objectContaining({
        meshControlGroupId: "99999999-9999-4999-8999-999999999999",
        meshControlGroupVersion: 3
      })
    }) });
  });

  it("rejects an unready requested group without fallback or DB writes", async () => {
    const target = fixture(ids.fixture1);
    const { service, tx } = createHarness({
      group: { id: ids.group, groupFixtures: [{ fixtureId: target.id, fixture: target }] },
      readyError: new BadRequestException("mesh control group is not ready")
    });

    await expect(service.createDimmingCommand(operator, {
      siteId: ids.site, target: { type: "group", groupId: ids.group }, brightness: 60
    })).rejects.toThrow("mesh control group is not ready");
    expect(tx.command.create).not.toHaveBeenCalled();
  });

  it("does not resolve an invalid legacy fixture group as a command target", async () => {
    const target = fixture(ids.fixture1);
    const { service, tx } = createHarness({
      group: { id: ids.group, groupFixtures: [{ fixtureId: target.id, fixture: target }] }
    });

    await service.createDimmingCommand(operator, {
      siteId: ids.site, target: { type: "group", groupId: ids.group }, brightness: 60
    });

    expect(tx.fixtureGroup.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ lifecycleStatus: "active" })
    }));
  });

  it("rejects a logical target spanning multiple gateways before any command write", async () => {
    const targets = [fixture(ids.fixture1, ids.gateway1), fixture(ids.fixture2, ids.gateway2)];
    const { service, tx } = createHarness({ floor: { id: ids.floor, fixtures: targets } });

    await expect(service.createDimmingCommand(operator, {
      siteId: ids.site, target: { type: "floor", floorId: ids.floor }, brightness: 60
    })).rejects.toThrow("현재 여러 게이트웨이에 걸친 대상은 지원하지 않습니다");
    expect(tx.command.create).not.toHaveBeenCalled();
  });

  it("promotes an exact selection to the sorted ready floor before fixture groups", async () => {
    const targets = [fixture(ids.fixture1), fixture(ids.fixture2)];
    const floorA = "44444444-4444-4444-8444-444444444441";
    const floorB = "44444444-4444-4444-8444-444444444442";
    const { meshControlGroups, service, tx } = createHarness({
      fixtures: targets,
      exactFloors: [
        { id: floorB, fixtures: [{ id: ids.fixture1 }, { id: ids.fixture2 }] },
        { id: floorA, fixtures: [{ id: ids.fixture1 }, { id: ids.fixture2 }] }
      ],
      exactGroups: [{ id: ids.group, groupFixtures: [{ fixtureId: ids.fixture1 }, { fixtureId: ids.fixture2 }] }]
    });

    await expect(service.createDimmingCommand(operator, {
      siteId: ids.site, target: { type: "fixtures", fixtureIds: [ids.fixture2, ids.fixture1] }, brightness: 40
    })).resolves.toMatchObject({ deliveryMode: "mesh_group", transmissionCount: 1 });
    expect(meshControlGroups.getReadyDestination).toHaveBeenCalledTimes(1);
    expect(meshControlGroups.getReadyDestination).toHaveBeenCalledWith(tx, {
      type: "floor", floorId: floorA, gatewayId: ids.gateway1
    });
  });

  it("chooses the lowest sorted ready fixture group when no floor exactly matches", async () => {
    const targets = [fixture(ids.fixture1), fixture(ids.fixture2)];
    const groupA = "55555555-5555-4555-8555-555555555551";
    const groupB = "55555555-5555-4555-8555-555555555552";
    const { meshControlGroups, service, tx } = createHarness({
      fixtures: targets,
      exactGroups: [
        { id: groupB, groupFixtures: [{ fixtureId: ids.fixture1 }, { fixtureId: ids.fixture2 }] },
        { id: groupA, groupFixtures: [{ fixtureId: ids.fixture1 }, { fixtureId: ids.fixture2 }] }
      ]
    });

    await expect(service.createDimmingCommand(operator, {
      siteId: ids.site, target: { type: "fixtures", fixtureIds: [ids.fixture1, ids.fixture2] }, brightness: 40
    })).resolves.toMatchObject({ deliveryMode: "mesh_group" });
    expect(meshControlGroups.getReadyDestination).toHaveBeenCalledWith(tx, {
      type: "fixture_group", fixtureGroupId: groupA, gatewayId: ids.gateway1
    });
  });

  it("does not promote partial or excess exact-match candidates", async () => {
    const targets = [fixture(ids.fixture1), fixture(ids.fixture2)];
    const { meshControlGroups, service } = createHarness({
      fixtures: targets,
      exactFloors: [{ id: ids.floor, fixtures: [{ id: ids.fixture1 }, { id: ids.fixture2 }, { id: ids.fixture3 }] }],
      exactGroups: [{ id: ids.group, groupFixtures: [{ fixtureId: ids.fixture1 }] }]
    });

    await expect(service.createDimmingCommand(operator, {
      siteId: ids.site, target: { type: "fixtures", fixtureIds: [ids.fixture1, ids.fixture2] }, brightness: 40
    })).resolves.toMatchObject({ deliveryMode: "parallel_unicast", transmissionCount: 2 });
    expect(meshControlGroups.getReadyDestination).not.toHaveBeenCalled();
  });

  it("rejects incomplete site-scoped fixture sets and preserves read/offline checks", async () => {
    const incomplete = createHarness({ fixtures: [fixture(ids.fixture1)] });
    await expect(incomplete.service.createDimmingCommand(operator, {
      siteId: ids.site, target: { type: "fixtures", fixtureIds: [ids.fixture1, ids.fixture2] }, brightness: 40
    })).rejects.toThrow("control target not found in the user's site");
    expect(incomplete.tx.command.create).not.toHaveBeenCalled();

    const readHarness = createHarness({ fixtures: [fixture(ids.fixture1)] });
    readHarness.siteAccess.assert.mockImplementation((_actor: AuthenticatedUser, _siteId: string, capability: string) => {
      if (capability === "control") throw new ForbiddenException("site capability denied");
      return Promise.resolve({ id: ids.site });
    });
    await expect(readHarness.service.createDimmingCommand(readUser, {
      siteId: ids.site, target: { type: "fixture", fixtureId: ids.fixture1 }, brightness: 40
    })).rejects.toThrow("site capability denied");
    expect(readHarness.siteAccess.assert).toHaveBeenCalledWith(readUser, ids.site, "control");
    expect(readHarness.prisma.$transaction).not.toHaveBeenCalled();

    const offlineHarness = createHarness({ fixtures: [{ ...fixture(ids.fixture1), status: "offline" }] });
    await expect(offlineHarness.service.createDimmingCommand(operator, {
      siteId: ids.site, target: { type: "fixture", fixtureId: ids.fixture1 }, brightness: 40
    })).rejects.toThrow("fixture is offline");
    expect(offlineHarness.tx.command.create).not.toHaveBeenCalled();
  });

  it("allows a control member to create a manual command after transaction reauthorization", async () => {
    const { service, siteAccess, tx } = createHarness({ fixtures: [fixture(ids.fixture1)] });

    await expect(service.createDimmingCommand(controlUser, {
      siteId: ids.site,
      clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      target: { type: "fixture", fixtureId: ids.fixture1 },
      brightness: 55
    })).resolves.toMatchObject({ id: ids.command, brightness: 55 });

    expect(siteAccess.assert).toHaveBeenCalledWith(controlUser, ids.site, "control");
    expect(siteAccess.assertControlInTransaction).toHaveBeenCalledWith(tx, controlUser, ids.site);
    expect(siteAccess.assertManageInTransaction).not.toHaveBeenCalled();
  });
});

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((callback) => { resolve = callback; });
  return { promise, resolve };
}

function fingerprint(
  target:
    | { type: "fixture"; fixtureId: string }
    | { type: "fixtures"; fixtureIds: string[] }
    | { type: "floor"; floorId: string }
    | { type: "group"; groupId: string },
  brightness: number
) {
  const canonicalTarget = target.type === "fixture"
    ? [target.type, target.fixtureId]
    : target.type === "fixtures"
      ? [target.type, ...target.fixtureIds.slice().sort()]
      : target.type === "floor"
        ? [target.type, target.floorId]
        : [target.type, target.groupId];
  return createHash("sha256").update(JSON.stringify({
    target: canonicalTarget,
    brightness
  })).digest("hex");
}

describe("GET-only history cutoff on Set idempotency", () => {
  it.each([
    ["2026-02-28T11:59:59.999Z", 409],
    ["2026-02-28T12:00:00.000Z", 200]
  ])("applies the DB cutoff to an existing request created at %s", async (createdAt, status) => {
    process.env.COMMAND_HISTORY_RETENTION_ENABLED = "1";
    try {
      const request = { siteId: ids.site, clientRequestId: "11111111-1111-4111-8111-111111111111",
        target: { type: "fixture" as const, fixtureId: ids.fixture1 }, brightness: 40 };
      const existing = { id: ids.command, siteId: ids.site, requestedBy: operator.id,
        clientRequestId: request.clientRequestId, targetType: "fixture", targetId: ids.fixture1,
        targetFixtureIds: [ids.fixture1], brightness: 40, createdAt: new Date(createdAt),
        dispatches: [{ deliveryMode: "unicast" }], manualOverride: { overrideUntil: null } };
      const { service, tx } = createHarness({ existingCommand: existing, fixtures: [fixture(ids.fixture1)] });
      tx.$queryRaw.mockImplementation(async (query: any) => query.strings.join(" ").includes("transaction_timestamp()")
        ? [{ generatedAt: new Date("2026-05-31T12:00:00.000Z"), retainedFrom: new Date("2026-02-28T12:00:00.000Z") }] : []);
      if (status === 409) await expect(service.createDimmingCommand(operator, request))
        .rejects.toMatchObject({ status: 409, response: { code: "command_request_expired" } });
      else await expect(service.createDimmingCommand(operator, request)).resolves.toMatchObject({ id: ids.command });
      expect(tx.command.create).not.toHaveBeenCalled();
      expect(tx.mqttOutbox.create).not.toHaveBeenCalled();
    } finally {
      delete process.env.COMMAND_HISTORY_RETENTION_ENABLED;
    }
  });
});

describe("HISTORY-only Set HTTP and safety overlap", () => {
  const oldId = "11111111-1111-4111-8111-111111111111";
  const cutoff = new Date("2026-02-28T12:00:00.000Z");

  afterEach(() => { delete process.env.COMMAND_HISTORY_RETENTION_ENABLED; });

  it.each([
    ["expired", "2026-02-28T11:59:59.999Z", 409],
    ["recent", "2026-02-28T12:00:00.000Z", 201]
  ])("returns the %s retry contract over HTTP with only HISTORY enabled", async (_kind, createdAt, expectedStatus) => {
    process.env.COMMAND_HISTORY_RETENTION_ENABLED = "1";
    const request = { siteId: ids.site, clientRequestId: oldId,
      target: { type: "fixture" as const, fixtureId: ids.fixture1 }, brightness: 40 };
    const existing = { id: ids.command, siteId: ids.site, requestedBy: operator.id,
      clientRequestId: request.clientRequestId, targetType: "fixture", targetId: ids.fixture1,
      targetFixtureIds: [ids.fixture1], brightness: 40, createdAt: new Date(createdAt),
      dispatches: [{ deliveryMode: "unicast" }], manualOverride: { overrideUntil: null } };
    const { service, tx } = createHarness({ existingCommand: existing, fixtures: [fixture(ids.fixture1)] });
    tx.$queryRaw.mockImplementation(async (query: any) => query.strings.join(" ").includes("transaction_timestamp()")
      ? [{ generatedAt: new Date("2026-05-31T12:00:00.000Z"), retainedFrom: cutoff }] : []);
    const { Test } = await import("@nestjs/testing");
    const { AuthService } = await import("../auth/auth.service");
    const { CommandsController } = await import("./commands.controller");
    const { CommandStatusService } = await import("./command-status.service");
    const { CommandVerificationService } = await import("./command-verification.service");
    const { CommandRecoveryService } = await import("./command-recovery.service");
    const module = await Test.createTestingModule({ controllers: [CommandsController], providers: [
      { provide: AuthService, useValue: { getUserBySessionToken: async () => operator } },
      { provide: CommandsService, useValue: service },
      { provide: CommandStatusService, useValue: {} },
      { provide: CommandVerificationService, useValue: {} },
      { provide: CommandRecoveryService, useValue: {} }
    ] }).compile();
    const app = module.createNestApplication();
    await app.listen(0, "127.0.0.1");
    const baseUrl = await app.getUrl();
    try {
      const send = () => fetch(`${baseUrl}/commands/dimming`, { method: "POST", headers: {
        Cookie: "led_session=test", "Content-Type": "application/json"
      }, body: JSON.stringify(request) });
      const first = await send();
      const body = await first.json();
      expect(first.status).toBe(expectedStatus);
      if (expectedStatus === 409) expect(body).toEqual({ code: "command_request_expired" });
      else {
        expect(body).toMatchObject({ id: ids.command, brightness: 40, deliveryMode: "unicast" });
        const repeated = await send();
        expect(repeated.status).toBe(201);
        expect(await repeated.json()).toEqual(body);
      }
      expect(tx.command.create).not.toHaveBeenCalled();
      expect(tx.mqttOutbox.create).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("still blocks a fresh overlapping Set on an old unresolved command", async () => {
    process.env.COMMAND_HISTORY_RETENTION_ENABLED = "1";
    const { service, tx } = createHarness({ fixtures: [fixture(ids.fixture1)] });
    tx.command.findMany.mockResolvedValueOnce([{ id: "old-unknown", siteId: ids.site,
      createdAt: new Date("2026-01-01T00:00:00.000Z"), outcome: "unknown", targetFixtureIds: [ids.fixture1] }]);
    await expect(service.createDimmingCommand(operator, { siteId: ids.site,
      clientRequestId: "99999999-9999-4999-8999-999999999996",
      target: { type: "fixture", fixtureId: ids.fixture1 }, brightness: 50 }))
      .rejects.toMatchObject({ status: 409, response: { code: "uncertain_command_requires_status_check" } });
    expect(tx.command.create).not.toHaveBeenCalled();
    expect(tx.gateway.update).not.toHaveBeenCalled();
    expect(tx.mqttOutbox.create).not.toHaveBeenCalled();
  });
});
