import { Injectable } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service";

interface EstimateInput {
  ratedWatt: number;
  brightness: number;
  hours: number;
  tariffKwhRate: number;
}

@Injectable()
export class EnergyService {
  constructor(private readonly prisma: PrismaService) {}

  calculateEstimatedUsage(input: EstimateInput) {
    const kwh = Number(((input.ratedWatt * (input.brightness / 100) * input.hours) / 1000).toFixed(4));
    const cost = Number((kwh * input.tariffKwhRate).toFixed(2));
    return { kwh, cost };
  }

  async getDefaultSiteEstimate() {
    const site = await this.prisma.site.findFirstOrThrow({
      include: { floors: { include: { fixtures: true } } }
    });
    const fixtures = site.floors.flatMap((floor) => floor.fixtures);
    const tariffKwhRate = Number(site.tariffKwhRate);
    const daily = fixtures.reduce((sum, fixture) => {
      const estimate = this.calculateEstimatedUsage({
        ratedWatt: Number(fixture.ratedWatt),
        brightness: fixture.brightness,
        hours: 12,
        tariffKwhRate
      });
      return sum + estimate.kwh;
    }, 0);

    return {
      day: { kwh: Number(daily.toFixed(4)), cost: Number((daily * tariffKwhRate).toFixed(2)) },
      month: { kwh: Number((daily * 30).toFixed(4)), cost: Number((daily * 30 * tariffKwhRate).toFixed(2)) },
      year: { kwh: Number((daily * 365).toFixed(4)), cost: Number((daily * 365 * tariffKwhRate).toFixed(2)) }
    };
  }
}
