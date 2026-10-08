import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import type { AuthenticatedUser } from "../auth/auth.types";
import { BioSensorPreparationService } from "./bio-sensor-preparation.service";

@UseGuards(SessionAuthGuard)
@Controller("bio-sensor-preparations")
export class BioSensorPreparationController {
  constructor(private readonly preparation: BioSensorPreparationService) {}
  @Post() create(@CurrentUser() actor: AuthenticatedUser, @Body() value: unknown) { return this.preparation.create(actor, value); }
  @Get(":commandId") get(@CurrentUser() actor: AuthenticatedUser, @Param("commandId") commandId: string) { return this.preparation.get(actor, commandId); }
}
