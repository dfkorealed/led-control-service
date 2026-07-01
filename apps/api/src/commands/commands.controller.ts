import { Body, Controller, Post } from "@nestjs/common";
import { CommandsService } from "./commands.service";

@Controller("commands")
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
      requestedBy: string;
    }
  ) {
    return this.commandsService.createDimmingCommand(body);
  }
}
