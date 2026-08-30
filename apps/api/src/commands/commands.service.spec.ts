import { BadRequestException, ConflictException } from "@nestjs/common";
import { createHash } from "node:crypto";
import { AuthenticatedUser } from "../auth/auth.types";
import { CommandDispatchService } from "./command-dispatch.service";
import { CommandsService } from "./commands.service";

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
  loginId: "operator_01", name: "Operator", role: "operator", status: "active"
};
const viewer: AuthenticatedUser = { ...operator, id: "viewer-1", role: "viewer" };

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
  now?: Date;
} = {}) {
  let now = options.now ?? new Date("2026-08-29T00:00:00.000Z");
  const command = {
    id: ids.command, siteId: ids.site, targetType: "fixture", targetId: ids.fixture1,
    targetFixtureIds: [ids.fixture1], brightness: 75, requestedBy: ids.user,
    createdAt: new Date("2026-07-01T00:00:00.000Z")
  };
  let storedCommand: Record<string, unknown> | null = null;
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
  it("defaults a timed override, persists its authoritative fixture snapshot, and includes it in the gateway payload", async () => {
    const { automationSnapshot, now, service, tx } = createHarness({
      fixtures: [fixture(ids.fixture1), fixture(ids.fixture2)]
    });

    await expect(service.createDimmingCommand(operator, {
      siteId: ids.site,
      clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      target: { type: "fixtures", fixtureIds: [ids.fixture2, ids.fixture1] },
      brightness: 75
    })).resolves.toMatchObject({ overrideUntil: "2026-08-29T01:00:00.000Z" });

    expect(automationSnapshot.lockMutation).toHaveBeenCalledWith(tx);
    expect(tx.manualOverride.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      siteId: ids.site,
      gatewayId: ids.gateway1,
      requestedById: ids.user,
      brightnessPercent: 75,
      startedAt: now,
      overrideUntil: new Date("2026-08-29T01:00:00.000Z"),
      fixtures: { createMany: { data: [
        { fixtureId: ids.fixture1, siteId: ids.site, gatewayId: ids.gateway1 },
        { fixtureId: ids.fixture2, siteId: ids.site, gatewayId: ids.gateway1 }
      ] } }
    }) });
    expect(tx.mqttOutbox.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      payload: expect.objectContaining({ overrideUntil: "2026-08-29T01:00:00.000Z" })
    }) });
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

  it.each([
    ["past", "2026-08-28T23:59:59.000Z"],
    ["at the current instant", "2026-08-29T00:00:00.000Z"],
    ["beyond thirty days", "2026-09-28T00:00:00.001Z"],
    ["not an ISO instant", "2026-08-29 01:00:00"]
  ])("rejects a %s overrideUntil", async (_label, overrideUntil) => {
    const { service, tx } = createHarness({ fixtures: [fixture(ids.fixture1)] });

    await expect(service.createDimmingCommand(operator, {
      siteId: ids.site,
      clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      target: { type: "fixture", fixtureId: ids.fixture1 },
      brightness: 75,
      overrideUntil
    })).rejects.toMatchObject({ status: 400 });
    expect(tx.command.create).not.toHaveBeenCalled();
  });

  it("reauthorizes manage access as the first step of the dimming write transaction", async () => {
    const { service, siteAccess, tx } = createHarness({ fixtures: [fixture(ids.fixture1)] });

    await service.createDimmingCommand(operator, {
      siteId: ids.site,
      clientRequestId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      target: { type: "fixture", fixtureId: ids.fixture1 },
      brightness: 75
    });

    expect(siteAccess.assertManageInTransaction).toHaveBeenCalledWith(tx, operator, ids.site);
    expect(siteAccess.assertManageInTransaction.mock.invocationCallOrder[0])
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

    expect(siteAccess.assert).toHaveBeenCalledWith(operator, ids.site, "manage");
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

  it("rejects incomplete site-scoped fixture sets and preserves viewer/offline checks", async () => {
    const incomplete = createHarness({ fixtures: [fixture(ids.fixture1)] });
    await expect(incomplete.service.createDimmingCommand(operator, {
      siteId: ids.site, target: { type: "fixtures", fixtureIds: [ids.fixture1, ids.fixture2] }, brightness: 40
    })).rejects.toThrow("control target not found in the user's site");
    expect(incomplete.tx.command.create).not.toHaveBeenCalled();

    const viewerHarness = createHarness({ fixtures: [fixture(ids.fixture1)] });
    await expect(viewerHarness.service.createDimmingCommand(viewer, {
      siteId: ids.site, target: { type: "fixture", fixtureId: ids.fixture1 }, brightness: 40
    })).rejects.toThrow("viewer users cannot control lights");
    expect(viewerHarness.prisma.$transaction).not.toHaveBeenCalled();

    const offlineHarness = createHarness({ fixtures: [{ ...fixture(ids.fixture1), status: "offline" }] });
    await expect(offlineHarness.service.createDimmingCommand(operator, {
      siteId: ids.site, target: { type: "fixture", fixtureId: ids.fixture1 }, brightness: 40
    })).rejects.toThrow("fixture is offline");
    expect(offlineHarness.tx.command.create).not.toHaveBeenCalled();
  });
});

function fingerprint(
  target:
    | { type: "fixture"; fixtureId: string }
    | { type: "fixtures"; fixtureIds: string[] }
    | { type: "floor"; floorId: string }
    | { type: "group"; groupId: string },
  brightness: number,
  overrideUntil?: string
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
    brightness,
    overrideUntil: overrideUntil ?? null
  })).digest("hex");
}
