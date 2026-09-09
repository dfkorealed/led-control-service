import { describe, expect, it } from "vitest";
import { fixtureIdentifyCommandSchema, fixtureIdentifyRequestSchema, fixtureIdentifyResultSchema, fixtureIdentifyTopics } from "./fixture-identify-contracts";

const id = "00000000-0000-4000-8000-000000000001";
const command = { version: 1, commandId: id, sessionId: id, fixtureId: id, siteId: id, gatewayId: id,
  action: "start", requestedAt: "2026-09-09T00:00:00.000Z", expiresAt: "2026-09-09T00:00:10.000Z" };
describe("fixture identification contracts", () => {
  it("accepts a ten-second command and rejects extra fields and longer or reversed lifetimes", () => {
    expect(fixtureIdentifyCommandSchema.parse(command)).toEqual(command);
    for (const patch of [{ brightness: 100 }, { expiresAt: "2026-09-09T00:00:11.000Z" }, { expiresAt: command.requestedAt }]) {
      expect(fixtureIdentifyCommandSchema.safeParse({ ...command, ...patch }).success).toBe(false);
    }
  });
  it("requires a stop session and a positive lease fence", () => {
    const request = { action: "start", leaseToken: id, leaseFence: 1 };
    expect(fixtureIdentifyRequestSchema.safeParse(request).success).toBe(true);
    expect(fixtureIdentifyRequestSchema.safeParse({ ...request, action: "stop" }).success).toBe(false);
    expect(fixtureIdentifyRequestSchema.safeParse({ ...request, leaseFence: 0 }).success).toBe(false);
  });
  it("never accepts position success or an inconsistent Attention status", () => {
    const result = { ...command, status: "attention_confirmed", reportedAt: command.requestedAt, attentionSeconds: 10 };
    expect(fixtureIdentifyResultSchema.safeParse(result).success).toBe(true);
    expect(fixtureIdentifyResultSchema.safeParse({ ...result, positionVerified: true }).success).toBe(false);
    expect(fixtureIdentifyResultSchema.safeParse({ ...result, attentionSeconds: 0 }).success).toBe(false);
    expect(fixtureIdentifyResultSchema.safeParse({ ...result, action: "stop" }).success).toBe(false);
  });
  it("builds only scoped identify topics", () => {
    expect(fixtureIdentifyTopics.command(id, id)).toBe(`sites/${id}/gateways/${id}/commands/identify`);
    expect(fixtureIdentifyTopics.result(id, id)).toBe(`sites/${id}/gateways/${id}/events/identify-result`);
    expect(() => fixtureIdentifyTopics.command("+", id)).toThrow();
  });
});
