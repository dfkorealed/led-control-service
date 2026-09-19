import { describe, expect, it, vi } from "vitest";
import { CadSceneMemoryBudget } from "./cad-scene-memory-budget";

describe("CadSceneMemoryBudget", () => {
  it("evicts least-recently-used unpinned allocations across owners", () => {
    const evicted = vi.fn();
    const budget = new CadSceneMemoryBudget(100);
    expect(budget.reserve("editor", "raw:a", 60, evicted)).toBe(true);
    expect(budget.reserve("renderer", "gpu:a", 30, evicted)).toBe(true);
    budget.touch("editor", "raw:a");
    expect(budget.reserve("editor", "moved:a", 40, evicted)).toBe(true);
    expect(evicted).toHaveBeenCalledWith("gpu:a");
    expect(budget.totalBytes).toBe(100);
  });

  it("refuses an allocation when only pinned resources remain and releases an owner", () => {
    const budget = new CadSceneMemoryBudget(100);
    expect(budget.reserve("renderer", "cpu:a", 80)).toBe(true);
    budget.setPinned("renderer", "cpu:a", true);
    expect(budget.reserve("editor", "moved:a", 30)).toBe(false);
    expect(budget.totalBytes).toBe(80);
    budget.releaseOwner("renderer");
    expect(budget.totalBytes).toBe(0);
  });
});
