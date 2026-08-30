import { describe, expect, it } from "vitest";
import { createGatewayCommandExpiry, remainingGatewayCommandMessageExpiry } from "./command-delivery";

const generation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("createGatewayCommandExpiry", () => {
  it("caps command and MQTT expiry at the absolute manual override end", () => {
    expect(createGatewayCommandExpiry(
      new Date("2026-08-30T01:00:00.000Z"),
      "2026-08-30T01:00:03.500Z",
      generation
    )).toEqual({
      deliveryGeneration: generation,
      deliveryGeneratedAt: "2026-08-30T01:00:00.000Z",
      deliveryWindowMs: 3_000,
      overrideRemainingMs: 3_500,
      expiresAt: "2026-08-30T01:00:03.000Z",
      messageExpiryInterval: 3
    });
  });

  it("preserves a long override lifetime while bounding only broker delivery freshness", () => {
    expect(createGatewayCommandExpiry(
      new Date("2026-08-30T01:00:00.000Z"),
      "2026-09-29T01:00:00.000Z",
      generation
    )).toMatchObject({
      deliveryWindowMs: 10_000,
      overrideRemainingMs: 30 * 24 * 60 * 60 * 1_000,
      expiresAt: "2026-08-30T01:00:10.000Z",
      messageExpiryInterval: 10
    });
  });

  it("keeps one payload generation on retry and reduces only its MQTT remaining TTL", () => {
    const delivery = createGatewayCommandExpiry(
      new Date("2026-08-30T01:00:00.000Z"),
      "2026-08-30T02:00:00.000Z",
      generation
    );

    expect(remainingGatewayCommandMessageExpiry(delivery, new Date("2026-08-30T01:00:03.200Z"))).toBe(6);
    expect(() => remainingGatewayCommandMessageExpiry(
      delivery,
      new Date("2026-08-30T01:00:10.000Z")
    )).toThrow("gateway command delivery generation expired");
  });

  it("refuses to create a delivery window after the absolute override end", () => {
    expect(() => createGatewayCommandExpiry(
      new Date("2026-08-30T01:00:04.000Z"),
      "2026-08-30T01:00:03.500Z",
      generation
    )).toThrow("manual override already expired");
  });
});
