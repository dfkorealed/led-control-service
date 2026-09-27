import { BadRequestException, Controller, Get, Param, Query, UseGuards } from "@nestjs/common";
import { z } from "zod";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { MonitoringActivityService } from "./monitoring-activity.service";

const querySchema = z.object({
  limit: z.string().regex(/^[1-9]\d*$/).transform(Number).pipe(z.number().int().min(1).max(50)).optional(),
  cursor: z.string().min(1).max(512).optional()
}).strict();

@Controller()
@UseGuards(SessionAuthGuard)
export class MonitoringActivityController {
  constructor(private readonly service: MonitoringActivityService) {}

  @Get("sites/:siteId/floors/:floorId/monitoring-activity")
  list(@CurrentUser() user: AuthenticatedUser, @Param("siteId") siteId: string,
    @Param("floorId") floorId: string, @Query() query: unknown) {
    if (!z.string().uuid().safeParse(siteId).success || !z.string().uuid().safeParse(floorId).success) {
      throw new BadRequestException("invalid monitoring activity scope");
    }
    const parsed = querySchema.safeParse(query);
    if (!parsed.success) throw new BadRequestException("invalid monitoring activity query");
    return this.service.list(user, siteId, floorId, parsed.data);
  }
}
