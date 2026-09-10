import { Controller, Delete, Param, Post, UseGuards } from "@nestjs/common";
import { Roles } from "../access/roles.decorator";
import { RolesGuard } from "../access/roles.guard";
import { AuthenticatedUser } from "../auth/auth.types";
import { CurrentUser } from "../auth/current-user.decorator";
import { SessionAuthGuard } from "../auth/session-auth.guard";
import { TestDataEnabledGuard } from "./test-data-enabled.guard";
import { TestDataService } from "./test-data.service";

@UseGuards(TestDataEnabledGuard, SessionAuthGuard, RolesGuard)
@Roles("admin")
@Controller("test-data/sites")
export class TestDataController {
  constructor(private readonly testDataService: TestDataService) {}

  @Post(":siteId")
  create(@Param("siteId") siteId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.testDataService.create(user, siteId);
  }

  @Delete(":siteId")
  remove(@Param("siteId") siteId: string, @CurrentUser() user: AuthenticatedUser) {
    return this.testDataService.remove(user, siteId);
  }
}
