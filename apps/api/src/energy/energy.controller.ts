import { Controller, Get } from "@nestjs/common";
import { EnergyService } from "./energy.service";

@Controller("energy")
export class EnergyController {
  constructor(private readonly energyService: EnergyService) {}

  @Get("default/estimate")
  getDefaultEstimate() {
    return this.energyService.getDefaultSiteEstimate();
  }
}
