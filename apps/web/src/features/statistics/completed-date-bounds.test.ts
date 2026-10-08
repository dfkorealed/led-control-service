import { describe, expect, it } from "vitest";
import { parseBounds, parseIsoDate } from "../../components/ui/date/date-adapters";
import { completedDateBounds } from "./completed-date-bounds";

describe("completedDateBounds", () => {
  it("retains sibling ordering and the completed-day upper bound for valid drafts", () => {
    expect(completedDateBounds("2026-09-02", "2026-10-01", "2026-10-01")).toEqual({
      start: { maxValue: "2026-10-01" }, end: { minValue: "2026-09-02", maxValue: "2026-10-01" }
    });
    expect(completedDateBounds("2026-09-02", "2026-09-10", "2026-10-01").start.maxValue).toBe("2026-09-10");
  });

  it.each([
    ["2027-10-01", "2026-10-01"], ["2026-10-01", "2025-10-01"],
    ["2026-09-02", "2027-10-01"], ["", "2026-10-01"], ["2026-09-02", ""], ["", ""]
  ])("keeps strict parseable bounds for invalid draft %s to %s without rewriting it", (from, to) => {
    const bounds = completedDateBounds(from, to, "2026-10-01");
    expect(() => parseBounds(undefined, bounds.start.maxValue, parseIsoDate)).not.toThrow();
    expect(() => parseBounds(bounds.end.minValue, bounds.end.maxValue, parseIsoDate)).not.toThrow();
    expect(bounds.start.maxValue! <= "2026-10-01").toBe(true);
    expect(bounds.end.maxValue).toBe("2026-10-01");
    expect(bounds.end.minValue).toBe(from ? (from > "2026-10-01" ? "2026-10-01" : from) : undefined);
  });

  it("omits empty bounds while the site completion context is loading", () => {
    expect(completedDateBounds("", "", "")).toEqual({ start: { maxValue: undefined }, end: { minValue: undefined, maxValue: undefined } });
  });
});
