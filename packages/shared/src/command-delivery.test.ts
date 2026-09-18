import { describe, expect, it } from "vitest";
import { createGatewayCommandExpiry, remainingGatewayCommandMessageExpiry } from "./command-delivery";

const generation = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

describe("createGatewayCommandExpiry", () => {
  it("uses a fixed transport delivery window without a manual override expiry", () => {
    expect(createGatewayCommandExpiry(
      new Date("2026-08-30T01:00:00.000Z"),
      generation
    )).toEqual(expect.objectContaining({
      deliveryGeneration: generation,
      deliveryGeneratedAt: "2026-08-30T01:00:00.000Z",
      deliveryWindowMs: 10_000,
      expiresAt: "2026-08-30T01:00:10.000Z",
      messageExpiryInterval: 10
    }));
  });

  it("keeps one payload generation on retry and reduces only its MQTT remaining TTL", () => {
    const delivery = createGatewayCommandExpiry(
      new Date("2026-08-30T01:00:00.000Z"),
      generation
    );

    expect(remainingGatewayCommandMessageExpiry(delivery, new Date("2026-08-30T01:00:03.200Z"))).toBe(6);
    expect(() => remainingGatewayCommandMessageExpiry(
      delivery,
      new Date("2026-08-30T01:00:10.000Z")
    )).toThrow("gateway command delivery generation expired");
  });
});
