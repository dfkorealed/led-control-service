import { describe, expect, it } from "vitest";
import { mqttTopics } from "./mqtt";

describe("mqttTopics", () => {
  it("builds gateway-scoped provisioning scan terminal topics", () => {
    expect(mqttTopics.provisioningScanCompleted("site-1", "gateway-1")).toBe(
      "sites/site-1/gateways/gateway-1/events/provisioning/scan-completed"
    );
    expect(mqttTopics.provisioningScanFailed("site-1", "gateway-1")).toBe(
      "sites/site-1/gateways/gateway-1/events/provisioning/scan-failed"
    );
  });

  it("builds a gateway-scoped mesh group resync request topic", () => {
    expect(mqttTopics.meshGroupResyncRequest("site-1", "gateway-1")).toBe(
      "sites/site-1/gateways/gateway-1/events/mesh-group/resync-request"
    );
  });
});
