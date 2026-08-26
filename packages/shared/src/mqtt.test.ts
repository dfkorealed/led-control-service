import { describe, expect, it } from "vitest";
import { mqttTopics } from "./mqtt";

describe("mqttTopics", () => {
  it("builds a gateway-scoped mesh group resync request topic", () => {
    expect(mqttTopics.meshGroupResyncRequest("site-1", "gateway-1")).toBe(
      "sites/site-1/gateways/gateway-1/events/mesh-group/resync-request"
    );
  });
});
