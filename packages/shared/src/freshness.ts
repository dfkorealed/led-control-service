export const GATEWAY_HEARTBEAT_FRESHNESS_MS = 90_000;

// Presence is polled less frequently than the freshness window so transient
// transport delays do not immediately make an otherwise operational fixture stale.
export const FIXTURE_PRESENCE_POLL_INTERVAL_MS = 10 * 60 * 1_000;
export const FIXTURE_OPERATIONAL_FRESHNESS_MS = 20 * 60 * 1_000;

export function gatewayHeartbeatFreshSince(now: Date) {
  return new Date(now.getTime() - GATEWAY_HEARTBEAT_FRESHNESS_MS);
}

export function fixtureOperationalFreshSince(now: Date) {
  return new Date(now.getTime() - FIXTURE_OPERATIONAL_FRESHNESS_MS);
}

export function isGatewayHeartbeatFresh(lastHeartbeatAt: Date | null | undefined, now: Date) {
  return Boolean(lastHeartbeatAt && lastHeartbeatAt.getTime() >= gatewayHeartbeatFreshSince(now).getTime());
}
