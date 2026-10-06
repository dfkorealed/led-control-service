import { describe, expect, it } from "vitest";
import { resolveFixtureHit, type FixtureHitCandidate } from "./editor-fixture-hit-test";

const fixture = (id: string, x: number, y: number, size = 20): FixtureHitCandidate => ({ id, x, y, size, strokeWidth: 1 });
const dense = [fixture("one", 20, 20), fixture("two", 49, 20), fixture("forty-one", 20, 50), fixture("forty-two", 49, 50)];
describe("fixture pointer hit resolution", () => {
  it.each(dense)("prioritizes the actual body of $id at dense fitted zoom", target => {
    expect(resolveFixtureHit(dense, target, 0.38375)?.id).toBe(target.id);
  });
  it("prefers a visible body over a closer padded-only candidate", () => {
    expect(resolveFixtureHit([fixture("body", 0, 0, 60), fixture("padding", 40, 0, 2)], { x: 29, y: 0 }, 0.5)?.id).toBe("body");
  });
  it("keeps the full 22px padded radius and rejects a point beyond it", () => {
    expect(resolveFixtureHit([dense[0]], { x: 64, y: 20 }, 0.5)?.id).toBe("one");
    expect(resolveFixtureHit([dense[0]], { x: 64.01, y: 20 }, 0.5)).toBeNull();
  });
  it("uses closest screen distance and the last paint order for an exact tie", () => {
    expect(resolveFixtureHit(dense, { x: 68, y: 20 }, 0.38375)?.id).toBe("two");
    expect(resolveFixtureHit(dense, { x: 34.5, y: 20 }, 0.38375)?.id).toBe("two");
    expect(resolveFixtureHit([fixture("bottom", 20, 20), fixture("top", 20, 20)], { x: 20, y: 20 }, 1)?.id).toBe("top");
  });
  it.each([0, -1, NaN, Infinity])("fails closed for invalid zoom %s", zoom => {
    expect(resolveFixtureHit(dense, { x: 20, y: 20 }, zoom)).toBeNull();
  });
  it("ignores malformed candidates and nonfinite input positions", () => {
    expect(resolveFixtureHit([fixture("invalid", NaN, 20), dense[0]], { x: 20, y: 20 }, 1)?.id).toBe("one");
    expect(resolveFixtureHit(dense, { x: Infinity, y: 20 }, 1)).toBeNull();
  });
});
