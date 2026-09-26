import { BadRequestException, NotFoundException } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { CommandStatusService } from "./command-status.service";

describe("CommandStatusService", () => {
  const user: AuthenticatedUser = {
    id: "user-1", organizationId: "org-1", organizationType: "customer", loginId: "fixture_user", name: "Admin", role: "admin", mustChangePassword: false, status: "active"
  };

  it("returns gateway dispatches and fixture results within the user's organization", async () => {
    const prisma: any = {
      command: {
        findUnique: jest.fn().mockResolvedValue({
          id: "command-1",
          siteId: "site-1",
          targetType: "group",
          targetId: null,
          targetFixtureIds: ["fixture-1"],
          brightness: 70,
          status: "pending",
          errorMessage: null,
          createdAt: new Date("2026-07-12T00:00:00.000Z"),
          updatedAt: new Date("2026-07-12T00:00:02.000Z"),
          dispatches: [
            {
              id: "dispatch-1",
              deliveryMode: "mesh_group",
              destinationAddress: "0xc000",
              meshControlGroupId: "mesh-group-1",
              meshControlGroupVersion: 3,
              status: "completed",
              publishedAt: new Date("2026-07-12T00:00:01.000Z"),
              acceptedAt: new Date("2026-07-12T00:00:01.500Z"),
              completedAt: new Date("2026-07-12T00:00:02.000Z"),
              errorCode: null,
              errorMessage: null,
              gateway: { id: "gateway-1", name: "B2 Gateway" },
              fixtureResults: [
                {
                  fixtureId: "fixture-1",
                  status: "succeeded",
                  brightness: 70,
                  faultCode: null,
                  errorMessage: null,
                  occurredAt: new Date("2026-07-12T00:00:02.000Z"),
                  fixture: { name: "B2-L01" }
                }
              ]
            }
          ]
        })
      }
    };
    const siteAccess = { assert: jest.fn().mockResolvedValue({ id: "site-1" }) };
    const service = new (CommandStatusService as any)(prisma, siteAccess);

    await expect(service.getCommand(user, "command-1")).resolves.toMatchObject({
      id: "command-1",
      stage: "completed",
      dispatchCount: 1,
      completedFixtureCount: 1,
      totalFixtureCount: 1,
      targetId: null,
      targetFixtureIds: ["fixture-1"],
      dispatches: [
        {
          deliveryMode: "mesh_group",
          destinationAddress: "0xc000",
          meshControlGroupId: "mesh-group-1",
          meshControlGroupVersion: 3,
          gateway: { id: "gateway-1", name: "B2 Gateway" },
          results: [{ fixtureId: "fixture-1", fixtureName: "B2-L01", status: "succeeded" }]
        }
      ]
    });
    expect(siteAccess.assert).toHaveBeenCalledWith(user, "site-1", "read");
  });

  it.each([
    ["unknown", 0, "verification_required"], ["unknown", 1, "verification_required"],
    ["applied", 0, "completed"], ["not_applied", 0, "failed"], ["partially_applied", 0, "partial_failed"],
    ["applied", 2, "verified_applied"], ["not_applied", 2, "verified_not_applied"], ["partially_applied", 2, "verified_partial"]
  ])("returns reopenable outcome %s and verification attempt %s as %s", async (outcome, attempt, stage) => {
    const command = historyCommand("command-1", outcome, attempt);
    const prisma = { command: { findUnique: jest.fn().mockResolvedValue(command) } };
    const service = new (CommandStatusService as any)(prisma, { assert: jest.fn() });
    const detail = await service.getCommand(user, command.id);
    expect(detail).toMatchObject({ outcome, stage, verificationAttemptCount: attempt, totalFixtureCount: 1,
      dispatches: [expect.objectContaining({ kind: "dimming", verificationAttempt: null }),
        ...(attempt ? [expect.objectContaining({ kind: "status_check", verificationAttempt: attempt }), expect.objectContaining({ verificationAttempt: attempt })] : [])] });
  });

  it("exposes only an exact terminal clock refusal in command history and detail", async () => {
    const clock = historyCommand("command-clock", "not_applied");
    clock.dispatches[0].status = "failed";
    clock.dispatches[0].errorCode = "GATEWAY_CLOCK_UNTRUSTED";
    clock.dispatches[0].fixtureResults[0].status = "failed";
    const uncertain = historyCommand("command-unknown", "unknown");
    uncertain.dispatches[0].errorCode = "GATEWAY_CLOCK_UNTRUSTED";
    const partial = historyCommand("command-partial", "partially_applied");
    partial.dispatches[0].errorCode = "GATEWAY_CLOCK_UNTRUSTED";
    partial.dispatches[0].fixtureResults[0].status = "succeeded";
    const expired = historyCommand("command-expired", "not_applied");
    expired.dispatches[0].status = "failed";
    expired.dispatches[0].errorCode = "COMMAND_EXPIRED";
    expired.dispatches[0].fixtureResults[0].status = "failed";
    const prisma = { command: { findMany: jest.fn().mockResolvedValue([clock, uncertain, partial, expired]),
      findUnique: jest.fn().mockResolvedValue(clock) } };
    const service = new (CommandStatusService as any)(prisma, { assert: jest.fn() });
    const list = await service.listCommands(user, { siteId: "site-1" });
    expect(list.items.map((item: any) => item.errorCode)).toEqual([
      "GATEWAY_CLOCK_UNTRUSTED", undefined, undefined, undefined
    ]);
    await expect(service.getCommand(user, clock.id)).resolves.toMatchObject({
      errorCode: "GATEWAY_CLOCK_UNTRUSTED", stage: "failed",
      dispatches: [expect.objectContaining({ errorCode: "GATEWAY_CLOCK_UNTRUSTED" })]
    });
    clock.dispatches[0].fixtureResults[0].fixtureId = "outside-target";
    const wrongTarget = await service.listCommands(user, { siteId: "site-1" });
    expect(wrongTarget.items[0].errorCode).toBeUndefined();
  });

  it("lists summaries with stable descending timestamp/id pagination and an exclusive cursor", async () => {
    const rows = [historyCommand("cccccccc-cccc-4ccc-8ccc-cccccccccccc"), historyCommand("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")];
    const prisma = { command: { findMany: jest.fn().mockResolvedValue(rows) } };
    const access = { assert: jest.fn() };
    const service = new (CommandStatusService as any)(prisma, access);
    expect(typeof service.listCommands).toBe("function");
    const first = await service.listCommands(user, { siteId: "site-1", limit: 1 });
    expect(first.items.map((item: any) => item.id)).toEqual([rows[0].id]);
    expect(first.items[0].dispatches).toBeUndefined();
    expect(first.nextCursor).toEqual(expect.any(String));
    prisma.command.findMany.mockResolvedValue([rows[1]]);
    const second = await service.listCommands(user, { siteId: "site-1", limit: 1, cursor: first.nextCursor });
    expect(second.nextCursor).toBeNull();
    expect(prisma.command.findMany.mock.calls[1][0]).toMatchObject({
      where: { siteId: "site-1", AND: expect.arrayContaining([{ OR: [
        { createdAt: { lt: rows[0].createdAt } }, { createdAt: rows[0].createdAt, id: { lt: rows[0].id } }
      ] }]) }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], take: 2
    });
    expect(access.assert).toHaveBeenCalledWith(user, "site-1", "read");
  });

  it("keeps both ID and fixture search branches inside the requested site and stage", async () => {
    const prisma = { command: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new (CommandStatusService as any)(prisma, { assert: jest.fn() });
    expect(typeof service.listCommands).toBe("function");
    await service.listCommands(user, { siteId: "site-1", query: "Lobby", stage: "verification_required" });
    expect(prisma.command.findMany.mock.calls[0][0]).toMatchObject({ where: { siteId: "site-1", AND: expect.arrayContaining([
      { OR: [{ id: { startsWith: "Lobby", mode: "insensitive" } },
        { dispatches: { some: { fixtureResults: { some: { fixture: { name: { contains: "Lobby", mode: "insensitive" } } } } } } }] },
      { outcome: "unknown" }
    ]) } });
  });

  it.each([
    ["verified_applied", "applied"], ["verified_not_applied", "not_applied"], ["verified_partial", "partially_applied"]
  ])("filters %s by outcome and a real verification attempt", async (stage, outcome) => {
    const prisma = { command: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new (CommandStatusService as any)(prisma, { assert: jest.fn() });
    await service.listCommands(user, { siteId: "site-1", stage });
    expect(prisma.command.findMany.mock.calls[0][0]).toMatchObject({ where: { siteId: "site-1", AND: [{ AND: [
      { outcome }, { dispatches: { some: { kind: "status_check", verificationAttempt: { gt: 0 } } } }
    ] }] } });
  });

  it.each([["completed", "applied"], ["failed", "not_applied"], ["partial_failed", "partially_applied"]])(
    "keeps unverified %s outcomes and legacy stage predicates available", async (stage, outcome) => {
      const prisma = { command: { findMany: jest.fn().mockResolvedValue([]) } };
      const service = new (CommandStatusService as any)(prisma, { assert: jest.fn() });
      await service.listCommands(user, { siteId: "site-1", stage });
      const filter = prisma.command.findMany.mock.calls[0][0].where.AND[0];
      expect(filter.OR[0]).toEqual({ AND: [{ outcome }, { NOT: { dispatches: { some: { kind: "status_check", verificationAttempt: { gt: 0 } } } } }] });
      expect(filter.OR[1].AND).toContainEqual({ OR: [{ outcome: null }, { outcome: "pending" }] });
    }
  );

  it("never queries command history before the site read grant succeeds", async () => {
    const prisma = { command: { findMany: jest.fn() } };
    const service = new (CommandStatusService as any)(prisma, { assert: jest.fn().mockRejectedValue(new NotFoundException()) });
    expect(typeof service.listCommands).toBe("function");
    await expect(service.listCommands(user, { siteId: "other-site" })).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.command.findMany).not.toHaveBeenCalled();
  });

  it.each(["bad", Buffer.from(JSON.stringify({ id: "abc", createdAt: "not-a-date" })).toString("base64url")])("rejects invalid cursor %s", async (cursor) => {
    const service = new (CommandStatusService as any)({}, { assert: jest.fn() });
    expect(typeof service.listCommands).toBe("function");
    await expect(service.listCommands(user, { siteId: "site-1", cursor })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("does not reveal a command outside the user's organization", async () => {
    const prisma: any = { command: { findUnique: jest.fn().mockResolvedValue(null) } };
    const service = new (CommandStatusService as any)(prisma, { assert: jest.fn() });

    await expect(service.getCommand(user, "command-other")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("reports partial failure when terminal fixture results are mixed", async () => {
    const prisma: any = {
      command: {
        findUnique: jest.fn().mockResolvedValue({
          id: "command-1",
          siteId: "site-1",
          targetType: "group",
          targetId: "group-1",
          brightness: 70,
          status: "failed",
          errorMessage: "one or more gateway dispatches failed",
          createdAt: new Date(),
          updatedAt: new Date(),
          dispatches: [
            {
              id: "dispatch-1",
              status: "failed",
              publishedAt: new Date(),
              acceptedAt: new Date(),
              completedAt: new Date(),
              errorCode: null,
              errorMessage: null,
              gateway: { id: "gateway-1", name: "Gateway" },
              fixtureResults: [
                { fixtureId: "f1", status: "succeeded", fixture: { name: "L1" } },
                { fixtureId: "f2", status: "failed", fixture: { name: "L2" } }
              ]
            }
          ]
        })
      }
    };

    const siteAccess = { assert: jest.fn().mockResolvedValue({ id: "site-1" }) };
    await expect(new (CommandStatusService as any)(prisma, siteAccess).getCommand(user, "command-1")).resolves.toMatchObject({
      stage: "partial_failed",
      completedFixtureCount: 2,
      totalFixtureCount: 2
    });
  });

  it("does not reveal a command at an inaccessible site", async () => {
    const prisma: any = {
      command: {
        findFirst: jest.fn().mockResolvedValue(null),
        findUnique: jest.fn().mockResolvedValue({ siteId: "other-site" })
      }
    };
    const service = new (CommandStatusService as any)(prisma, {
      assert: jest.fn().mockRejectedValue(new NotFoundException("site not found"))
    });

    await expect(service.getCommand(user, "command-other")).rejects.toThrow("command not found");
  });

  it("returns the same public 404 response for absent and inaccessible commands", async () => {
    const absentService = new (CommandStatusService as any)(
      { command: { findUnique: jest.fn().mockResolvedValue(null) } },
      { assert: jest.fn() }
    );
    const inaccessibleService = new (CommandStatusService as any)(
      { command: { findUnique: jest.fn().mockResolvedValue({ siteId: "other-site" }) } },
      { assert: jest.fn().mockRejectedValue(new NotFoundException("site not found")) }
    );

    const absent = await absentService.getCommand(user, "missing-command").catch((error: unknown) => error);
    const inaccessible = await inaccessibleService.getCommand(user, "other-command").catch((error: unknown) => error);

    expect(absent).toBeInstanceOf(NotFoundException);
    expect(inaccessible).toBeInstanceOf(NotFoundException);
    expect(inaccessible.getResponse()).toEqual(absent.getResponse());
  });
});

function historyCommand(id: string, outcome = "unknown", attempt = 0) {
  const dispatch = { id: "dispatch-1", kind: "dimming", verificationAttempt: null, status: "timed_out", errorCode: "STATUS_TIMEOUT",
    gateway: { id: "gateway-1", name: "Gateway" }, fixtureResults: [{ fixtureId: "fixture-1", fixture: { name: "Lobby" }, status: "timed_out" }] };
  return { id, siteId: "site-1", targetType: "fixtures", targetId: null, targetFixtureIds: ["fixture-1"], brightness: 70,
    status: "failed", outcome, errorMessage: "deadline exceeded", createdAt: new Date("2026-09-12T00:00:00.000Z"), updatedAt: new Date("2026-09-12T00:00:01.000Z"),
    dispatches: [dispatch, ...(attempt ? [{ ...dispatch, id: "check-1", kind: "status_check", verificationAttempt: attempt },
      { ...dispatch, id: "check-2", kind: "status_check", verificationAttempt: attempt }] : [])] };
}
