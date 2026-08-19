import { Body, Controller, Get, Param, Post, UseGuards } from "@nestjs/common";
import { createRegistrationSessionSchema, registerFixtureBatchSchema } from "@led-control/shared";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { AuthenticatedUser } from "../auth/auth.types";
import { Roles } from "../access/roles.decorator";
import { RolesGuard } from "../access/roles.guard";
import { RegistrationService } from "./registration.service";

interface RegisterNodeBody {
  fixtureName: string;
  x: number;
  y: number;
  ratedWatt?: string;
}

@UseGuards(SessionAuthGuard, RolesGuard)
@Roles("operator")
@Controller("registration-sessions")
export class RegistrationController {
  constructor(private readonly registrationService: RegistrationService) {}

  @Post()
  createSession(@Body() body: unknown, @CurrentUser() user: AuthenticatedUser) {
    return this.registrationService.createSession(user, createRegistrationSessionSchema.parse(body));
  }

  @Get(":sessionId")
  getSession(@Param("sessionId") sessionId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.registrationService.getSession(user, sessionId);
  }

  @Post(":sessionId/nodes/:nodeId/identify")
  identifyNode(
    @Param("sessionId") sessionId: string,
    @Param("nodeId") nodeId: string,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.registrationService.identifyNode(user, sessionId, nodeId);
  }

  @Post(":sessionId/nodes/:nodeId/register")
  registerNode(
    @Param("sessionId") sessionId: string,
    @Param("nodeId") nodeId: string,
    @Body() body: RegisterNodeBody,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.registrationService.registerNode(user, sessionId, nodeId, body);
  }

  @Post(":sessionId/nodes/register-batch")
  registerBatch(
    @Param("sessionId") sessionId: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser
  ) {
    return this.registrationService.registerBatch(user, sessionId, registerFixtureBatchSchema.parse(body));
  }

  @Post(":sessionId/complete")
  completeSession(@Param("sessionId") sessionId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.registrationService.completeSession(user, sessionId);
  }
}
