export const GATEWAY_HEARTBEAT_FRESHNESS_MS = 90_000;

export function gatewayHeartbeatFreshSince(now: Date) {
  return new Date(now.getTime() - GATEWAY_HEARTBEAT_FRESHNESS_MS);
}

export function isGatewayHeartbeatFresh(lastHeartbeatAt: Date | null | undefined, now: Date) {
  return Boolean(lastHeartbeatAt && lastHeartbeatAt.getTime() >= gatewayHeartbeatFreshSince(now).getTime());
}
