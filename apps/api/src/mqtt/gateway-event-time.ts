export const DEFAULT_GATEWAY_EVENT_MAX_FUTURE_SKEW_MS = 300_000;

export function gatewayEventMaxFutureSkewMs(environment: NodeJS.ProcessEnv = process.env) {
  const configuredValue = environment.GATEWAY_EVENT_MAX_FUTURE_SKEW_MS;
  if (configuredValue === undefined) return DEFAULT_GATEWAY_EVENT_MAX_FUTURE_SKEW_MS;

  // A permissive Number conversion would silently accept values such as "1e3" or whitespace.
  // Configuration errors must stop ingestion rather than weakening the timestamp trust boundary.
  if (!/^\d+$/.test(configuredValue)) throw new Error("invalid GATEWAY_EVENT_MAX_FUTURE_SKEW_MS");
  const milliseconds = Number(configuredValue);
  if (!Number.isSafeInteger(milliseconds)) throw new Error("invalid GATEWAY_EVENT_MAX_FUTURE_SKEW_MS");
  return milliseconds;
}

export function gatewayEventIsTooFarInFuture(occurredAt: Date, receivedAt: Date, maxFutureSkewMs: number) {
  return occurredAt.getTime() > receivedAt.getTime() + maxFutureSkewMs;
}
