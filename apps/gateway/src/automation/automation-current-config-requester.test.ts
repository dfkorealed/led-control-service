import { mqttTopics } from "@led-control/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AutomationCurrentConfigRequester } from "./automation-current-config-requester";
import { automationScope, automationSnapshot } from "./automation-test-fixtures";

describe("AutomationCurrentConfigRequester", () => {
  afterEach(() => vi.useRealTimers());

  it("publishes on every subscription-ready connect and retries one exact request with bounded backoff until a snapshot arrives", async () => {
    vi.useFakeTimers();
    const ids = [
      "11111111-1111-4111-8111-111111111111",
      "22222222-2222-4222-8222-222222222222"
    ];
    const requester = new AutomationCurrentConfigRequester(automationScope, {
      createRequestId: () => ids.shift()!,
      now: () => new Date("2026-08-31T00:00:00.000Z"),
      random: () => 0,
      retryInitialDelayMs: 10,
      retryMaxDelayMs: 20
    });
    const publish = vi.fn().mockResolvedValue(undefined);

    await requester.connect(publish);
    const [topic, firstRequest] = publish.mock.calls[0];
    expect(topic).toBe(mqttTopics.automationCurrentConfigRequest(automationScope.siteId, automationScope.gatewayId));
    expect(firstRequest).toEqual({
      schemaVersion: 1,
      requestId: "11111111-1111-4111-8111-111111111111",
      ...automationScope,
      requestedAt: "2026-08-31T00:00:00.000Z"
    });

    await vi.advanceTimersByTimeAsync(10);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1][1]).toEqual(firstRequest);
    await vi.advanceTimersByTimeAsync(20);
    expect(publish).toHaveBeenCalledTimes(3);
    expect(requester.confirm({ ...automationSnapshot(4), gatewayId: "33333333-3333-4333-8333-333333333333" })).toBe(false);
    expect(requester.confirm(automationSnapshot(4))).toBe(true);
    expect(vi.getTimerCount()).toBe(0);

    requester.disconnect();
    await requester.connect(publish);
    expect(publish.mock.calls[3][1]).toMatchObject({
      requestId: "22222222-2222-4222-8222-222222222222"
    });
    requester.disconnect();
  });
});
