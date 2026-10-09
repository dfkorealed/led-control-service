import { BadRequestException, Body, Controller, Get, Header, Param, Post, UseGuards } from "@nestjs/common";
import { bioSensorModeRequestSchema } from "@led-control/shared";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { AuthenticatedUser } from "../auth/auth.types";
import { SensorModeOperationsService } from "./sensor-mode-operations.service";

@Controller("sensor-mode-operations")
@UseGuards(SessionAuthGuard)
export class SensorModeOperationsController {
  constructor(private readonly operations: SensorModeOperationsService) {}
  @Post()
  create(@CurrentUser() user: AuthenticatedUser, @Body() value: unknown) {
    const parsed = bioSensorModeRequestSchema.safeParse(value);
    if (!parsed.success) throw new BadRequestException("invalid sensor mode operation request");
    return this.operations.create(user, parsed.data);
  }
  @Get(":commandId")
  @Header("Cache-Control", "private, no-store")
  get(@CurrentUser() user: AuthenticatedUser, @Param("commandId") commandId: string) {
    return this.operations.get(user, commandId);
  }
}
