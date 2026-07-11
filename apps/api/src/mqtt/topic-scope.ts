import { ForbiddenException } from "@nestjs/common";

export interface GatewayTopicScope {
  siteId: string;
  gatewayId: string;
  channel: string;
}

export function parseGatewayTopic(topic: string): GatewayTopicScope | null {
  const match = /^sites\/([^/]+)\/gateways\/([^/]+)\/(.+)$/.exec(topic);
  if (!match) return null;
  return { siteId: match[1], gatewayId: match[2], channel: match[3] };
}

export function assertGatewayScope(scope: GatewayTopicScope, payload: { siteId: string; gatewayId: string }) {
  if (scope.siteId !== payload.siteId || scope.gatewayId !== payload.gatewayId) {
    throw new ForbiddenException("gateway MQTT scope mismatch");
  }
}
