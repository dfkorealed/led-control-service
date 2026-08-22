import { BadRequestException, Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { createDimmingCommandRequestSchema } from "@led-control/shared";
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
    return this.commandStatusService.getCommand(user, commandId);
  }

  @Post("dimming")
  createDimmingCommand(
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser
  ) {
    const parsed = createDimmingCommandRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("invalid dimming command request");
    return this.commandsService.createDimmingCommand(user, parsed.data);
  }
}
