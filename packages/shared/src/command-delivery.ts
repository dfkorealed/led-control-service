export const GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS = 10_000;
export const GATEWAY_COMMAND_EXPIRY_CLOCK_SKEW_GUARD_MS = 2_000;

export function createGatewayCommandExpiry(publishedAt: Date, overrideUntil?: string) {
  const deliveryDeadline = publishedAt.getTime() + GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS;
  const absoluteDeadline = overrideUntil === undefined ? deliveryDeadline : Date.parse(overrideUntil);
  if (!Number.isFinite(absoluteDeadline)) throw new Error("invalid manual override expiry");
  if (absoluteDeadline <= publishedAt.getTime()) throw new Error("manual override already expired");
  const expiresAt = Math.min(deliveryDeadline, absoluteDeadline);
  const remainingMs = expiresAt - publishedAt.getTime();
  return {
    expiresAt: new Date(expiresAt).toISOString(),
    // Floor to whole MQTT seconds so broker retention cannot outlive the absolute override.
    messageExpiryInterval: Math.floor(remainingMs / 1000)
  };
}

export function isGatewayCommandExpired(expiresAt: string, now = new Date()) {
  // Reject before expiry so a gateway clock that is up to the guard behind cannot run BLE after the API deadline.
  return now.getTime() >= Date.parse(expiresAt) - GATEWAY_COMMAND_EXPIRY_CLOCK_SKEW_GUARD_MS;
}
