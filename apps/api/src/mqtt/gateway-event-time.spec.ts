import {
  DEFAULT_GATEWAY_EVENT_MAX_FUTURE_SKEW_MS,
  gatewayEventIsTooFarInFuture,
  gatewayEventMaxFutureSkewMs
} from "./gateway-event-time";

describe("gateway event time policy", () => {
  const receivedAt = new Date("2026-09-12T00:00:00.000Z");

  it("accepts an occurredAt exactly at the default future boundary", () => {
    expect(gatewayEventMaxFutureSkewMs({})).toBe(DEFAULT_GATEWAY_EVENT_MAX_FUTURE_SKEW_MS);
    expect(gatewayEventIsTooFarInFuture(
      new Date("2026-09-12T00:05:00.000Z"),
      receivedAt,
      DEFAULT_GATEWAY_EVENT_MAX_FUTURE_SKEW_MS
    )).toBe(false);
  });

  it("rejects an occurredAt one millisecond beyond the configured future boundary", () => {
    expect(gatewayEventIsTooFarInFuture(
      new Date("2026-09-12T00:05:00.001Z"),
      receivedAt,
      DEFAULT_GATEWAY_EVENT_MAX_FUTURE_SKEW_MS
    )).toBe(true);
  });

  it.each(["-1", "1.5", " 1", "1 ", "NaN", "", "300_000"]) (
    "fails closed for invalid GATEWAY_EVENT_MAX_FUTURE_SKEW_MS=%p",
    (configuredValue) => {
      expect(() => gatewayEventMaxFutureSkewMs({ GATEWAY_EVENT_MAX_FUTURE_SKEW_MS: configuredValue }))
        .toThrow("invalid GATEWAY_EVENT_MAX_FUTURE_SKEW_MS");
    }
  );

  it("accepts a nonnegative integer override including zero", () => {
    expect(gatewayEventMaxFutureSkewMs({ GATEWAY_EVENT_MAX_FUTURE_SKEW_MS: "0" })).toBe(0);
    expect(gatewayEventMaxFutureSkewMs({ GATEWAY_EVENT_MAX_FUTURE_SKEW_MS: "300001" })).toBe(300001);
  });
});
