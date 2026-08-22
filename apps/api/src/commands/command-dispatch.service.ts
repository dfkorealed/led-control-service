import { BadRequestException, Injectable } from "@nestjs/common";

interface FixtureGatewayMapping {
  fixtureId: string;
  gatewayId: string | null;
}

@Injectable()
export class CommandDispatchService {
  resolveSingleGateway(mappings: FixtureGatewayMapping[]) {
    const grouped = new Map<string, string[]>();
    for (const mapping of mappings) {
      if (!mapping.gatewayId) throw new BadRequestException(`fixture ${mapping.fixtureId} has no gateway mapping`);
      const fixtureIds = grouped.get(mapping.gatewayId) ?? [];
      fixtureIds.push(mapping.fixtureId);
      grouped.set(mapping.gatewayId, fixtureIds);
    }
    const groups = [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([gatewayId, fixtureIds]) => ({ gatewayId, fixtureIds: fixtureIds.sort() }));
    if (groups.length > 1) {
      throw new BadRequestException("현재 여러 게이트웨이에 걸친 대상은 지원하지 않습니다");
    }
    if (groups.length === 0) throw new BadRequestException("control target has no fixtures");
    return groups[0];
  }
}
