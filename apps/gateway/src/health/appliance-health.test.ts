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

it("keeps HCI power out of the non-root application health state", async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "gateway-health-")), "health.json");
  const health = new ApplianceHealth(file, {
    now: () => new Date("2026-08-30T00:00:00.000Z"),
    probes: {
      dbusOwner: async () => true,
      bluezAttached: async () => true,
      mappingValid: async () => true
    }
  });

  await health.startingAssigned();
  await health.heartbeatPublished();

  await expect(health.read()).resolves.toMatchObject({
    status: "healthy",
    mesh: true
  });
  await expect(health.read()).resolves.not.toHaveProperty("hciPowered");
});

it("keeps a state outbox capacity blocker sticky across heartbeats until explicitly cleared", async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "gateway-health-")), "health.json");
  const health = new ApplianceHealth(file, {
    now: () => new Date("2026-08-26T00:00:00.000Z"),
    heartbeatMs: 5_000,
    probes: {
      dbusOwner: async () => true,
      bluezAttached: async () => true,
      mappingValid: async () => true
    }
  });
  await health.startingAssigned();
  await health.mqttConnected();
  await health.heartbeatPublished();

  await health.setOperationalBlocker("state_outbox_capacity", true);
  await health.unhealthy("mqtt_error");
  await expect(health.read()).resolves.toMatchObject({ status: "unhealthy", reason: "state_outbox_capacity" });
  await health.heartbeatPublished();
  await expect(health.read()).resolves.toMatchObject({ status: "unhealthy", reason: "state_outbox_capacity" });

  await health.setOperationalBlocker("state_outbox_capacity", false);
  await health.heartbeatPublished();
  await expect(health.read()).resolves.toMatchObject({ status: "healthy" });
});

it("fails closed when the last successful heartbeat timestamp is in the future", async () => {
  let now = new Date("2026-07-13T00:00:10.000Z");
  const file = path.join(await mkdtemp(path.join(tmpdir(), "gateway-health-")), "health.json");
  const health = new ApplianceHealth(file, {
    now: () => now,
    probes: {
      dbusOwner: async () => true,
      bluezAttached: async () => true,
      mappingValid: async () => true
    }
  });
  await health.startingAssigned();
  await health.heartbeatPublished();
  now = new Date("2026-07-13T00:00:09.000Z");
  await health.refresh();

  await expect(health.read()).resolves.toMatchObject({ status: "unhealthy", heartbeatFresh: false, reason: "heartbeat_stale" });
});

it.each([
  [{ total: 3, configured: 0, observed: 0, healthPending: 0, timedOut: 0, failed: 3 }, "mesh_resync_all_failed"],
  [{ total: 3, configured: 3, observed: 0, healthPending: 0, timedOut: 3, failed: 0 }, "mesh_resync_all_timed_out"]
])("keeps an all-unobserved resync unhealthy after later successful heartbeats", async (report, reason) => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "gateway-health-")), "health.json");
  const health = new ApplianceHealth(file, {
    now: () => new Date("2026-08-11T00:00:00.000Z"),
    probes: {
      dbusOwner: async () => true,
      bluezAttached: async () => true,
      mappingValid: async () => true
    }
  });

  await health.startingAssigned();
  await health.heartbeatPublished();
  await health.recordMeshResync(report);
  await health.heartbeatPublished();

  await expect(health.read()).resolves.toMatchObject({
    status: "unhealthy",
    mqtt: true,
    heartbeatFresh: true,
    reason
  });
});

it("records a healthy lighting resync while late Health Current clears its pending count", async () => {
  const file = path.join(await mkdtemp(path.join(tmpdir(), "gateway-health-")), "health.json");
  const health = new ApplianceHealth(file, {
    now: () => new Date("2026-08-11T00:00:00.000Z"),
    probes: {
      dbusOwner: async () => true,
      bluezAttached: async () => true,
      mappingValid: async () => true
    }
  });
  const report = { total: 1, configured: 1, observed: 1, healthPending: 1, timedOut: 0, failed: 0 };

  await health.startingAssigned();
  await health.heartbeatPublished();
  await health.recordMeshResync(report);
  await expect(health.read()).resolves.toMatchObject({ status: "healthy", meshResync: { healthPending: 1 } });
  await health.recordMeshResync({ ...report, healthPending: 0 });

  await expect(health.read()).resolves.toMatchObject({ status: "healthy", meshResync: { healthPending: 0 } });
});

it.each(["0", "-1", "NaN", "Infinity", "1.5"])('rejects invalid heartbeat interval %s', (heartbeatMs) => {
  expect(() => new ApplianceHealth("/tmp/health.json", { heartbeatMs: Number(heartbeatMs) })).toThrow("heartbeat interval");
});
