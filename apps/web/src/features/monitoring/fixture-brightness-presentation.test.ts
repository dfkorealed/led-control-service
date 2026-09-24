import { describe, expect, it } from "vitest";
import { presentFixtureBrightness } from "./fixture-brightness-presentation";

describe("presentFixtureBrightness", () => {
  it("labels an offline reading as historical and keeps its observation time", () => {
    expect(presentFixtureBrightness({ brightness: 42, status: "offline", statusReason: "gateway_offline", lastSeenAt: "2026-09-24T01:02:03.000Z" })).toEqual({
      label: "최근 확인 밝기", value: "42%", observedAt: "2026-09-24T01:02:03.000Z"
    });
  });

  it("does not present a fabricated current or historical value before the first report", () => {
    expect(presentFixtureBrightness({ brightness: 0, status: "offline", statusReason: "provisioning_waiting_state", lastSeenAt: null })).toEqual({
      label: "최근 확인 밝기", value: "확인 전", observedAt: null
    });
  });

  it("keeps the last observed brightness historical when the fixture state is stale", () => {
    expect(presentFixtureBrightness({ brightness: 75, status: "offline", statusReason: "fixture_stale", lastSeenAt: "2026-09-24T01:02:03.000Z" }).label).toBe("최근 확인 밝기");
  });

  it("labels a live reported fixture value as current", () => {
    expect(presentFixtureBrightness({ brightness: 70, status: "online", statusReason: "reported", lastSeenAt: "2026-09-24T01:02:03.000Z" })).toEqual({
      label: "현재 밝기", value: "70%", observedAt: "2026-09-24T01:02:03.000Z"
    });
  });
});
