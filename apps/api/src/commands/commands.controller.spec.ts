import { AuthenticatedUser } from "../auth/auth.types";
import { CommandStatusService } from "./command-status.service";
import { CommandsController } from "./commands.controller";
import { CommandsService } from "./commands.service";

describe("CommandsController", () => {
  const user: AuthenticatedUser = {
    id: "user-1",
    organizationId: "org-1",
    organizationType: "service_provider",
    email: "operator@example.com",
    name: "Operator",
    role: "operator",
    status: "active"
  };

  it("passes the authenticated user to command creation and status services", () => {
    const commandsService = { createDimmingCommand: jest.fn() } as unknown as CommandsService;
    const commandStatusService = { getCommand: jest.fn() } as unknown as CommandStatusService;
    const controller = new CommandsController(commandsService, commandStatusService);
    const body = { siteId: "site-1", targetType: "fixture" as const, targetId: "fixture-1", brightness: 70 };

    controller.createDimmingCommand(body, user);
    controller.getCommand("command-1", user);

    expect(commandsService.createDimmingCommand).toHaveBeenCalledWith(user, body);
    expect(commandStatusService.getCommand).toHaveBeenCalledWith(user, "command-1");
  });
});
