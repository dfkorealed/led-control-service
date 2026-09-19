import { describe, expect, it } from "vitest";
import { summarizeControlledEntryTimes, summarizeFrameTimes } from "./map-performance";

describe("summarizeFrameTimes", () => {
  it("reports absent evidence as null, not a successful zero duration", () => {
    expect(summarizeFrameTimes([])).toEqual({ count: 0, p95Ms: null });
  });

  it("uses nearest-rank p95 instead of interpolation", () => {
    expect(summarizeFrameTimes(Array.from({ length: 100 }, (_, i) => 100 - i)))
      .toEqual({ count: 100, p95Ms: 95 });
    expect(summarizeFrameTimes([30, 10, 20])).toEqual({ count: 3, p95Ms: 30 });
  });

  it("does not reorder the original chronological samples", () => {
    const samples = [30, 0, 10];
    expect(summarizeFrameTimes(samples)).toEqual({ count: 3, p95Ms: 30 });
    expect(samples).toEqual([30, 0, 10]);
    expect(summarizeFrameTimes([0])).toEqual({ count: 1, p95Ms: 0 });
  });

  it.each([NaN, Infinity, -Infinity, -1])("rejects invalid duration %s without dropping it", value => {
    expect(() => summarizeFrameTimes([16, value, 17])).toThrow(RangeError);
  });
});

describe("summarizeControlledEntryTimes", () => {
  const sample = (durationMs: number | null, before = "initial", after = before) => ({
    durationMs, sourceFingerprintBefore: before, sourceFingerprintAfter: after
  });

  it("does not publish a five-run p95 from one prechange sample", () => {
    expect(summarizeControlledEntryTimes([sample(9000)], "initial"))
      .toEqual({ observedCount: 1, controlledCount: 1, p95Ms: null });
  });

  it("excludes cycles changed during or between measurements", () => {
    expect(summarizeControlledEntryTimes([
      sample(9000), sample(1, "initial", "changed"), sample(2, "changed"), sample(null), sample(3, "changed")
    ], "initial")).toEqual({ observedCount: 5, controlledCount: 1, p95Ms: null });
  });

  it("requires captured source provenance, not guessed hashes", () => {
    expect(summarizeControlledEntryTimes(Array.from({ length: 5 }, () => ({
      durationMs: 1, sourceFingerprintBefore: null, sourceFingerprintAfter: null
    })), null)).toEqual({ observedCount: 5, controlledCount: 0, p95Ms: null });
  });

  it("publishes nearest-rank p95 only for five complete same-source cycles", () => {
    expect(summarizeControlledEntryTimes([100, 200, 300, 400, 500].map(value => sample(value)), "initial"))
      .toEqual({ observedCount: 5, controlledCount: 5, p95Ms: 500 });
  });
});
