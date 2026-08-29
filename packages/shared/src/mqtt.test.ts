import { describe, expect, it } from "vitest";
import { mqttTopics } from "./mqtt";

describe("mqttTopics", () => {
  it("builds a gateway-scoped mesh group resync request topic", () => {
    expect(mqttTopics.meshGroupResyncRequest("site-1", "gateway-1")).toBe(
      "sites/site-1/gateways/gateway-1/events/mesh-group/resync-request"
    );
  });

  it("builds gateway-scoped automation MQTT v2 topics", () => {
    expect(mqttTopics.automationConfig("site-1", "gateway-1")).toBe(
      "sites/site-1/gateways/gateway-1/commands/automation/config-sync"
    );
    expect(mqttTopics.automationConfigApplied("site-1", "gateway-1")).toBe(
      "sites/site-1/gateways/gateway-1/events/automation/config-applied"
    );
    expect(mqttTopics.automationExecution("site-1", "gateway-1")).toBe(
      "sites/site-1/gateways/gateway-1/events/automation/execution"
    );
    expect(mqttTopics.automationExecutionIngested("site-1", "gateway-1")).toBe(
      "sites/site-1/gateways/gateway-1/acks/automation/execution-ingested"
    );
    expect(mqttTopics.vehicleSensorCapabilityReport("site-1", "gateway-1")).toBe(
      "sites/site-1/gateways/gateway-1/events/automation/vehicle-sensor-capability"
    );
  });
});
