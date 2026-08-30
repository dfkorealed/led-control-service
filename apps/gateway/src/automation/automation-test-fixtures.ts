import { createHash } from "node:crypto";
import type { AutomationSnapshotV1 } from "@led-control/shared";

export const automationScope = {
  siteId: "00000000-0000-4000-8000-000000000003",
  gatewayId: "00000000-0000-4000-8000-000000000004"
};

export function automationSnapshot(
  revision: number,
  patch: Partial<Omit<AutomationSnapshotV1, "payloadHash">> = {}
): AutomationSnapshotV1 {
  const withoutHash = {
    schemaVersion: 1 as const,
    ...automationScope,
    revision,
    timeZone: "Asia/Seoul",
    schedules: [],
    vehicleEventRules: [],
    generatedAt: "2026-08-30T00:00:00.000Z",
    ...patch
  };
  return { ...withoutHash, payloadHash: canonicalHash(withoutHash) };
}

function canonicalHash(value: unknown) {
  return `sha256:${createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex")}` as const;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)])
  );
}
