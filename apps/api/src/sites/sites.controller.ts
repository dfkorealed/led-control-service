import { Controller, Get } from "@nestjs/common";
import { SitesService } from "./sites.service";

@Controller("sites")
export class SitesController {
  constructor(private readonly sitesService: SitesService) {}

  @Get("default/dashboard")
  getDefaultDashboard() {
    return this.sitesService.getDefaultDashboard();
  }
}
