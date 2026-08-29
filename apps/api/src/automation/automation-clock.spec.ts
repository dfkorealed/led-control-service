import { AutomationClock } from "./automation-clock";

describe("AutomationClock", () => {
  it("returns the current system time by default", () => {
    const before = Date.now();
    const now = new AutomationClock().now().getTime();
    const after = Date.now();

    expect(now).toBeGreaterThanOrEqual(before);
    expect(now).toBeLessThanOrEqual(after);
  });
});
