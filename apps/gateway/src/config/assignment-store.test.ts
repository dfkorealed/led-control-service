import { mkdtemp, readdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AssignmentStore } from "./assignment-store";

const assignment = {
  siteId: "site-1",
  gatewayId: "gateway-1",
  serialNumber: "GW-001",
  mqttUrl: "mqtts://broker.example:8883",
  configVersion: 1
};

describe("AssignmentStore", () => {
  it("writes an assignment atomically with owner-only permissions", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-assignment-"));
    const path = join(directory, "assignment.json");
    const store = new AssignmentStore(path);

    await store.writeAtomic(assignment);

    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await store.read()).toEqual(assignment);
    expect(await readdir(directory)).toEqual(["assignment.json"]);
  });

  it("returns null when no assignment has been stored", async () => {
    const directory = await mkdtemp(join(tmpdir(), "gateway-assignment-empty-"));
    expect(await new AssignmentStore(join(directory, "missing.json")).read()).toBeNull();
  });
});
