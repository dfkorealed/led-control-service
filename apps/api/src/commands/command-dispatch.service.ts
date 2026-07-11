import { BadRequestException, Injectable } from "@nestjs/common";

interface FixtureGatewayMapping {
  fixtureId: string;
  gatewayId: string | null;
}

@Injectable()
export class CommandDispatchService {
  groupByGateway(mappings: FixtureGatewayMapping[]) {
    const grouped = new Map<string, string[]>();
    for (const mapping of mappings) {
      if (!mapping.gatewayId) throw new BadRequestException(`fixture ${mapping.fixtureId} has no gateway mapping`);
      const fixtureIds = grouped.get(mapping.gatewayId) ?? [];
      fixtureIds.push(mapping.fixtureId);
      grouped.set(mapping.gatewayId, fixtureIds);
    }
    return [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([gatewayId, fixtureIds]) => ({ gatewayId, fixtureIds }));
  }
}
