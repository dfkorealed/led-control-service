import { assertGatewayScope, parseGatewayTopic } from "./topic-scope";

describe("gateway MQTT topic scope", () => {
  it("parses gateway scoped topics", () => {
    expect(parseGatewayTopic("sites/site-1/gateways/gateway-1/state/fixtures")).toEqual({
      siteId: "site-1",
      gatewayId: "gateway-1",
      channel: "state/fixtures"
    });
  });

  it("rejects payload scope that differs from the topic", () => {
    expect(() =>
      assertGatewayScope(
        { siteId: "site-a", gatewayId: "gateway-a", channel: "state/fixtures" },
        { siteId: "site-b", gatewayId: "gateway-a" }
      )
    ).toThrow("scope mismatch");
  });
});
