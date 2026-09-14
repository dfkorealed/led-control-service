export const GATEWAY_HEARTBEAT_FRESHNESS_MS = 90_000;

// Presence 폴링은 10분(600,000ms)마다 수행하고, 운영 상태 freshness 창은 20분(1,200,000ms)으로 둡니다.
// 일시적인 전송 지연이 있어도 정상 fixture가 즉시 stale로 판정되지 않도록 폴링 주기보다 창을 넉넉히 잡습니다.
export const FIXTURE_PRESENCE_POLL_INTERVAL_MS = 10 * 60 * 1_000;
export const FIXTURE_OPERATIONAL_FRESHNESS_MS = 20 * 60 * 1_000;

export function gatewayHeartbeatFreshSince(now: Date) {
  return new Date(now.getTime() - GATEWAY_HEARTBEAT_FRESHNESS_MS);
}

export function fixtureOperationalFreshSince(now: Date) {
  return new Date(now.getTime() - FIXTURE_OPERATIONAL_FRESHNESS_MS);
}

export function isFixtureOperationalFresh(lastPresenceAt: Date | null | undefined, now: Date) {
  return Boolean(lastPresenceAt && lastPresenceAt.getTime() >= fixtureOperationalFreshSince(now).getTime());
}

export function isGatewayHeartbeatFresh(lastHeartbeatAt: Date | null | undefined, now: Date) {
  return Boolean(lastHeartbeatAt && lastHeartbeatAt.getTime() >= gatewayHeartbeatFreshSince(now).getTime());
}
