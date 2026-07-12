import { describe, expect, it, vi } from "vitest";
import { runSoak } from "./soak-test";

describe("runSoak", () => {
  it("records each successful sample and completes at the duration boundary", async () => {
    let now = 0;
    const execute = vi.fn().mockResolvedValue({ passed: true, evidence: { heartbeatAgeMs: 100 } });
    const records: unknown[] = [];
    const result = await runSoak({
      durationMs: 2000,
      intervalMs: 1000,
      execute,
      now: () => now,
      sleep: async (ms) => { now += ms; },
      record: async (entry) => { records.push(entry); }
    });

    expect(result).toMatchObject({ passed: true, samples: 2, failures: 0 });
    expect(execute).toHaveBeenCalledTimes(2);
    expect(records).toHaveLength(2);
  });

  it("stops on the first failed production sample", async () => {
    const result = await runSoak({
      durationMs: 72 * 60 * 60 * 1000,
      intervalMs: 1000,
      execute: vi.fn().mockResolvedValue({ passed: false, error: "mesh status timeout" }),
      now: () => 0,
      sleep: vi.fn(),
      record: vi.fn()
    });
    expect(result).toMatchObject({ passed: false, samples: 1, failures: 1, error: "mesh status timeout" });
  });
});
