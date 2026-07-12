import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { AuthenticatedUser } from "../auth/auth.types";
import { CommandsService } from "./commands.service";
import { CommandStatusService } from "./command-status.service";

@Controller("commands")
@UseGuards(SessionAuthGuard)
export class CommandsController {
  constructor(
    private readonly commandsService: CommandsService,
    private readonly commandStatusService: CommandStatusService
  ) {}

  @Get(":commandId")
  getCommand(@Param("commandId") commandId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.commandStatusService.getCommand(commandId, user.organizationId);
  }

  @Post("dimming")
  createDimmingCommand(
    @Body()
    body: {
      siteId: string;
      targetType: "fixture" | "group";
      targetId: string;
      brightness: number;
    },
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.commandsService.createDimmingCommand({ ...body, requestedBy: user.id });
  }
}
