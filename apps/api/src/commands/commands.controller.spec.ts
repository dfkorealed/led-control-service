import { BadRequestException, GoneException, INestApplication } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { AuthService } from "../auth/auth.service";
import { AuthenticatedUser } from "../auth/auth.types";
import { CommandStatusService } from "./command-status.service";
import { CommandsController } from "./commands.controller";
import { CommandsService } from "./commands.service";
import { CommandRecoveryService } from "./command-recovery.service";
import { CommandVerificationService } from "./command-verification.service";

describe("CommandsController", () => {
  const user: AuthenticatedUser = {
    id: "user-1",
    organizationId: "org-1",
    organizationType: "service_provider",
    loginId: "fixture_user",
    name: "Operator",
    role: "operator",
    mustChangePassword: false,
    status: "active"
  };

  it("registers the status-check route and forwards only a validated request", () => {
    const verification = { requestStatusCheck: jest.fn() };
    const controller = new (CommandsController as any)({}, {}, verification);
    const body = { clientRequestId: "11111111-1111-4111-8111-111111111111" };
    expect(typeof controller.requestStatusCheck).toBe("function");
    controller.requestStatusCheck("command-1", body, user);
    expect(verification.requestStatusCheck).toHaveBeenCalledWith(user, "command-1", body);
    expect(Reflect.getMetadata("path", controller.requestStatusCheck)).toBe(":commandId/status-checks");
  });

  it("parses history query limits and registers the collection route", () => {
    const status = { listCommands: jest.fn() };
    const controller = new (CommandsController as any)({}, status, {});
    expect(typeof controller.listCommands).toBe("function");
    controller.listCommands({ siteId: "22222222-2222-4222-8222-222222222222", query: "  Lobby ", limit: "100", stage: "verification_required" }, user);
    expect(status.listCommands).toHaveBeenCalledWith(user, { siteId: "22222222-2222-4222-8222-222222222222", query: "Lobby", limit: 100, stage: "verification_required" });
    expect(Reflect.getMetadata("path", controller.listCommands)).toBe("/");
  });

  it("registers static recovery case read routes before the dynamic command detail route", () => {
    const recovery = { listCases: jest.fn(), getCase: jest.fn() };
    const controller = new (CommandsController as any)({}, {}, {}, recovery);
    const query = { siteId: "22222222-2222-4222-8222-222222222222", originalCommandId: "11111111-1111-4111-8111-111111111111" };
    controller.listVerificationCases(query, user);
    controller.getVerificationCase("case-1", user);
    expect(recovery.listCases).toHaveBeenCalledWith(user, query);
    expect(recovery.getCase).toHaveBeenCalledWith(user, "case-1");
    expect(Reflect.getMetadata("path", controller.listVerificationCases)).toBe("requiring-verification");
    expect(Reflect.getMetadata("path", controller.getVerificationCase)).toBe("requiring-verification/:caseId");
  });

  it.each([{ limit: "0" }, { limit: "101" }, { limit: "1.5" }, { limit: "1e2" }, { limit: ["2"] },
    { stage: "unknown" }, { query: "x".repeat(101) }, { siteId: "bad" }, { cursor: "x".repeat(513) }])(
    "rejects malformed history query %p", (invalid) => {
      const status = { listCommands: jest.fn() };
      const controller = new (CommandsController as any)({}, status, {});
      expect(typeof controller.listCommands).toBe("function");
      expect(() => controller.listCommands({ siteId: "22222222-2222-4222-8222-222222222222", ...invalid }, user)).toThrow(BadRequestException);
      expect(status.listCommands).not.toHaveBeenCalled();
    }
  );

  it.each([{}, { clientRequestId: "bad" }, { clientRequestId: "11111111-1111-4111-8111-111111111111", brightness: 20 }])(
    "rejects invalid status-check bodies before calling the service: %p", (body) => {
      const verification = { requestStatusCheck: jest.fn() };
      const controller = new (CommandsController as any)({}, {}, verification);
      expect(typeof controller.requestStatusCheck).toBe("function");
      expect(() => controller.requestStatusCheck("command-1", body, user)).toThrow(BadRequestException);
      expect(verification.requestStatusCheck).not.toHaveBeenCalled();
    }
  );

  it("passes a validated target request and the authenticated user to command creation", () => {
    const commandsService = { createDimmingCommand: jest.fn() } as unknown as CommandsService;
    const commandStatusService = { getCommand: jest.fn() } as unknown as CommandStatusService;
    const controller = new CommandsController(commandsService, commandStatusService, {} as never, {} as CommandRecoveryService);
    const body = {
      siteId: "22222222-2222-4222-8222-222222222222",
      clientRequestId: "11111111-1111-4111-8111-111111111111",
      target: { type: "floor" as const, floorId: "33333333-3333-4333-8333-333333333333" },
      brightness: 70
    };

    controller.createDimmingCommand(body, user);
    controller.getCommand("command-1", user);

    expect(commandsService.createDimmingCommand).toHaveBeenCalledWith(user, body);
    expect(commandStatusService.getCommand).toHaveBeenCalledWith(user, "command-1");
  });

  it("normalizes the current web legacy request only at the controller boundary", () => {
    const commandsService = { createDimmingCommand: jest.fn() } as unknown as CommandsService;
    const controller = new CommandsController(
      commandsService,
      { getCommand: jest.fn() } as unknown as CommandStatusService,
      {} as never,
      {} as CommandRecoveryService
    );
    const siteId = "22222222-2222-4222-8222-222222222222";
    const targetId = "33333333-3333-4333-8333-333333333333";

    controller.createDimmingCommand({
      siteId,
      clientRequestId: "11111111-1111-4111-8111-111111111111",
      targetType: "group",
      targetId,
      brightness: 45
    }, user);

    expect(commandsService.createDimmingCommand).toHaveBeenCalledWith(user, {
      siteId,
      clientRequestId: "11111111-1111-4111-8111-111111111111",
      target: { type: "group", groupId: targetId },
      brightness: 45
    });
  });

  it("does not call the service when Zod rejects an invalid request", () => {
    const commandsService = { createDimmingCommand: jest.fn() } as unknown as CommandsService;
    const controller = new CommandsController(
      commandsService,
      { getCommand: jest.fn() } as unknown as CommandStatusService,
      {} as never,
      {} as CommandRecoveryService
    );

    const error = (() => {
      try {
        controller.createDimmingCommand({
          siteId: "not-a-uuid",
          target: { type: "fixtures", fixtureIds: [] },
          brightness: 101
        }, user);
      } catch (caught) {
        return caught;
      }
      return null;
    })();

    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).message).toBe("invalid dimming command request");
    expect(commandsService.createDimmingCommand).not.toHaveBeenCalled();
  });
});

describe("CommandsController authenticated GET HTTP cache contract", () => {
  let app: INestApplication;
  let baseUrl: string;
  const siteId = "22222222-2222-4222-8222-222222222222";
  const authenticatedUser: AuthenticatedUser = {
    id: "11111111-1111-4111-8111-111111111111", organizationId: "33333333-3333-4333-8333-333333333333",
    organizationType: "customer", loginId: "site_reader", name: "Site reader", role: "viewer",
    mustChangePassword: false, status: "active"
  };

  beforeAll(async () => {
    const module = await Test.createTestingModule({ controllers: [CommandsController], providers: [
      { provide: AuthService, useValue: { getUserBySessionToken: async () => authenticatedUser } },
      { provide: CommandsService, useValue: {} },
      { provide: CommandVerificationService, useValue: {} },
      { provide: CommandStatusService, useValue: {
        listCommands: async () => ({ items: [], nextCursor: null }),
        getCommand: async (_user: AuthenticatedUser, id: string) => {
          if (id === "expired") throw new GoneException({ code: "command_expired" });
          return { id };
        }
      } },
      { provide: CommandRecoveryService, useValue: {
        listCases: async () => ({ items: [], nextCursor: null }), getCase: async (_user: AuthenticatedUser, id: string) => ({ caseId: id })
      } }
    ] }).compile();
    app = module.createNestApplication();
    await app.listen(0, "127.0.0.1");
    baseUrl = await app.getUrl();
  });
  afterAll(async () => { await app?.close(); });

  it.each([
    `/commands?siteId=${siteId}`,
    "/commands/11111111-1111-4111-8111-111111111111",
    `/commands/requiring-verification?siteId=${siteId}`,
    "/commands/requiring-verification/case-1",
    "/commands/expired"
  ])("prevents authenticated command GET response caching for %s", async path => {
    const response = await fetch(`${baseUrl}${path}`, { headers: { Cookie: "led_session=test" } });
    expect(response.status).toBe(path.endsWith("/expired") ? 410 : 200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });
});
