import { BadRequestException } from "@nestjs/common";
import { AuthenticatedUser } from "../auth/auth.types";
import { CommandStatusService } from "./command-status.service";
import { CommandsController } from "./commands.controller";
import { CommandsService } from "./commands.service";

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
    const controller = new CommandsController(commandsService, commandStatusService, {} as never);
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
      {} as never
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
      {} as never
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
