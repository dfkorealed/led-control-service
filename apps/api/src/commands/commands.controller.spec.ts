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

  it("passes a validated target request and the authenticated user to command creation", () => {
    const commandsService = { createDimmingCommand: jest.fn() } as unknown as CommandsService;
    const commandStatusService = { getCommand: jest.fn() } as unknown as CommandStatusService;
    const controller = new CommandsController(commandsService, commandStatusService);
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
      { getCommand: jest.fn() } as unknown as CommandStatusService
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
      { getCommand: jest.fn() } as unknown as CommandStatusService
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
