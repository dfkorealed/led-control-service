import { describe, expect, it } from "vitest";
import { createGatewayCommandExpiry } from "./command-delivery";

describe("createGatewayCommandExpiry", () => {
  it("caps command and MQTT expiry at the absolute manual override end", () => {
    expect(createGatewayCommandExpiry(
      new Date("2026-08-30T01:00:00.000Z"),
      "2026-08-30T01:00:03.500Z"
    )).toEqual({
      expiresAt: "2026-08-30T01:00:03.500Z",
      messageExpiryInterval: 3
    });
  });

  it("refuses to create a delivery window after the absolute override end", () => {
    expect(() => createGatewayCommandExpiry(
      new Date("2026-08-30T01:00:04.000Z"),
      "2026-08-30T01:00:03.500Z"
    )).toThrow("manual override already expired");
  });
});
