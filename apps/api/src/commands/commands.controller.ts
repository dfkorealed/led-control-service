import { BadRequestException, Body, Controller, Get, Param, Post, Query, UseGuards } from "@nestjs/common";
import { createDimmingCommandRequestSchema } from "@led-control/shared";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { AuthenticatedUser } from "../auth/auth.types";
import { CommandsService } from "./commands.service";
import { commandHistoryQuerySchema, CommandStatusService } from "./command-status.service";
import { CommandVerificationService } from "./command-verification.service";
import { CommandRecoveryService } from "./command-recovery.service";
import { z } from "zod";

const statusCheckRequestSchema = z.object({ clientRequestId: z.string().uuid() }).strict();

@Controller("commands")
@UseGuards(SessionAuthGuard)
export class CommandsController {
  constructor(
    private readonly commandsService: CommandsService,
    private readonly commandStatusService: CommandStatusService,
    private readonly commandVerificationService: CommandVerificationService,
    private readonly commandRecoveryService: CommandRecoveryService
  ) {}

  @Get()
  listCommands(@Query() query: unknown, @CurrentUser() user: AuthenticatedUser) {
    const parsed = commandHistoryQuerySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException("invalid command history query");
    return this.commandStatusService.listCommands(user, parsed.data);
  }

  @Get("requiring-verification")
  listVerificationCases(@Query() query: unknown, @CurrentUser() user: AuthenticatedUser) {
    // Site authorization precedes all filter/cursor parsing in the service.
    return this.commandRecoveryService.listCases(user, query);
  }

  @Get("requiring-verification/:caseId")
  getVerificationCase(@Param("caseId") caseId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.commandRecoveryService.getCase(user, caseId);
  }

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

  @Post(":commandId/status-checks")
  requestStatusCheck(
    @Param("commandId") commandId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser
  ) {
    const parsed = statusCheckRequestSchema.safeParse(body);
    if (!parsed.success) throw new BadRequestException("invalid status-check request");
    return this.commandVerificationService.requestStatusCheck(user, commandId, parsed.data);
  }
}
