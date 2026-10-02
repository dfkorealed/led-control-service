import { describe, expect, it } from "vitest";
import { formatControlTimestamp } from "./control-time";
describe("control timestamps", () => {
  it("renders Gregorian seconds and midnight in the requested site zone", () => {
    expect(formatControlTimestamp("2026-10-01T15:00:00.123Z", "Asia/Seoul")).toBe("2026-10-02 00:00:00");
    expect(formatControlTimestamp("2026-10-01T15:00:01Z", "UTC")).toBe("2026-10-01 15:00:01");
  });
  it("renders invalid timestamps as an em dash", () => { expect(formatControlTimestamp("invalid", "UTC")).toBe("—"); });
});
