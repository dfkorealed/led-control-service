export const GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS = 10_000;
export const GATEWAY_COMMAND_EXPIRY_CLOCK_SKEW_GUARD_MS = 2_000;

export function createGatewayCommandExpiry(publishedAt: Date) {
  return {
    expiresAt: new Date(publishedAt.getTime() + GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS).toISOString(),
    messageExpiryInterval: Math.ceil(GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS / 1000)
  };
}

export function isGatewayCommandExpired(expiresAt: string, now = new Date()) {
  // Reject before expiry so a gateway clock that is up to the guard behind cannot run BLE after the API deadline.
  return now.getTime() >= Date.parse(expiresAt) - GATEWAY_COMMAND_EXPIRY_CLOCK_SKEW_GUARD_MS;
}
