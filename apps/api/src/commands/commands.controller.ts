import { Body, Controller, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { AuthenticatedUser } from "../auth/auth.types";
import { CommandsService } from "./commands.service";

@Controller("commands")
@UseGuards(SessionAuthGuard)
export class CommandsController {
  constructor(private readonly commandsService: CommandsService) {}

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
