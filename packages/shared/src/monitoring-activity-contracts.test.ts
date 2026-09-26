import { describe, expect, it } from "vitest";
import { monitoringActivityResponseSchema } from "./monitoring-activity-contracts";

const item = {
  id: "00000000-0000-4000-8000-000000000001",
  kind: "fixture_status_changed",
  recordedAt: "2026-09-25T01:00:00.000Z",
  observedAt: "2026-09-25T00:59:58.000Z",
  fixtureId: "00000000-0000-4000-8000-000000000002",
  displayName: "B1 조명",
  status: "online"
};
const response = {
  generatedAt: "2026-09-25T01:00:00.000Z",
  retainedFrom: "2026-06-25T01:00:00.000Z",
  items: [item],
  nextCursor: null
};

describe("monitoring activity response", () => {
  it("requires the UTC retention boundary and only returns allowlisted fields", () => {
    expect(monitoringActivityResponseSchema.parse(response)).toEqual(response);
    expect(monitoringActivityResponseSchema.safeParse({ ...response, retainedFrom: undefined }).success).toBe(false);
    expect(monitoringActivityResponseSchema.safeParse({ ...response, items: [{ ...item, payload: { secret: true } }] }).success).toBe(false);
    expect(monitoringActivityResponseSchema.safeParse({ ...response, items: [{ ...item, ipAddress: "127.0.0.1" }] }).success).toBe(false);
  });

  it("does not turn an uncertain command result into success", () => {
    const command = { id: item.id, kind: "command_result", recordedAt: item.recordedAt, commandOutcome: "unknown" };
    expect(monitoringActivityResponseSchema.parse({ ...response, items: [command] }).items[0]).toEqual(command);
    expect(monitoringActivityResponseSchema.safeParse({ ...response, items: [{ ...command, commandOutcome: "success" }] }).success).toBe(false);
  });
});
