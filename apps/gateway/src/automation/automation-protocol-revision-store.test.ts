import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { it, expect } from "vitest";
import { AutomationProtocolRevisionStore } from "./automation-protocol-revision-store";
import { automationScope } from "./automation-test-fixtures";

it("retains monotonic declaration ordering across concurrent calls, failures and restart", async () => {
  const directory = await mkdtemp(join(tmpdir(), "automation-protocol-revision-"));
  try {
    const path = join(directory, "revision.json");
    const first = new AutomationProtocolRevisionStore(path, automationScope);
    expect(await Promise.all([first.next(), first.next()])).toEqual([1, 2]);
    const failing = new AutomationProtocolRevisionStore(path, automationScope, async () => { throw new Error("fsync failed"); });
    await expect(failing.next()).rejects.toThrow("fsync failed");
    const restarted = new AutomationProtocolRevisionStore(path, automationScope);
    expect(await restarted.next()).toBe(3);
    await expect(new AutomationProtocolRevisionStore(path, { ...automationScope, siteId: automationScope.gatewayId }).next())
      .rejects.toThrow("protocol revision scope");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
