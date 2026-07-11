import { describe, expect, it, vi } from "vitest";
import { HIL_STEP_NAMES, runHilScenario } from "./hil-2node-test";

describe("2-node HIL scenario", () => {
  it("runs every production gate in a deterministic order", async () => {
    const executor = vi.fn(async (name: string) => ({ passed: true, evidence: { name } }));
    const result = await runHilScenario(executor);

    expect(result.steps.map((step) => step.name)).toEqual(HIL_STEP_NAMES);
    expect(result.passed).toBe(true);
    expect(executor).toHaveBeenCalledTimes(HIL_STEP_NAMES.length);
  });

  it("redacts secret-shaped evidence fields", async () => {
    const result = await runHilScenario(async () => ({
      passed: true,
      evidence: { commandId: "safe", claimCode: "secret", nested: { accessToken: "secret" } }
    }));
    expect(result.steps[0].evidence).toEqual({ commandId: "safe", claimCode: "[REDACTED]", nested: { accessToken: "[REDACTED]" } });
  });
});
