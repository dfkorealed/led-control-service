import { healthFaultCodesSchema, mapHealthFaults, statusFromHealth } from "@led-control/shared";

export interface FixtureHealthSnapshot {
  faultCodes: number[];
  observedAt: string;
}

export function toFixtureHealthSnapshot(
  healthFaultCodes: unknown,
  healthLastSeenAt: Date | null | undefined
): FixtureHealthSnapshot | null {
  if (!healthLastSeenAt) return null;
  const parsed = healthFaultCodesSchema.safeParse(healthFaultCodes);
  if (!parsed.success) return null;
  return {
    faultCodes: mapHealthFaults(parsed.data),
    observedAt: healthLastSeenAt.toISOString()
  };
}

export function fixtureStatusWithHealth(
  status: "online" | "offline" | "fault",
  health: FixtureHealthSnapshot | null
) {
  return health && statusFromHealth(health.faultCodes) === "fault" ? "fault" as const : status;
}
