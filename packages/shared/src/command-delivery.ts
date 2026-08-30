export const GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS = 10_000;
export const GATEWAY_COMMAND_EXPIRY_CLOCK_SKEW_GUARD_MS = 2_000;

export interface GatewayCommandDeliveryGeneration {
  deliveryGeneration: string;
  deliveryGeneratedAt: string;
  deliveryWindowMs: number;
  overrideRemainingMs?: number;
  expiresAt: string;
}

export function createGatewayCommandExpiry(
  publishedAt: Date,
  overrideUntil: string | undefined,
  deliveryGeneration: string
) {
  const generatedAt = publishedAt.getTime();
  const deliveryDeadline = generatedAt + GATEWAY_COMMAND_ACCEPTANCE_DEADLINE_MS;
  const absoluteDeadline = overrideUntil === undefined ? deliveryDeadline : Date.parse(overrideUntil);
  if (!Number.isFinite(absoluteDeadline)) throw new Error("invalid manual override expiry");
  if (absoluteDeadline <= generatedAt) throw new Error("manual override already expired");
  const overrideRemainingMs = overrideUntil === undefined ? undefined : absoluteDeadline - generatedAt;
  const rawWindowMs = Math.min(deliveryDeadline, absoluteDeadline) - generatedAt;
  const messageExpiryInterval = Math.floor(rawWindowMs / 1_000);
  if (messageExpiryInterval <= 0) throw new Error("gateway command delivery window is less than one second");
  const deliveryWindowMs = messageExpiryInterval * 1_000;
  return {
    deliveryGeneration,
    deliveryGeneratedAt: publishedAt.toISOString(),
    deliveryWindowMs,
    ...(overrideRemainingMs === undefined ? {} : { overrideRemainingMs }),
    expiresAt: new Date(generatedAt + deliveryWindowMs).toISOString(),
    messageExpiryInterval
  };
}

export function remainingGatewayCommandMessageExpiry(
  delivery: Pick<GatewayCommandDeliveryGeneration, "expiresAt">,
  now: Date
) {
  const remainingSeconds = Math.floor((Date.parse(delivery.expiresAt) - now.getTime()) / 1_000);
  if (remainingSeconds <= 0) throw new Error("gateway command delivery generation expired");
  return remainingSeconds;
}

export function isGatewayCommandExpired(expiresAt: string, now = new Date()) {
  // Reject before expiry so a gateway clock that is up to the guard behind cannot run BLE after the API deadline.
  return now.getTime() >= Date.parse(expiresAt) - GATEWAY_COMMAND_EXPIRY_CLOCK_SKEW_GUARD_MS;
}
