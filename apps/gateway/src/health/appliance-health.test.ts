import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ApplianceHealth } from "./appliance-health";

it("records unassigned and probe-derived appliance states atomically", async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "gateway-health-")), "health.json");
  let dbusOwner = true;
  const health = new ApplianceHealth(file, {
    now: () => new Date("2026-07-13T00:00:00.000Z"),
    heartbeatMs: 5_000,
    probes: {
      dbusOwner: async () => dbusOwner,
      bluezAttached: async () => true,
      hciPowered: async () => true,
      mappingValid: async () => true
    }
  });
  await health.startingUnassigned();
  await expect(health.read()).resolves.toMatchObject({ status: "starting-unassigned", assignment: false, mqtt: false });
  await health.startingAssigned();
  await health.mqttConnected();
  await health.heartbeatPublished();
  await expect(health.read()).resolves.toMatchObject({
    status: "healthy",
    assignment: true,
    mesh: true,
    mqtt: true,
    mapping: true,
    dbusOwner: true,
    bluezAttached: true,
    hciPowered: true,
    mappingValid: true,
    heartbeatFresh: true,
    lastHeartbeatPublishedAt: "2026-07-13T00:00:00.000Z"
  });

  dbusOwner = false;
  await health.refresh();
  await expect(health.read()).resolves.toMatchObject({
    status: "unhealthy",
    mesh: false,
    dbusOwner: false,
    reason: "dbus_owner_missing"
  });
});
